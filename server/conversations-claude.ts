/**
 * Claude Code conversation lookup (AI_PROVIDER=claude) — matches local
 * sessions to PR groups by PR link, ticket ID, or git branch.
 *
 * Zero tokens, zero API calls.
 */

import { loadSessions, type ClaudeSession } from './claude-sessions.ts'
import type { ConversationRef, GroupSearchInput } from './conversations.ts'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Same tiers as the Cursor lookup, plus exact PR links that Claude Code
 * records when it opens a PR. Bare PR numbers in text are a weak signal
 * (they match years and unrelated ids), used only when nothing else hits.
 */
function search(
  sessions: ClaudeSession[],
  input: GroupSearchInput,
): ConversationRef[] {
  const hits = new Set<ClaudeSession>()
  const tickets = input.ticketIds.filter(Boolean)
  const ticketRes = tickets.map(
    (t) => new RegExp(`\\b${escapeRe(t.toLowerCase())}\\b`),
  )
  const slugs = tickets.map((t) => t.toLowerCase())
  const branches = input.branchNames.filter(Boolean)

  for (const s of sessions) {
    if (
      input.prRefs.some((r) => s.prRefs.includes(r)) ||
      ticketRes.some((re) => re.test(s.text)) ||
      s.branches.some(
        (b) =>
          slugs.some((slug) => b.toLowerCase().includes(slug)) ||
          branches.includes(b),
      )
    ) {
      hits.add(s)
    }
  }

  if (hits.size === 0) {
    const numRes = input.prNumbers.map((n) => new RegExp(`\\b${n}\\b`))
    for (const s of sessions) {
      if (numRes.some((re) => re.test(s.text))) hits.add(s)
    }
  }

  return [...hits]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: new Date(s.updatedAt).toISOString(),
    }))
}

export function findConversationsForGroups(
  inputs: GroupSearchInput[],
): Map<string, ConversationRef[]> {
  const sessions = [...loadSessions().values()]
  const result = new Map<string, ConversationRef[]>()
  for (const input of inputs) {
    const refs = search(sessions, input)
    if (refs.length > 0) result.set(input.key, refs)
  }
  return result
}

/** Batch look up conversation titles by ID. */
export function getConversationTitles(ids: string[]): Map<string, string> {
  const sessions = loadSessions()
  const result = new Map<string, string>()
  for (const id of ids) {
    const s = sessions.get(id)
    if (s) result.set(id, s.title)
  }
  return result
}
