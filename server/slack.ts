/**
 * Direct Slack fetch for the daily standup — one search.messages call
 * instead of an MCP round trip. Needs a user token (xoxp-…) with search:read.
 */

import { env } from './env.ts'

interface SearchMatch {
  ts: string
  text: string
  channel?: { name?: string; is_im?: boolean; is_mpim?: boolean }
}

interface SearchResponse {
  ok: boolean
  error?: string
  messages?: {
    matches: SearchMatch[]
    paging?: { pages: number }
  }
}

const MAX_PAGES = 3
const MAX_TEXT = 300

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function formatMatch(m: SearchMatch): string {
  const ch = m.channel?.is_im
    ? 'DM'
    : m.channel?.is_mpim
      ? 'group DM'
      : `#${m.channel?.name ?? '?'}`
  const d = new Date(Number(m.ts) * 1000)
  const when = d.toLocaleString('en-GB', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  let text = m.text.replace(/\s+/g, ' ').trim()
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…`
  return `${ch} · ${when} · ${text}`
}

/**
 * My messages from `fromDate` through `toDate` (inclusive), oldest first.
 * Throws on API errors so the caller can fall back to MCP.
 */
export async function fetchMyMessages(
  fromDate: string,
  toDate: string,
): Promise<string[]> {
  const token = env.slackUserToken
  const userId = env.slackUserId
  if (!token || !userId) throw new Error('Slack token or user id missing')

  // Slack's after:/before: are exclusive — widen by a day on each side
  const query = `from:<@${userId}> after:${shiftDate(fromDate, -1)} before:${shiftDate(toDate, 1)}`
  const matches: SearchMatch[] = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      query,
      count: '100',
      page: String(page),
      sort: 'timestamp',
      sort_dir: 'asc',
    })
    const res = await fetch(`https://slack.com/api/search.messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`Slack HTTP ${res.status}`)
    const data = (await res.json()) as SearchResponse
    if (!data.ok) throw new Error(`Slack API: ${data.error ?? 'unknown'}`)
    matches.push(...(data.messages?.matches ?? []))
    if (page >= (data.messages?.paging?.pages ?? 1)) break
  }

  return matches.filter((m) => m.text?.trim()).map(formatMatch)
}
