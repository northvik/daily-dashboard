/**
 * AI summary enrichment (Claude or Cursor, see ai.ts) with disk cache (4h TTL).
 * Runs server-side only. Cache lives in data/ (gitignored).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SummaryOverride } from './stacks.ts'
import { aiAvailable, runAgent } from './ai.ts'

const CACHE_FILE = 'data/stack-overrides.json'
const MAX_AGE_MS = 4 * 60 * 60 * 1000

interface CachedEntry extends SummaryOverride {
  cachedAt: number
}

function loadCache(cwd: string): CachedEntry[] {
  try {
    return JSON.parse(readFileSync(resolve(cwd, CACHE_FILE), 'utf-8'))
  } catch {
    return []
  }
}

function saveCache(cwd: string, entries: CachedEntry[]): void {
  mkdirSync(resolve(cwd, 'data'), { recursive: true })
  writeFileSync(
    resolve(cwd, CACHE_FILE),
    JSON.stringify(entries, null, 2) + '\n',
  )
}

let inFlight: Promise<void> | null = null

/**
 * Enrich multi-PR groups with AI-generated summaries.
 * Returns cached summaries right away (stale ones included) and refreshes
 * missing or >4h-old entries in the background — one agent run at a time.
 * New summaries show up on the next dashboard refresh.
 */
export async function enrichSummaries(
  stacks: { ticket: string; prs: string[] }[],
): Promise<SummaryOverride[]> {
  if (stacks.length === 0) return []

  const cwd = process.cwd()
  const cacheMap = new Map(loadCache(cwd).map((e) => [e.ticket, e]))
  const now = Date.now()

  const stale = stacks.filter((stack) => {
    const cached = cacheMap.get(stack.ticket)
    return !cached || now - cached.cachedAt >= MAX_AGE_MS
  })

  if (stale.length > 0 && aiAvailable() && !inFlight) {
    console.log(
      `[summaries] ${stacks.length - stale.length} cached, ${stale.length} to enrich: ${stale.map((s) => s.ticket).join(', ')}`,
    )
    inFlight = generate(cwd, stale).finally(() => {
      inFlight = null
    })
  }

  return stacks
    .map((s) => cacheMap.get(s.ticket))
    .filter(Boolean) as CachedEntry[]
}

async function generate(
  cwd: string,
  stale: { ticket: string; prs: string[] }[],
): Promise<void> {
  const stackList = stale
    .map(
      (s) =>
        `${s.ticket} (${s.prs.length} PRs):\n${s.prs.map((t) => `  - ${t}`).join('\n')}`,
    )
    .join('\n\n')

  const prompt = [
    'For each PR stack, return a JSON array of {ticket, name, description}.',
    'name: 2-4 word human label (e.g. "Signup Hardening").',
    'description: one sentence explaining the stack goal.',
    'Return ONLY the JSON array, no markdown, no commentary.\n',
    stackList,
  ].join('\n')

  try {
    const run = await runAgent(prompt, {
      mcp: false,
      tag: 'summaries',
      effort: 'low',
    })
    if (!run) return

    const jsonMatch = run.text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      console.error('[summaries] Could not parse JSON from response')
      return
    }

    const parsed: SummaryOverride[] = JSON.parse(jsonMatch[0])
    const cachedAt = Date.now()
    // Re-read so we don't clobber anything written while the agent ran
    const cacheMap = new Map(loadCache(cwd).map((e) => [e.ticket, e]))
    for (const e of parsed) cacheMap.set(e.ticket, { ...e, cachedAt })
    saveCache(cwd, [...cacheMap.values()])
    console.log(`[summaries] Saved ${parsed.length} summaries`)
  } catch (err) {
    console.error('[summaries] Error:', err)
  }
}
