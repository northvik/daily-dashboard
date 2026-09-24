/**
 * Dashboard orchestrator — assembles data from GitHub, Linear, and summaries.
 * Returns JSON matching the client's DashboardData shape.
 */

import {
  fetchOpenPRs,
  fetchPRDetail,
  fetchReviewsBatch,
  fetchGitSpiceStacks,
  fetchMergedPR,
  repoFromUrl,
} from './github.ts'
import { fetchLinearIssues } from './linear.ts'
import {
  TRUNK_BRANCHES,
  cleanTitle,
  extractTicket,
  extractBaseRef,
  extractStackedOnRefs,
  extractFirstSentence,
  deriveStatus,
  computeDepths,
  buildGroups,
  attachTicketsAndSort,
  type PR,
  type SummaryOverride,
} from './stacks.ts'
import { enrichSummaries } from './summaries.ts'
import { env } from './env.ts'

export async function fetchDashboard() {
  const [ghItems, linearIssues] = await Promise.all([
    fetchOpenPRs(),
    fetchLinearIssues('started'),
  ])

  // Track owner per repo (for merged ancestor lookups)
  const repoOwners = new Map<string, string>()
  for (const item of ghItems) {
    const { owner, repo } = repoFromUrl(item.repository_url)
    repoOwners.set(repo, owner)
  }

  // Fetch PR details + review info in parallel
  const prBatch = ghItems.map((item) => {
    const { owner, repo } = repoFromUrl(item.repository_url)
    return { owner, repo, number: item.number }
  })

  const [detailResults, reviewMap, gsStacks] = await Promise.all([
    Promise.all(
      prBatch.map(async ({ owner, repo, number }) => {
        const detail = await fetchPRDetail(owner, repo, number).catch(
          () => null,
        )
        return { key: `${repo}#${number}`, detail }
      }),
    ),
    fetchReviewsBatch(prBatch).catch(() => new Map()),
    fetchGitSpiceStacks(prBatch).catch(() => new Map()),
  ])

  const detailMap = new Map(
    detailResults.filter((r) => r.detail).map((r) => [r.key, r.detail!]),
  )
  const headRefs = new Map(
    detailResults
      .filter((r) => r.detail)
      .map((r) => [r.key, r.detail!.head.ref]),
  )

  // Build PR objects
  const allPRs: PR[] = ghItems.map((item) => {
    const { repo } = repoFromUrl(item.repository_url)
    const key = `${repo}#${item.number}`
    const detail = detailMap.get(key)
    const reviewInfo = reviewMap.get(key)
    const ticketInfo = extractTicket(item.title, item.body ?? '')
    const baseRef =
      extractBaseRef(item.body ?? '') ?? detail?.base.ref ?? 'main'

    return {
      repo,
      number: item.number,
      title: cleanTitle(item.title),
      url: item.html_url,
      ...ticketInfo,
      description: extractFirstSentence(item.body ?? ''),
      base: baseRef,
      status: detail
        ? deriveStatus(detail, item.draft, reviewInfo)
        : item.draft
          ? 'draft'
          : 'review',
      depth: 0,
      updatedAt: item.updated_at || detail?.updated_at,
    }
  })

  // Resolve merged ancestors from git-spice comments + PR body refs
  const knownKeys = new Set(allPRs.map((p) => `${p.repo}#${p.number}`))
  const mergedToFetch = new Map<
    string,
    { owner: string; repo: string; num: number }
  >()

  for (const [key, stackNums] of gsStacks) {
    const repo = key.split('#')[0]
    const owner = repoOwners.get(repo) ?? env.githubOrg
    if (!owner) continue
    for (const num of stackNums) {
      const prKey = `${repo}#${num}`
      if (!knownKeys.has(prKey)) mergedToFetch.set(prKey, { owner, repo, num })
    }
  }

  for (const item of ghItems) {
    const { owner, repo } = repoFromUrl(item.repository_url)
    for (const num of extractStackedOnRefs(item.body ?? '')) {
      const prKey = `${repo}#${num}`
      if (!knownKeys.has(prKey) && !mergedToFetch.has(prKey)) {
        mergedToFetch.set(prKey, { owner, repo, num })
      }
    }
  }

  const ancestors = await Promise.all(
    [...mergedToFetch.values()].map(async ({ owner, repo, num }) => {
      const detail = await fetchMergedPR(owner, repo, num)
      if (!detail) return null
      const ticketInfo = extractTicket(detail.title, detail.body ?? '')
      return {
        headRef: detail.head.ref,
        pr: {
          repo,
          number: detail.number,
          title: cleanTitle(detail.title),
          url: detail.html_url,
          ...ticketInfo,
          description: '',
          base: detail.base.ref,
          merged: true,
          status: undefined,
          depth: 0,
          updatedAt: detail.updated_at ?? detail.merged_at ?? undefined,
        } satisfies PR,
      }
    }),
  )

  for (const anc of ancestors) {
    if (!anc) continue
    const key = `${anc.pr.repo}#${anc.pr.number}`
    if (!knownKeys.has(key)) {
      allPRs.push(anc.pr)
      knownKeys.add(key)
      headRefs.set(key, anc.headRef)
    }
  }

  // Apply git-spice stack ordering: set base = "#parentNum"
  for (const [key, stackNums] of gsStacks) {
    const repo = key.split('#')[0]
    for (let i = 1; i < stackNums.length; i++) {
      const pr = allPRs.find(
        (p) => p.repo === repo && p.number === stackNums[i],
      )
      if (pr && (TRUNK_BRANCHES.has(pr.base) || !pr.base.startsWith('#'))) {
        pr.base = `#${stackNums[i - 1]}`
      }
    }
  }

  computeDepths(allPRs, headRefs)

  // Load cached stack summaries (data/ is gitignored)
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  let staticOverrides: SummaryOverride[] = []
  try {
    staticOverrides = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'data/stack-overrides.json'),
        'utf-8',
      ),
    )
  } catch {
    /* first run, no cache yet */
  }

  const groups = buildGroups(allPRs, headRefs, staticOverrides)

  // Enrich multi-PR groups with AI summaries
  const summaryInput = groups
    .filter((g) => g.prs.length >= 2)
    .map((g) => ({
      ticket: g.prs.find((p) => p.ticket)?.ticket ?? g.name,
      prs: g.prs.map((p) => `${p.repo}#${p.number}: ${p.title}`),
    }))

  const liveOverrides = await enrichSummaries(summaryInput).catch(
    () => [] as SummaryOverride[],
  )
  if (liveOverrides.length > 0) {
    const liveMap = new Map(liveOverrides.map((o) => [o.ticket, o]))
    for (const group of groups) {
      const ticket = group.prs.find((p) => p.ticket)?.ticket
      const override = ticket ? liveMap.get(ticket) : undefined
      if (override) {
        group.name = override.name
        group.description = override.description
      }
    }
  }

  const orphanTickets = attachTicketsAndSort(groups, linearIssues)

  // Link Cursor agent conversations to groups (local SQLite, zero tokens)
  try {
    const { findConversationsForGroups } = await import('./conversations.ts')
    const inputs = groups.map((g) => {
      const ticketIds = [
        g.ticket?.id,
        ...g.prs.map((p) => p.ticket).filter(Boolean),
      ].filter((t): t is string => Boolean(t))
      const prNumbers = g.prs.map((p) => p.number)
      const branchNames = g.prs
        .map((p) => headRefs.get(`${p.repo}#${p.number}`))
        .filter((b): b is string => Boolean(b))
      return {
        key: g.ticket?.id ?? `${g.name}-${g.prs[0]?.number}`,
        ticketIds: [...new Set(ticketIds)],
        prNumbers,
        branchNames,
      }
    })
    const convMap = findConversationsForGroups(inputs)
    for (let i = 0; i < groups.length; i++) {
      const key = inputs[i].key
      const refs = convMap.get(key)
      if (refs?.length) groups[i].conversations = refs
    }
  } catch (err) {
    console.warn('[dashboard] Conversation lookup skipped:', err)
  }

  return { groups, orphanTickets, fetchedAt: new Date().toISOString() }
}
