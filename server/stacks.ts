/**
 * Stack detection — grouping, depth computation, ticket extraction.
 * Runs server-side only.
 */

import type { GHPRDetail, ReviewInfo } from './github.ts'
import { linearIssueUrl } from './env.ts'

/* ── Types (server-side mirror of client types) ──────────────────── */

export type PRStatus =
  | 'ready'
  | 'rebase'
  | 'ci-fail'
  | 'review'
  | 'changes-requested'
  | 'approved'
  | 'commented'
  | 'draft'

export interface PR {
  repo: string
  number: number
  title: string
  url: string
  ticket?: string
  ticketUrl?: string
  description: string
  base: string
  merged?: boolean
  status?: PRStatus
  depth: number
  /** ISO timestamp — freshest open-PR activity drives group order */
  updatedAt?: string
}

export interface TicketInfo {
  id: string
  title: string
  url: string
  status: string
  priority: string
  priorityOrder: number
  project?: string
  labels?: string[]
}

export interface ConversationRef {
  id: string
  title: string
  updatedAt: string
}

export interface PRGroup {
  name: string
  description: string
  prs: PR[]
  ticket?: TicketInfo
  crossRepo?: boolean
  conversations?: ConversationRef[]
}

/* ── Constants ───────────────────────────────────────────────────── */

export const TRUNK_BRANCHES = new Set(['main', 'master', 'develop', 'staging'])

const PRIORITY_ORDER: Record<string, number> = {
  Urgent: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  'No priority': 4,
}

/* ── Parsing helpers ─────────────────────────────────────────────── */

/** Strip conventional-commit prefix from PR title. */
export function cleanTitle(title: string): string {
  return title.replace(/^(feat|fix|chore|ci|docs)\([^)]+\):\s*/, '').trim()
}

/** Extract Linear ticket ID + URL from a PR title/body. */
export function extractTicket(
  title: string,
  body: string,
): { ticket: string; ticketUrl: string } | undefined {
  const match = title.match(/\(([A-Z]+-\d+)\)/)
  if (!match) return undefined
  const ticket = match[1]
  const urlMatch = body?.match(
    new RegExp(
      `https://linear\\.app/[^\\s)]*${ticket.replace('-', '[-/]')}[^\\s)]*`,
    ),
  )
  return {
    ticket,
    ticketUrl: urlMatch?.[0] ?? linearIssueUrl(ticket),
  }
}

/** Parse "Stacked on #NNN" from a PR body → parent PR number. */
export function extractBaseRef(body: string): string | undefined {
  const m = body?.match(
    /[Ss]tacked on #(\d+)|[Dd]epends on.*#(\d+)|[Bb]ase.*#(\d+)/,
  )
  return m ? `#${m[1] || m[2] || m[3]}` : undefined
}

