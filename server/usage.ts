/**
 * Usage facade — billing / token usage and per-conversation cost from the
 * configured AI_PROVIDER (Claude Code session logs or Cursor billing API).
 */

import { env, type AiProvider } from './env.ts'

/* ── Types ───────────────────────────────────────────────────────── */

export interface CycleInfo {
  startMs: number
  endMs: number
  /** Included plan allowance used */
  includedCents: number
  /** Plan limit */
  limitCents: number
  /** Bonus from model providers (free) */
  bonusCents: number
  percentUsed: number
  /** On-demand overage spend */
  onDemandCents: number
  /** Team pool limit */
  teamPoolCents: number
}

export interface ModelUsage {
  model: string
  cents: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

export interface RequestEvent {
  ts: number
  model: string
  cents: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

export interface ConversationCost {
  id: string
  costCents: number
  requestCount: number
  lastEventAt: number
  events: RequestEvent[]
}

export interface UsageSummary {
  provider: AiProvider
  cycle: CycleInfo
  models: ModelUsage[]
  conversations: ConversationCost[]
  /** All events (including null/agent convId) for the daily chart */
  allEvents: RequestEvent[]
  fetchedAt: string
}

/* ── Public API ──────────────────────────────────────────────────── */

export async function fetchUsage(): Promise<UsageSummary | null> {
  if (env.aiProvider === 'cursor') {
    const { fetchCursorUsage } = await import('./usage-cursor.ts')
    return fetchCursorUsage()
  }
  const { fetchClaudeUsage } = await import('./usage-claude.ts')
  return fetchClaudeUsage()
}

/** Quick map of conversationId → costCents for PR chip annotation. */
export async function getConversationCosts(): Promise<Map<string, number>> {
  const data = await fetchUsage()
  if (!data) return new Map()
  return new Map(data.conversations.map((c) => [c.id, c.costCents]))
}
