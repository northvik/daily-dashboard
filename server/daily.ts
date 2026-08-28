/**
 * Daily standup generation — gathers GitHub / Linear context with links,
 * then asks a local Cursor agent (Opus 4.6 + Slack/Linear MCP) to produce
 * subject-grouped standup notes. Cached to data/daily-YYYY-MM-DD.json.
 *
 * Max Cursor cost is uncontrolled on manual refresh — cron still uses the 12h cache.
 * Slack is fetched by the agent via Cursor MCP (no SLACK_USER_TOKEN needed).
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { resolve } from 'node:path'
import {
  fetchOpenPRs,
  fetchPRsUpdatedSince,
  fetchPRsMergedOn,
  repoFromUrl,
} from './github.ts'
import { fetchLinearIssues, fetchLinearUpdatedSince } from './linear.ts'
import { env } from './env.ts'

/* ── Types ───────────────────────────────────────────────────────── */

export type DailyBulletTone = 'default' | 'blocked' | 'done'

export interface DailyBullet {
  text: string
  tone?: DailyBulletTone
}

export interface DailyTag {
  label: string
  url?: string
}

export interface DailySubject {
  title: string
  importance: number
  bullets: DailyBullet[]
  tags?: DailyTag[]
}

export interface DailyAlert {
  type: 'missing-ticket' | 'stale-pr' | 'slack-gap'
  message: string
}

export interface DailyData {
  date: string
  yesterday: DailySubject[]
  today: DailySubject[]
  alerts: DailyAlert[]
  generatedAt: string
  generationCount: number
  formatVersion?: number
}

const FORMAT_VERSION = 4
const MAX_SUBJECTS = 5
const MAX_BULLETS = 3
const DATA_DIR = 'data'
const STALE_HOURS = 12

function isSlackToolName(name: string): boolean {
  return /slack/i.test(name)
}

/* ── Cache helpers ───────────────────────────────────────────────── */

function dataPath(date: string): string {
  return resolve(process.cwd(), DATA_DIR, `daily-${date}.json`)
}

function ensureDataDir(): void {
  mkdirSync(resolve(process.cwd(), DATA_DIR), { recursive: true })
}

export function todayDate(): string {
  return formatDate(new Date())
}

export function yesterdayDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return formatDate(d)
}

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function loadDaily(date: string): DailyData | null {
  try {
    const raw = JSON.parse(
      readFileSync(dataPath(date), 'utf-8'),
    ) as DailyData & {
      yesterday?: unknown
      today?: unknown
    }
    return {
      ...raw,
      yesterday: normalizeSubjects(raw.yesterday),
      today: normalizeSubjects(raw.today),
      alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
    }
  } catch {
    return null
  }
}

function saveDaily(data: DailyData): void {
  ensureDataDir()
  writeFileSync(dataPath(data.date), JSON.stringify(data, null, 2) + '\n')
}

export function cleanupOldDailies(): void {
  const dir = resolve(process.cwd(), DATA_DIR)
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return
  }
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 7)
  const cutoffStr = formatDate(cutoff)

  for (const f of files) {
    const m = f.match(/^daily-(\d{4}-\d{2}-\d{2})\.json$/)
    if (m && m[1] < cutoffStr) {
      try {
        unlinkSync(resolve(dir, f))
      } catch {
        /* ignore */
      }
    }
  }
}

/* ── Raw seed context ────────────────────────────────────────────── */

interface RawContext {
  yesterdayDate: string
  todayDate: string
  githubYesterday: string[]
  githubMerged: string[]
  githubOpen: string[]
  linearRecent: string[]
  linearStarted: string[]
}

async function gatherRawContext(date: string): Promise<RawContext> {
  const yDay = (() => {
    const d = new Date(`${date}T12:00:00`)
    d.setDate(d.getDate() - 1)
    return formatDate(d)
  })()

  const sinceISO = new Date(`${yDay}T00:00:00`).toISOString()

  const [updated, merged, open, linearRecent, linearStarted] =
    await Promise.all([
      fetchPRsUpdatedSince(yDay).catch(() => []),
      fetchPRsMergedOn(yDay).catch(() => []),
      fetchOpenPRs().catch(() => []),
      fetchLinearUpdatedSince(sinceISO).catch(() => []),
      fetchLinearIssues('started').catch(() => []),
    ])

  return {
    yesterdayDate: yDay,
    todayDate: date,
    githubYesterday: updated.map((item) => {
      const { repo } = repoFromUrl(item.repository_url)
      return `${repo}#${item.number}: ${item.title}\n  ${item.html_url}`
    }),
    githubMerged: merged.map((item) => {
      const { repo } = repoFromUrl(item.repository_url)
      return `MERGED ${repo}#${item.number}: ${item.title}\n  ${item.html_url}`
    }),
    githubOpen: open.map((item) => {
      const { repo } = repoFromUrl(item.repository_url)
      const draft = item.draft ? ' [draft]' : ''
      return `${repo}#${item.number}${draft}: ${item.title}\n  ${item.html_url}`
    }),
    linearRecent: linearRecent.map((i) => {
      const done = i.completedAt ? ' [done]' : ` [${i.state.name}]`
      return `${i.identifier}${done}: ${i.title}\n  ${i.url}`
    }),
    linearStarted: linearStarted.map(
      (i) =>
        `${i.identifier} [${i.state.name}] ${i.priorityLabel}: ${i.title}\n  ${i.url}`,
    ),
  }
}

