/**
 * GitHub API layer — REST + GraphQL.
 * Runs server-side only (Vite middleware).
 */

import { env } from './env.ts'

/* ── Types ───────────────────────────────────────────────────────── */

export interface GHSearchItem {
  number: number
  title: string
  html_url: string
  body: string
  draft: boolean
  repository_url: string
}

export interface GHPRDetail {
  number: number
  title: string
  html_url: string
  body: string
  mergeable_state: string
  mergeable: boolean | null
  draft: boolean
  merged_at: string | null
  base: { ref: string }
  head: { ref: string }
}

export interface ReviewInfo {
  reviewDecision: string | null
  latestReviews: { state: string; author: string }[]
}

/* ── Helpers ─────────────────────────────────────────────────────── */

async function ghRest<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.githubToken}`,
      Accept: 'application/vnd.github+json',
    },
  })
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${url}`)
  return res.json() as Promise<T>
}

async function ghGraphQL<T>(query: string): Promise<T> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.githubToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`)
  const json = (await res.json()) as {
    data?: T
    errors?: { message: string }[]
  }
  if (json.errors?.length) {
    console.warn('[github] GraphQL errors:', json.errors)
  }
  if (!json.data) throw new Error('GitHub GraphQL: missing data field')
  return json.data
}

/* ── Public API ──────────────────────────────────────────────────── */

export function repoFromUrl(repositoryUrl: string): {
  owner: string
  repo: string
} {
  const parts = repositoryUrl
    .replace('https://api.github.com/repos/', '')
    .split('/')
  return { owner: parts[0], repo: parts[1] }
}

export async function fetchOpenPRs(): Promise<GHSearchItem[]> {
  const q = encodeURIComponent(`is:pr is:open author:${env.githubUsername}`)
  const data = await ghRest<{ items: GHSearchItem[] }>(
    `https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=50`,
  )
  return data.items
}

/**
 * PRs authored by the user that were updated on or after `sinceDate` (YYYY-MM-DD).
 */
export async function fetchPRsUpdatedSince(
  sinceDate: string,
): Promise<GHSearchItem[]> {
  const q = encodeURIComponent(
    `is:pr author:${env.githubUsername} updated:>=${sinceDate}`,
  )
  const data = await ghRest<{ items: GHSearchItem[] }>(
    `https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=50`,
  )
  return data.items
}

/**
 * PRs authored by the user that were merged on a given day.
 */
export async function fetchPRsMergedOn(date: string): Promise<GHSearchItem[]> {
  const q = encodeURIComponent(
    `is:pr is:merged author:${env.githubUsername} merged:${date}`,
  )
  const data = await ghRest<{ items: GHSearchItem[] }>(
    `https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=30`,
  )
  return data.items
}

export async function fetchPRDetail(
  owner: string,
  repo: string,
  number: number,
): Promise<GHPRDetail> {
  return ghRest<GHPRDetail>(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
  )
}

export async function fetchReviewsBatch(
  prs: { owner: string; repo: string; number: number }[],
): Promise<Map<string, ReviewInfo>> {
  if (prs.length === 0) return new Map()

  const fragments = prs.map(
    (pr, i) =>
      `pr${i}: repository(owner:"${pr.owner}", name:"${pr.repo}") {
        pullRequest(number:${pr.number}) {
          reviewDecision
          latestReviews(last:5) { nodes { state author { login } } }
        }
      }`,
  )

  const data = await ghGraphQL<
    Record<
      string,
      {
        pullRequest?: {
          reviewDecision: string | null
          latestReviews?: {
            nodes: { state: string; author: { login: string } }[]
          }
        }
      }
    >
  >(`{ ${fragments.join('\n')} }`)

  const result = new Map<string, ReviewInfo>()
  for (let i = 0; i < prs.length; i++) {
    const pr = data[`pr${i}`]?.pullRequest
    if (!pr) continue
    result.set(`${prs[i].repo}#${prs[i].number}`, {
      reviewDecision: pr.reviewDecision,
      latestReviews: (pr.latestReviews?.nodes ?? []).map((r) => ({
        state: r.state,
        author: r.author.login,
      })),
    })
  }
  return result
}

export async function fetchGitSpiceStacks(
  prs: { owner: string; repo: string; number: number }[],
): Promise<Map<string, number[]>> {
  if (prs.length === 0) return new Map()

  const fragments = prs.map(
    (pr, i) =>
      `pr${i}: repository(owner:"${pr.owner}", name:"${pr.repo}") {
        issueOrPullRequest(number:${pr.number}) {
          ... on PullRequest { comments(last:10) { nodes { body } } }
        }
      }`,
  )

  const data = await ghGraphQL<
    Record<
      string,
      {
        issueOrPullRequest?: { comments?: { nodes: { body: string }[] } }
      }
    >
  >(`{ ${fragments.join('\n')} }`)

  const result = new Map<string, number[]>()
  for (let i = 0; i < prs.length; i++) {
    const comments = data[`pr${i}`]?.issueOrPullRequest?.comments?.nodes ?? []
    const gsComment = comments.find(
      (c) => c.body.includes('gs:navigation') || c.body.includes('git-spice'),
    )
    if (!gsComment) continue

    const nums = [...gsComment.body.matchAll(/#(\d+)/g)].map((m) =>
      Number(m[1]),
    )
    if (nums.length > 0) {
      result.set(`${prs[i].repo}#${prs[i].number}`, nums)
    }
  }
  return result
}

export async function fetchMergedPR(
  owner: string,
  repo: string,
  number: number,
): Promise<GHPRDetail | null> {
  const detail = await fetchPRDetail(owner, repo, number).catch(() => null)
  return detail?.merged_at ? detail : null
}