/** All PR numbers referenced as stack parents in the body. */
export function extractStackedOnRefs(body: string): number[] {
  const refs = new Set<number>()
  for (const pattern of [
    /[Ss]tacked on #(\d+)/g,
    /[Dd]epends on.*?#(\d+)/g,
    /[Bb]locked by.*?#(\d+)/g,
  ]) {
    let m
    while ((m = pattern.exec(body)) !== null) refs.add(Number(m[1]))
  }
  for (const m of body.matchAll(/→\s*#(\d+)/g)) refs.add(Number(m[1]))
  return [...refs]
}

/** First meaningful sentence from a PR body (skipping headings/comments). */
export function extractFirstSentence(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (
      !t ||
      t.startsWith('#') ||
      t.startsWith('<!--') ||
      t.startsWith('>') ||
      t.startsWith('**Ticket')
    ) {
      continue
    }
    const clean = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    if (clean.length > 10)
      return clean.slice(0, 120) + (clean.length > 120 ? '…' : '')
  }
  return ''
}

/* ── Status derivation ───────────────────────────────────────────── */

export function deriveStatus(
  detail: GHPRDetail,
  isDraft: boolean,
  reviewInfo?: ReviewInfo,
): PRStatus {
  if (isDraft) return 'draft'

  if (reviewInfo) {
    if (reviewInfo.latestReviews.some((r) => r.state === 'CHANGES_REQUESTED'))
      return 'changes-requested'
    if (reviewInfo.reviewDecision === 'APPROVED') return 'approved'
    if (reviewInfo.latestReviews.some((r) => r.state === 'COMMENTED'))
      return 'commented'
  }

  if (detail.mergeable_state === 'behind') return 'rebase'
  if (
    detail.mergeable_state === 'unstable' ||
    detail.mergeable_state === 'blocked'
  )
    return 'ci-fail'
  if (detail.mergeable_state === 'clean' && detail.mergeable) return 'ready'
  return 'review'
}

/* ── Depth computation ───────────────────────────────────────────── */

export function computeDepths(prs: PR[], headRefs: Map<string, string>): void {
  const byKey = new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]))
  const branchToKey = new Map<string, string>()
  for (const [prKey, headRef] of headRefs) branchToKey.set(headRef, prKey)

  function findParent(pr: PR): PR | undefined {
    const numMatch = pr.base.match(/^#(\d+)$/)
    if (numMatch) return byKey.get(`${pr.repo}#${numMatch[1]}`)
    if (!TRUNK_BRANCHES.has(pr.base)) {
      const parentKey = branchToKey.get(pr.base)
      if (parentKey) return byKey.get(parentKey)
    }
    return undefined
  }

  function getDepth(pr: PR, visited: Set<string>): number {
    const key = `${pr.repo}#${pr.number}`
    if (visited.has(key)) return 0
    visited.add(key)
    const parent = findParent(pr)
    return parent ? getDepth(parent, visited) + 1 : 0
  }

  for (const pr of prs) pr.depth = getDepth(pr, new Set())
}

/* ── Group building ──────────────────────────────────────────────── */

export interface SummaryOverride {
  ticket: string
  name: string
  description: string
  cachedAt?: number
}

export function buildGroups(
  prs: PR[],
  headRefs: Map<string, string>,
  overrides: SummaryOverride[],
): PRGroup[] {
  const byKey = new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]))
  const branchToKey = new Map<string, string>()
  for (const [prKey, headRef] of headRefs) branchToKey.set(headRef, prKey)

  // Build parent→child graph
  const childOf = new Map<string, string>()
  for (const pr of prs) {
    const key = `${pr.repo}#${pr.number}`
    const numMatch = pr.base.match(/^#(\d+)$/)
    if (numMatch) {
      const parentKey = `${pr.repo}#${numMatch[1]}`
      if (byKey.has(parentKey)) {
        childOf.set(key, parentKey)
        continue
      }
    }
    if (!TRUNK_BRANCHES.has(pr.base)) {
      const parentKey = branchToKey.get(pr.base)
      if (parentKey && byKey.has(parentKey)) childOf.set(key, parentKey)
    }
  }

  // Connected components via parent chains
  function findRoot(key: string): string {
    const parent = childOf.get(key)
    return parent ? findRoot(parent) : key
  }

  const grouped = new Map<string, Set<string>>()
  for (const pr of prs) {
    const key = `${pr.repo}#${pr.number}`
    const root = findRoot(key)
    if (!grouped.has(root)) grouped.set(root, new Set())
    grouped.get(root)!.add(key)
  }

  // Merge groups sharing a ticket
  const ticketGroups = new Map<string, Set<string>>()
  const assigned = new Set<string>()

  for (const [, members] of grouped) {
    const memberPRs = [...members].map((k) => byKey.get(k)!)
    const ticket = memberPRs.find((p) => p.ticket)?.ticket
    if (ticket) {
      if (!ticketGroups.has(ticket)) ticketGroups.set(ticket, new Set())
      for (const k of members) {
        ticketGroups.get(ticket)!.add(k)
        assigned.add(k)
      }
    } else if (members.size > 1) {
      const groupId = `_stack_${[...members][0]}`
      ticketGroups.set(groupId, members)
      for (const k of members) assigned.add(k)
    }
  }

  // Remaining unassigned PRs
  for (const pr of prs) {
    const key = `${pr.repo}#${pr.number}`
    if (assigned.has(key) || pr.merged) continue
    if (pr.ticket) {
      if (!ticketGroups.has(pr.ticket)) ticketGroups.set(pr.ticket, new Set())
      ticketGroups.get(pr.ticket)!.add(key)
    } else {
      ticketGroups.set(`_solo_${key}`, new Set([key]))
    }
  }

  // Build output
  const overrideMap = new Map(overrides.map((o) => [o.ticket, o]))
  const groups: PRGroup[] = []

  for (const [ticket, memberKeys] of ticketGroups) {
    const memberPRs = [...memberKeys].map((k) => byKey.get(k)!).filter(Boolean)
    if (memberPRs.length === 0) continue

    const override = overrideMap.get(ticket)
    const displayTicket = ticket.startsWith('_') ? undefined : ticket
    const openPRs = memberPRs.filter((p) => !p.merged)

    let desc = override?.description ?? ''
    if (!desc && openPRs.length === 1 && openPRs[0].description) {
      desc = openPRs[0].description
    } else if (!desc && openPRs.length > 1) {
      desc = openPRs.map((p) => p.title).join(' · ')
    }

    groups.push({
      name: override?.name ?? displayTicket ?? memberPRs[0].title,
      description: desc,
      prs: memberPRs,
      crossRepo: new Set(memberPRs.map((p) => p.repo)).size > 1,
    })
  }

  return groups
}

