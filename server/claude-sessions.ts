/**
 * Claude Code session reader — parses ~/.claude/projects/**\/*.jsonl into
 * per-session metadata (title, branches, PR links, searchable text) and
 * per-request token usage. Shared by usage-claude.ts and
 * conversations-claude.ts. Files are re-parsed only when they change.
 *
 * Zero tokens, zero API calls.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { costCents } from './claude-pricing.ts'

/* ── Types ───────────────────────────────────────────────────────── */

export interface ClaudeRequest {
  ts: number
  model: string
  cents: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

export interface ClaudeSession {
  id: string
  title: string
  cwd: string
  branches: string[]
  /** `repo#number` (bare repo name) from pr-link entries */
  prRefs: string[]
  updatedAt: number
  /** Lowercased user + assistant text, for ticket/PR search */
  text: string
  requests: ClaudeRequest[]
}

interface ParsedFile {
  sessionId: string
  isSubagent: boolean
  customTitle?: string
  firstPrompt?: string
  cwd: string
  branches: Set<string>
  prRefs: Set<string>
  updatedAt: number
  text: string
  /** message.id → request (streamed responses repeat the id; keep the last) */
  requests: Map<string, ClaudeRequest>
}

/* ── Parsing ─────────────────────────────────────────────────────── */

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const MAX_TEXT = 200_000
const MAX_TITLE = 80

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  speed?: string
}

type Block = { type?: string; text?: string }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

function toRequest(model: string, ts: number, u: Usage): ClaudeRequest {
  const cacheWrite = u.cache_creation_input_tokens ?? 0
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? cacheWrite - w1h
  const counts = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: Math.max(0, w5m),
    cacheWrite1hTokens: w1h,
    fast: u.speed === 'fast',
  }
  return {
    ts,
    model,
    cents: costCents(model, counts),
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: counts.cacheReadTokens,
  }
}

function parseFile(path: string): ParsedFile {
  const isSubagent = basename(dirname(path)) === 'subagents'
  const out: ParsedFile = {
    // Subagent logs live in <session>/subagents/ — attribute to the parent
    sessionId: isSubagent
      ? basename(dirname(dirname(path)))
      : basename(path, '.jsonl'),
    isSubagent,
    cwd: '',
    branches: new Set(),
    prRefs: new Set(),
    updatedAt: 0,
    text: '',
    requests: new Map(),
  }
  const texts: string[] = []
  let textLen = 0
  const addText = (t: string) => {
    if (!t || textLen > MAX_TEXT) return
    texts.push(t)
    textLen += t.length
  }

  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line) continue
    let d: Record<string, unknown>
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }

    const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN
    if (ts > out.updatedAt) out.updatedAt = ts
    if (
      typeof d.gitBranch === 'string' &&
      d.gitBranch &&
      d.gitBranch !== 'HEAD'
    )
      out.branches.add(d.gitBranch)
    if (typeof d.cwd === 'string') out.cwd = d.cwd

    switch (d.type) {
      case 'custom-title':
        if (typeof d.customTitle === 'string' && d.customTitle)
          out.customTitle = d.customTitle
        break
      case 'pr-link': {
        const repo = String(d.prRepository ?? '')
          .split('/')
          .pop()
        if (repo && d.prNumber) out.prRefs.add(`${repo}#${d.prNumber}`)
        break
      }
      case 'user': {
        if (d.isMeta) break
        const msg = d.message as { content?: unknown } | undefined
        const t = textOf(msg?.content).trim()
        // Skip command wrappers / system reminders when picking a title
        if (t && !out.firstPrompt && !t.startsWith('<')) out.firstPrompt = t
        addText(t)
        break
      }
      case 'assistant': {
        const msg = d.message as
          | { id?: string; model?: string; usage?: Usage; content?: unknown }
          | undefined
        if (!msg) break
        addText(textOf(msg.content))
        const model = msg.model ?? 'unknown'
        if (msg.usage && msg.id && !model.startsWith('<')) {
          out.requests.set(msg.id, toRequest(model, ts || 0, msg.usage))
        }
        break
      }
    }
  }

  out.text = texts.join('\n').toLowerCase()
  return out
}

/* ── Directory scan with per-file cache ──────────────────────────── */

const fileCache = new Map<
  string,
  { mtimeMs: number; size: number; parsed: ParsedFile }
>()

function listJsonl(dir: string, depth = 0): string[] {
  if (depth > 3) return []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) files.push(...listJsonl(p, depth + 1))
    else if (e.name.endsWith('.jsonl')) files.push(p)
  }
  return files
}

function parsedFiles(): ParsedFile[] {
  const paths = listJsonl(PROJECTS_DIR)
  const live = new Set(paths)
  for (const p of fileCache.keys()) if (!live.has(p)) fileCache.delete(p)

  const result: ParsedFile[] = []
  for (const p of paths) {
    try {
      const st = statSync(p)
      const hit = fileCache.get(p)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        result.push(hit.parsed)
        continue
      }
      const parsed = parseFile(p)
      if (!parsed.updatedAt) parsed.updatedAt = st.mtimeMs
      fileCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, parsed })
      result.push(parsed)
    } catch (err) {
      console.warn('[claude-sessions] Could not read', p, err)
    }
  }
  return result
}

/* ── Public API ──────────────────────────────────────────────────── */

/** All local Claude Code sessions, subagent usage folded into the parent. */
export function loadSessions(): Map<string, ClaudeSession> {
  const sessions = new Map<string, ClaudeSession>()
  const files = parsedFiles()
  // Main transcripts first so subagent files only add to existing sessions
  files.sort((a, b) => Number(a.isSubagent) - Number(b.isSubagent))

  for (const f of files) {
    let s = sessions.get(f.sessionId)
    if (!s) {
      const title = f.customTitle ?? f.firstPrompt ?? f.sessionId
      s = {
        id: f.sessionId,
        title:
          title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE)}…` : title,
        cwd: f.cwd,
        branches: [],
        prRefs: [],
        updatedAt: 0,
        text: '',
        requests: [],
      }
      sessions.set(f.sessionId, s)
    }
    if (!f.isSubagent) {
      s.text = f.text
      s.branches = [...new Set([...s.branches, ...f.branches])]
      s.prRefs = [...new Set([...s.prRefs, ...f.prRefs])]
    }
    s.updatedAt = Math.max(s.updatedAt, f.updatedAt)
    s.requests.push(...f.requests.values())
  }
  return sessions
}