/* ── Normalize / migrate ─────────────────────────────────────────── */

function sortByImportance(subjects: DailySubject[]): DailySubject[] {
  return [...subjects].sort((a, b) => a.importance - b.importance)
}

function cleanTitle(title: string): string {
  return title
    .replace(/^(Merged|Opened|Updated)\s+/i, '')
    .replace(/\b[\w.-]+#\d+\b/g, '')
    .replace(/\b[A-Z]+-\d+\b/g, '')
    .replace(/^\s*[:\-–—]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function looksLikePrRef(s: string): boolean {
  return /#\d+/.test(s) || /^(Merged|Opened|Updated)\b/i.test(s)
}

function dedupeBullets(title: string, bullets: DailyBullet[]): DailyBullet[] {
  const titleL = title.toLowerCase()
  const out: DailyBullet[] = []
  const seen = new Set<string>()

  for (const b of bullets) {
    let text = b.text.trim()
    if (!text) continue
    // Drop bullets that just repeat the subject title
    if (text.toLowerCase() === titleL) continue
    if (titleL.includes(text.toLowerCase()) && text.length < title.length + 5)
      continue
    // Strip leading "Merged api#123: " noise from bullets
    text = text
      .replace(/^(merged|opened|updated)\s+[\w.-]+#\d+\s*:?\s*/i, '')
      .replace(/^[\w.-]+#\d+\s*:?\s*/i, '')
      .trim()
    if (!text || text.toLowerCase() === titleL) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...b, text })
    if (out.length >= MAX_BULLETS) break
  }
  return out
}

function normalizeSubjects(raw: unknown): DailySubject[] {
  if (!Array.isArray(raw)) return []

  const subjects: DailySubject[] = []

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>

    if (Array.isArray(o.bullets)) {
      let title = typeof o.title === 'string' ? o.title.trim() : ''
      if (!title) continue
      title = cleanTitle(title) || title
      // Skip garbage subjects that are only PR refs
      if (looksLikePrRef(title) && title.length < 40) {
        title =
          cleanTitle(typeof o.title === 'string' ? o.title : '') || 'Misc work'
      }

      const bullets = dedupeBullets(
        title,
        o.bullets
          .map((b): DailyBullet | null => {
            if (typeof b === 'string') return { text: b }
            if (!b || typeof b !== 'object') return null
            const bb = b as Record<string, unknown>
            if (typeof bb.text !== 'string' || !bb.text.trim()) return null
            const tone =
              bb.tone === 'blocked' ||
              bb.tone === 'done' ||
              bb.tone === 'default'
                ? bb.tone
                : undefined
            return { text: bb.text.trim(), tone }
          })
          .filter((b): b is DailyBullet => b !== null),
      )

      // Subject with no useful bullets + PR-like title → skip
      if (bullets.length === 0 && looksLikePrRef(String(o.title))) continue

      const tags: DailyTag[] = []
      if (Array.isArray(o.tags)) {
        for (const t of o.tags) {
          if (typeof t === 'string') {
            if (!tags.some((x) => x.label === t)) tags.push({ label: t })
          } else if (t && typeof t === 'object') {
            const tt = t as Record<string, unknown>
            if (
              typeof tt.label === 'string' &&
              !tags.some((x) => x.label === tt.label)
            ) {
              tags.push({
                label: tt.label,
                url: typeof tt.url === 'string' ? tt.url : undefined,
              })
            }
          }
          if (tags.length >= 4) break
        }
      }

      subjects.push({
        title,
        importance: typeof o.importance === 'number' ? o.importance : 50,
        bullets,
        tags: tags.length > 0 ? tags : undefined,
      })
      continue
    }

    // Legacy flat → skip PR-dump entries; only keep if we can salvage a subject
    const rawTitle =
      typeof o.title === 'string'
        ? o.title
        : typeof o.text === 'string'
          ? o.text.slice(0, 60)
          : null
    if (!rawTitle) continue
    const title = cleanTitle(rawTitle)
    if (!title || looksLikePrRef(rawTitle)) continue

    const summary =
      typeof o.summary === 'string'
        ? o.summary
        : typeof o.text === 'string'
          ? o.text
          : ''
    const bullets = dedupeBullets(title, summary ? [{ text: summary }] : [])

    subjects.push({
      title,
      importance: 50,
      bullets,
      tags: undefined,
    })
  }

  return sortByImportance(subjects).slice(0, MAX_SUBJECTS)
}

/* ── Heuristic fallback — sparse, subject-first ──────────────────── */

function heuristicDaily(ctx: RawContext, generationCount: number): DailyData {
  const map = new Map<string, DailySubject>()

  for (const line of [...ctx.githubMerged, ...ctx.githubYesterday]) {
    const head = line.split('\n')[0]
    const url = line.match(/(https:\/\/github\.com\S+)/)?.[1]
    const ticket = head.match(/\(([A-Z]+-\d+)\)/)?.[1]
    const repo = head.match(/^(?:MERGED\s+)?([^#\s]+)#/)?.[1]
    const merged = /^MERGED\b/i.test(head)
    const key = ticket ?? `other-${repo ?? 'x'}`
    const title =
      (ticket && humanizeFromHead(head)) ||
      humanizeFromHead(head) ||
      'Ongoing work'

    let s = map.get(key)
    if (!s) {
      s = {
        title,
        importance: merged ? 30 : 40,
        bullets: [],
        tags: [],
      }
      map.set(key, s)
    }
    const action = merged ? 'shipped' : 'pushed updates'
    if (!s.bullets.some((b) => b.text === action)) {
      s.bullets.push({ text: action, tone: merged ? 'done' : 'default' })
    }
    if (ticket) s.tags = mergeTags(s.tags, { label: ticket, url })
    if (repo) s.tags = mergeTags(s.tags, { label: repo })
    s.tags = mergeTags(s.tags, { label: merged ? 'merged' : 'open' })
  }

  const yesterday = sortByImportance(
    [...map.values()].map((s) => ({
      ...s,
      bullets: dedupeBullets(s.title, s.bullets).slice(0, MAX_BULLETS),
      tags: s.tags?.slice(0, 3),
    })),
  ).slice(0, MAX_SUBJECTS)

  const today: DailySubject[] = []
  const seenTicket = new Set<string>()
  for (const line of ctx.linearStarted) {
    const head = line.split('\n')[0]
    const url = line.match(/(https:\/\/linear\.app\S+)/)?.[1]
    const ticket = head.match(/^([A-Z]+-\d+)/)?.[1]
    if (ticket && seenTicket.has(ticket)) continue
    if (ticket) seenTicket.add(ticket)

    const pri = head.includes('Urgent')
      ? 0
      : head.includes('High')
        ? 10
        : head.includes('Medium')
          ? 25
          : 40

    const title = humanizeFromHead(head) || ticket || 'In progress'
    today.push({
      title,
      importance: pri,
      bullets: [{ text: 'keep moving' }],
      tags: [...(ticket ? [{ label: ticket, url }] : []), { label: 'open' }],
    })
    if (today.length >= MAX_SUBJECTS) break
  }

  return {
    date: ctx.todayDate,
    yesterday,
    today: sortByImportance(today),
    alerts: [],
    generatedAt: new Date().toISOString(),
    generationCount,
    formatVersion: FORMAT_VERSION,
  }
}

function humanizeFromHead(head: string): string {
  const cleaned = head
    .replace(/^MERGED\s+/i, '')
    .replace(/^[\w.-]+#\d+\s*/i, '')
    .replace(/^\([^)]+\)\s*/, '')
    .replace(/\([A-Z]+-\d+\)\s*/g, '')
    .replace(/^(feat|fix|chore|ci|docs)\([^)]+\):\s*/i, '')
    .replace(/^:\s*/, '')
    .trim()
  if (cleaned.length >= 6 && cleaned.length <= 48 && !looksLikePrRef(cleaned)) {
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
  }
  return ''
}

function mergeTags(
  existing: DailyTag[] | undefined,
  tag: DailyTag,
): DailyTag[] {
  const list = existing ?? []
  if (list.some((t) => t.label === tag.label)) return list
  return [...list, tag]
}

/* ── Cursor + MCP enrichment ─────────────────────────────────────── */

async function enrichWithCursor(
  ctx: RawContext,
  generationCount: number,
): Promise<DailyData | null> {
  const apiKey = env.cursorApiKey
  if (!apiKey) return null

  const slackId = env.slackUserId
  const slackResearch = slackId
    ? [
        '1. REQUIRED before writing JSON: call Slack MCP tools',
        '   slack_search_public_and_private (preferred) or slack_search_public with query:',
        `   from:<@${slackId}> after:${ctx.yesterdayDate} before:${ctx.todayDate}`,
        '   Infer commitments, blockers, decisions from results.',
        '2. Use Linear/GitHub links below for more context if helpful.',
        '3. Never invent an alert about MCP being unavailable — if Slack tools are missing, just omit Slack context.',
      ]
    : [
        '1. No Slack user id configured — do not call Slack MCP.',
        '2. Use Linear/GitHub links below for more context if helpful.',
      ]

  const prompt = [
    'You prepare my daily standup notes for a live meeting.',
    `Today is ${ctx.todayDate}. Yesterday was ${ctx.yesterdayDate}.`,
    slackId ? `My Slack user id is ${slackId}.` : 'Slack is not configured.',
    '',
    '## Research first (MCP)',
    ...slackResearch,
    '',
    '## Output — ONLY JSON (no fences, no commentary)',
    '{',
    '  "yesterday": [ Subject, ... ],',
    '  "today": [ Subject, ... ],',
    '  "alerts": [ { "type", "message" } ]',
    '}',
    '',
    'Subject shape:',
    '{',
    '  "title": "Human subject name",',
    '  "importance": 0,',
    '  "bullets": [ { "text": "...", "tone?": "default"|"blocked"|"done" } ],',
    '  "tags": [ { "label": "merged"|"open"|"ABC-123"|"api", "url?" } ]',
    '}',
    '',
    '## Writing rules (critical — read carefully)',
    'This is a glance sheet for a 2-minute standup. LESS IS MORE.',
    '',
    'GOOD example:',
    '  { "title": "Signup hardening", "importance": 0,',
    '    "bullets": [',
    '      { "text": "shipped credit-flag cleanup", "tone": "done" },',
    '      { "text": "orphan-job design opened" },',
    '      { "text": "blocked on billing review", "tone": "blocked" }',
    '    ],',
    '    "tags": [{ "label": "ABC-123" }, { "label": "merged" }] }',
    '',
    'BAD (never do this):',
    '  title: "Merged api#1701"',
    '  bullets: [{ "text": "Merged api#1701" }]   ← duplicate + PR noise',
    '',
    'Hard limits:',
    `- max ${MAX_SUBJECTS} subjects per column`,
    `- max ${MAX_BULLETS} bullets per subject`,
    '- max 3 tags per subject',
    '- title = plain English theme (2–5 words). NO repo#num, NO ticket ids in title',
    '- bullets = verbs about outcomes (shipped / reviewing / blocked by X)',
    '- NEVER repeat the title as a bullet',
    '- NEVER put api#123 or ABC-123 in title or bullet text — tags only',
    '- importance 0 = talk about first in the meeting',
    '- Prefer French if Slack is French, else English',
    '- alerts: only real work blockers / missing tickets — max 2, or empty array',
    '- alert type: "missing-ticket" | "stale-pr" only (never "slack-gap", never MCP status)',
    '',
    '## Seed data (compress into subjects — do not echo this list)',
    '',
    '### GitHub updated yesterday',
    ctx.githubYesterday.join('\n') || '(none)',
    '',
    '### GitHub merged yesterday',
    ctx.githubMerged.join('\n') || '(none)',
    '',
    '### Open PRs',
    ctx.githubOpen.join('\n') || '(none)',
    '',
    '### Linear updated recently',
    ctx.linearRecent.join('\n') || '(none)',
    '',
    '### Linear in progress',
    ctx.linearStarted.join('\n') || '(none)',
  ].join('\n')

  try {
    const { Agent } = await import('@cursor/sdk')
    // Local SDK agent — separate from the IDE chat. Plugin Slack MCP is
    // loaded via settingSources; IDE "MCPs are up" does not imply this run sees them.
    await using agent = await Agent.create({
      apiKey,
      model: { id: 'claude-opus-4-6' },
      local: {
        cwd: process.cwd(),
        settingSources: ['plugins', 'user'],
      },
    })

    const run = await agent.send(prompt)
    let availableTools: string[] = []
    let slackToolCalls = 0
    const textParts: string[] = []

    for await (const event of run.stream()) {
      if (event.type === 'system' && event.subtype === 'init' && event.tools) {
        availableTools = event.tools
        const slackTools = availableTools.filter(isSlackToolName)
        console.log(
          '[daily] Slack tools on agent:',
          slackTools.length ? slackTools.join(', ') : '(none)',
        )
      }
      if (event.type === 'tool_call' && isSlackToolName(event.name)) {
        slackToolCalls += 1
        if (event.status === 'error') {
          console.warn('[daily] Slack tool error:', event.name, event.result)
        }
      }
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'text') textParts.push(block.text)
        }
      }
    }

    const result = await run.wait()
    if (result.status !== 'finished') {
      console.error('[daily] Cursor status:', result.status, result.error)
      return null
    }

    const rawText = result.result ?? textParts.join('\n')
    if (!rawText) {
      console.error('[daily] Empty Cursor result')
      return null
    }

    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.error('[daily] Could not parse JSON from Cursor')
      return null
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      yesterday?: unknown
      today?: unknown
      alerts?: DailyAlert[]
    }

    const slackToolsAvailable = availableTools.some(isSlackToolName)
    const alerts = sanitizeAlerts(parsed.alerts, {
      slackConfigured: Boolean(slackId),
      slackToolsAvailable,
      slackToolCalls,
    })

    if (slackId && slackToolsAvailable && slackToolCalls === 0) {
      console.warn(
        '[daily] Slack tools were available but unused — standup may miss channel context',
      )
    }

    return {
      date: ctx.todayDate,
      yesterday: normalizeSubjects(parsed.yesterday),
      today: normalizeSubjects(parsed.today),
      alerts,
      generatedAt: new Date().toISOString(),
      generationCount,
      formatVersion: FORMAT_VERSION,
    }
  } catch (err) {
    console.error('[daily] Cursor error:', err)
    return null
  }
}