/* ── Ticket attachment + sorting ─────────────────────────────────── */

export interface LinearTicketInput {
  identifier: string
  title: string
  url: string
  priorityLabel: string
  state: { name: string }
  project?: { name: string } | null
  labels: { nodes: { name: string }[] }
}

/** Freshest open PR activity in the group (ms), or 0 if unknown. */
export function groupFreshnessMs(group: PRGroup): number {
  const open = group.prs.filter((p) => !p.merged && p.updatedAt)
  const pool = open.length ? open : group.prs.filter((p) => p.updatedAt)
  let max = 0
  for (const p of pool) {
    const t = Date.parse(p.updatedAt!)
    if (!Number.isNaN(t) && t > max) max = t
  }
  return max
}

/**
 * Attach Linear ticket info to PR groups. Tickets with no PRs are returned
 * separately (not mixed into the stacks list). Groups sort by PR freshness.
 */
export function attachTicketsAndSort(
  groups: PRGroup[],
  linearIssues: LinearTicketInput[],
): TicketInfo[] {
  const ticketMap = new Map<string, TicketInfo>()
  for (const issue of linearIssues) {
    ticketMap.set(issue.identifier, {
      id: issue.identifier,
      title: issue.title,
      url: issue.url,
      status: issue.state.name,
      priority: issue.priorityLabel,
      priorityOrder: PRIORITY_ORDER[issue.priorityLabel] ?? 4,
      project: issue.project?.name ?? undefined,
      labels: issue.labels.nodes.map((l) => l.name),
    })
  }

  const linkedTickets = new Set<string>()
  for (const group of groups) {
    const ticket = group.prs.find((p) => p.ticket)?.ticket
    if (ticket) {
      linkedTickets.add(ticket)
      group.ticket = ticketMap.get(ticket)
    }
  }

  const orphans: TicketInfo[] = []
  for (const [id, info] of ticketMap) {
    if (!linkedTickets.has(id)) orphans.push(info)
  }
  orphans.sort(
    (a, b) =>
      a.priorityOrder - b.priorityOrder || a.title.localeCompare(b.title),
  )

  groups.sort((a, b) => {
    const fa = groupFreshnessMs(a)
    const fb = groupFreshnessMs(b)
    if (fa !== fb) return fb - fa
    const pa = a.ticket?.priorityOrder ?? 4
    const pb = b.ticket?.priorityOrder ?? 4
    return pa !== pb ? pa - pb : a.name.localeCompare(b.name)
  })

  return orphans
}
