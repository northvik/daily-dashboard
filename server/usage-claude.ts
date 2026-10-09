/**
 * Claude Code usage (AI_PROVIDER=claude) — aggregates token usage from local
 * session logs for the current calendar month and prices it at API list
 * rates. Subscription plans are not billed per token, so costs are an
 * API-equivalent estimate. Zero LLM tokens, zero API calls.
 */

import { loadSessions } from './claude-sessions.ts'
import type {
  ConversationCost,
  CycleInfo,
  ModelUsage,
  RequestEvent,
  UsageSummary,
} from './usage.ts'

function currentMonth(): { startMs: number; endMs: number } {
  const now = new Date()
  return {
    startMs: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
    endMs: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(),
  }
}

export async function fetchClaudeUsage(): Promise<UsageSummary | null> {
  const { startMs, endMs } = currentMonth()
  const modelMap = new Map<string, ModelUsage>()
  const conversations: ConversationCost[] = []
  const allEvents: RequestEvent[] = []

  for (const session of loadSessions().values()) {
    const events = session.requests
      .filter((r) => r.ts >= startMs && r.ts < endMs)
      .sort((a, b) => a.ts - b.ts)
    if (events.length === 0) continue

    let costCents = 0
    for (const ev of events) {
      costCents += ev.cents
      allEvents.push(ev)
      const m = modelMap.get(ev.model) ?? {
        model: ev.model,
        cents: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      }
      m.cents += ev.cents
      m.inputTokens += ev.inputTokens
      m.outputTokens += ev.outputTokens
      m.cacheWriteTokens += ev.cacheWriteTokens
      m.cacheReadTokens += ev.cacheReadTokens
      modelMap.set(ev.model, m)
    }

    conversations.push({
      id: session.id,
      costCents,
      requestCount: events.length,
      lastEventAt: events[events.length - 1].ts,
      events,
    })
  }

  const totalCents = allEvents.reduce((s, e) => s + e.cents, 0)
  const cycle: CycleInfo = {
    startMs,
    endMs,
    // No billed cycle — the estimate fills "included" so totals still add up
    includedCents: totalCents,
    limitCents: 0,
    bonusCents: 0,
    percentUsed: 0,
    onDemandCents: 0,
    teamPoolCents: 0,
  }

  return {
    provider: 'claude',
    cycle,
    models: [...modelMap.values()].sort((a, b) => b.cents - a.cents),
    conversations: conversations.sort((a, b) => b.lastEventAt - a.lastEventAt),
    allEvents,
    fetchedAt: new Date().toISOString(),
  }
}