/** Drop model-invented MCP status alerts; only emit slack-gap from real evidence. */
function sanitizeAlerts(
  alerts: DailyAlert[] | undefined,
  opts: {
    slackConfigured: boolean
    slackToolsAvailable: boolean
    slackToolCalls: number
  },
): DailyAlert[] {
  const cleaned = (Array.isArray(alerts) ? alerts : []).filter((a) => {
    if (a.type === 'slack-gap') return false
    if (/slack\s*mcp|mcp\s*unavailable/i.test(a.message)) return false
    return a.type === 'missing-ticket' || a.type === 'stale-pr'
  })

  if (opts.slackConfigured && !opts.slackToolsAvailable) {
    cleaned.push({
      type: 'slack-gap',
      message:
        'Daily’s Cursor SDK agent did not load Slack plugin tools (IDE chat MCPs are separate). Notes are GitHub/Linear only.',
    })
  } else if (
    opts.slackConfigured &&
    opts.slackToolsAvailable &&
    opts.slackToolCalls === 0
  ) {
    // Soft signal only in logs — avoid noisy UI when the model skipped Slack.
  }

  return cleaned.slice(0, 2)
}

/* ── Public API ──────────────────────────────────────────────────── */

export interface GenerateOptions {
  force?: boolean
}

export async function generateDaily(
  date: string = todayDate(),
  opts: GenerateOptions = {},
): Promise<DailyData> {
  const existing = loadDaily(date)
  const staleFormat = (existing?.formatVersion ?? 0) < FORMAT_VERSION

  // Auto/cron: reuse cache if fresh. Manual force always regenerates.
  if (existing && !opts.force && !staleFormat) {
    const ageMs = Date.now() - new Date(existing.generatedAt).getTime()
    if (ageMs < STALE_HOURS * 60 * 60 * 1000) {
      return existing
    }
  }

  const generationCount = (existing?.generationCount ?? 0) + 1
  console.log(
    `[daily] Generating for ${date} (run #${generationCount}${opts.force ? ', forced' : ''})…`,
  )
  const ctx = await gatherRawContext(date)

  let data = await enrichWithCursor(ctx, generationCount)
  if (!data) {
    data = heuristicDaily(ctx, generationCount)
  }

  saveDaily(data)
  cleanupOldDailies()
  console.log(
    `[daily] Saved ${data.yesterday.length} yesterday / ${data.today.length} today / ${data.alerts.length} alerts`,
  )
  return data
}

export function shouldAutoGenerate(): boolean {
  const now = new Date()
  if (now.getHours() !== 8) return false
  if (now.getMinutes() > 5) return false
  return !loadDaily(todayDate())
}
