/**
 * Cursor usage (AI_PROVIDER=cursor) — reads the local auth token from state.vscdb, fetches
 * billing cycle totals + per-conversation cost from api2.cursor.sh.
 * Cached 5 min. Zero LLM tokens.
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

import type {
  ConversationCost,
  CycleInfo,
  ModelUsage,
  RequestEvent,
  UsageSummary,
} from './usage.ts'

/* ── Auth token from state.vscdb ─────────────────────────────────── */

type Database = import('better-sqlite3').Database

const STATE_DB_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Cursor',
  'User',
  'globalStorage',
  'state.vscdb',
)

function getAccessToken(): string | null {
  try {
    const esmRequire = createRequire(import.meta.url)
    const Database = esmRequire(
      'better-sqlite3',
    ) as typeof import('better-sqlite3')
    const db: Database = new Database(STATE_DB_PATH, {
      readonly: true,
      fileMustExist: true,
    })
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'")
      .get() as { value: string } | undefined
    db.close()
    return row?.value ?? null
  } catch {
    return null
  }
}

/* ── API helpers ─────────────────────────────────────────────────── */

const API_BASE = 'https://api2.cursor.sh/aiserver.v1.DashboardService'

async function cursorPost<T>(endpoint: string, body: unknown): Promise<T> {
  const token = getAccessToken()
  if (!token) throw new Error('No Cursor access token')
  const res = await fetch(`${API_BASE}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Cursor API ${res.status}: ${endpoint}`)
  return res.json() as Promise<T>
}

/* ── Fetch & aggregate ───────────────────────────────────────────── */

interface PeriodUsageResponse {
  billingCycleStart: string
  billingCycleEnd: string
  planUsage: {
    totalSpend: number
    includedSpend: number
    bonusSpend: number
    limit: number
    totalPercentUsed: number
  }
  spendLimitUsage?: {
    individualUsed: number
    pooledLimit: string
  }
}

interface UsageEvent {
  timestamp: string
  model: string
  conversationId: string
  chargedCents: number
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    cacheWriteTokens?: number
    cacheReadTokens?: number
  }
}

async function fetchAllEvents(
  startMs: number,
  endMs: number,
): Promise<UsageEvent[]> {
  const all: UsageEvent[] = []
  let page = 1
  const pageSize = 500
  // ponytail: hard cap at 20 pages (~10k events) to bound request count
  while (page <= 20) {
    const data = await cursorPost<{
      usageEventsDisplay: UsageEvent[]
      totalUsageEventsCount: number
    }>('GetFilteredUsageEvents', {
      page,
      pageSize,
      startMs: String(startMs),
      endMs: String(endMs),
    })
    const events = data.usageEventsDisplay ?? []
    all.push(...events)
    if (events.length < pageSize) break
    page++
  }
  return all
}

async function buildUsageSummary(): Promise<UsageSummary> {
  const period = await cursorPost<PeriodUsageResponse>(
    'GetCurrentPeriodUsage',
    {},
  )
  const cycle: CycleInfo = {
    startMs: Number(period.billingCycleStart),
    endMs: Number(period.billingCycleEnd),
    includedCents: period.planUsage.includedSpend,
    limitCents: period.planUsage.limit,
    bonusCents: period.planUsage.bonusSpend ?? 0,
    percentUsed: period.planUsage.totalPercentUsed,
    onDemandCents: period.spendLimitUsage?.individualUsed ?? 0,
    teamPoolCents: Number(period.spendLimitUsage?.pooledLimit ?? 0),
  }

  const events = await fetchAllEvents(cycle.startMs, cycle.endMs)

  // Aggregate by model from actual events (covers on-demand + included)
  const modelMap = new Map<
    string,
    {
      cents: number
      inputTokens: number
      outputTokens: number
      cacheWriteTokens: number
      cacheReadTokens: number
    }
  >()
  const convMap = new Map<
    string,
    {
      costCents: number
      requestCount: number
      lastEventAt: number
      events: RequestEvent[]
    }
  >()
  const allEvents: RequestEvent[] = []

  for (const ev of events) {
    const model = ev.model || 'unknown'
    const tok = ev.tokenUsage
    const inTok = tok?.inputTokens ?? 0
    const outTok = tok?.outputTokens ?? 0
    const cwTok = tok?.cacheWriteTokens ?? 0
    const crTok = tok?.cacheReadTokens ?? 0
    const ts = Number(ev.timestamp)
    const cents = ev.chargedCents ?? 0

    const reqEv: RequestEvent = {
      ts,
      model,
      cents,
      inputTokens: inTok,
      outputTokens: outTok,
      cacheWriteTokens: cwTok,
      cacheReadTokens: crTok,
    }

    // Flat list for the daily chart (all events, no filtering)
    allEvents.push(reqEv)

    // Model aggregation
    const me = modelMap.get(model) ?? {
      cents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    }
    me.cents += cents
    me.inputTokens += inTok
    me.outputTokens += outTok
    me.cacheWriteTokens += cwTok
    me.cacheReadTokens += crTok
    modelMap.set(model, me)

    // Conversation aggregation — skip null and Task subagents (agent-xxx)
    const cid = ev.conversationId
    if (!cid || cid === 'null' || cid.startsWith('agent-')) continue
    const ce = convMap.get(cid) ?? {
      costCents: 0,
      requestCount: 0,
      lastEventAt: 0,
      events: [],
    }
    ce.costCents += cents
    ce.requestCount += 1
    if (ts > ce.lastEventAt) ce.lastEventAt = ts
    ce.events.push(reqEv)
    convMap.set(cid, ce)
  }

  const models: ModelUsage[] = [...modelMap.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.cents - a.cents)

  const conversations: ConversationCost[] = [...convMap.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.lastEventAt - a.lastEventAt)

  return {
    provider: 'cursor',
    cycle,
    models,
    conversations,
    allEvents,
    fetchedAt: new Date().toISOString(),
  }
}

/* ── Cache ────────────────────────────────────────────────────────── */

const CACHE_PATH = join(process.cwd(), 'data', 'usage-cache-cursor.json')
const TTL_MS = 5 * 60 * 1000

let _inFlight: Promise<UsageSummary | null> | null = null

function readCache(): UsageSummary | null {
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as UsageSummary
    if (Date.now() - Date.parse(raw.fetchedAt) < TTL_MS) return raw
    return null
  } catch {
    return null
  }
}

function readStaleCache(): UsageSummary | null {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as UsageSummary
  } catch {
    return null
  }
}

function writeCache(data: UsageSummary): void {
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true })
    writeFileSync(CACHE_PATH, JSON.stringify(data))
  } catch {
    /* best-effort */
  }
}

/* ── Public API ──────────────────────────────────────────────────── */

export async function fetchCursorUsage(): Promise<UsageSummary | null> {
  const cached = readCache()
  if (cached) return cached

  if (_inFlight) return _inFlight

  _inFlight = buildUsageSummary()
    .then((data) => {
      writeCache(data)
      return data
    })
    .catch((err) => {
      console.warn('[cursor-usage] fetch failed:', err)
      return readStaleCache()
    })
    .finally(() => {
      _inFlight = null
    })

  return _inFlight
}
