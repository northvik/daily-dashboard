/**
 * Cursor conversation lookup — reads the local conversation-search.db
 * (SQLite FTS5) to find agent conversations that mention a PR number,
 * ticket ID, or were active on a matching git branch.
 *
 * Zero tokens, zero API calls, sub-millisecond per group.
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/* ── Types ───────────────────────────────────────────────────────── */

export interface ConversationRef {
  id: string
  title: string
  updatedAt: string
}

/* ── DB access ───────────────────────────────────────────────────── */

type Database = import('better-sqlite3').Database

const DB_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Cursor',
  'User',
  'globalStorage',
  'conversation-search.db',
)

let _db: Database | null = null

function db(): Database | null {
  if (_db) return _db
  try {
    const esmRequire = createRequire(import.meta.url)
    const Database = esmRequire('better-sqlite3') as typeof import('better-sqlite3')
    _db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
    _db.pragma('journal_mode = WAL')
    return _db
  } catch (err) {
    console.warn('[conversations] Could not open conversation-search.db:', err)
    return null
  }
}

/* ── Query helpers ───────────────────────────────────────────────── */

interface RawRow {
  id: string
  title: string
  updated_at: number
}

/**
 * Two-tier search. Strong signals: ticket IDs in body (phrase), ticket
 * slugs in branch names, exact head-ref branch matches. Weak signal: bare
 * PR numbers in body — only used when strong signals find nothing, since
 * a number like "1920" matches years and unrelated ids.
 */
function search(
  ticketIds: string[],
  prNumbers: number[],
  branchNames: string[],
): ConversationRef[] {
  const conn = db()
  if (!conn) return []

  const seen = new Set<string>()
  const results: ConversationRef[] = []

  // 1. FTS body search for ticket IDs (exact phrase match)
  for (const tid of ticketIds) {
    if (!tid) continue
    try {
      const rows = conn
        .prepare(
          `SELECT c.id, c.title, c.updated_at
           FROM conversations c
           WHERE c.fts_rowid IN (
             SELECT rowid FROM conversation_fts WHERE body MATCH ?
           )
           ORDER BY c.updated_at DESC
           LIMIT 10`,
        )
        .all(`"${tid}"`) as RawRow[]
      for (const r of rows) push(r)
    } catch {
      /* FTS match syntax error — skip */
    }
  }

  // 2. Branch name LIKE for ticket slugs
  for (const tid of ticketIds) {
    if (!tid) continue
    const slug = tid.toLowerCase()
    try {
      const rows = conn
        .prepare(
          `SELECT id, title, updated_at
           FROM conversations
           WHERE LOWER(branches) LIKE ?
           ORDER BY updated_at DESC
           LIMIT 10`,
        )
        .all(`%${slug}%`) as RawRow[]
      for (const r of rows) push(r)
    } catch {
      /* skip */
    }
  }

  // 3. Branch name exact match for known head refs
  for (const branch of branchNames) {
    if (!branch) continue
    try {
      const rows = conn
        .prepare(
          `SELECT id, title, updated_at
           FROM conversations
           WHERE branches LIKE ?
           ORDER BY updated_at DESC
           LIMIT 5`,
        )
        .all(`%${branch}%`) as RawRow[]
      for (const r of rows) push(r)
    } catch {
      /* skip */
    }
  }

  // 4. Weak fallback: bare PR numbers, only when nothing strong matched
  if (results.length === 0) {
    for (const num of prNumbers) {
      try {
        const rows = conn
          .prepare(
            `SELECT c.id, c.title, c.updated_at
             FROM conversations c
             WHERE c.fts_rowid IN (
               SELECT rowid FROM conversation_fts WHERE body MATCH ?
             )
             ORDER BY c.updated_at DESC
             LIMIT 10`,
          )
          .all(String(num)) as RawRow[]
        for (const r of rows) push(r)
      } catch {
        /* skip */
      }
    }
  }

  function push(r: RawRow) {
    if (seen.has(r.id)) return
    seen.add(r.id)
    results.push({
      id: r.id,
      title: r.title,
      updatedAt: new Date(r.updated_at).toISOString(),
    })
  }

  // Sort newest first, cap at 5
  results.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return results.slice(0, 5)
}

/* ── Public batch API ────────────────────────────────────────────── */

export interface GroupSearchInput {
  key: string
  ticketIds: string[]
  prNumbers: number[]
  branchNames: string[]
}

export function findConversationsForGroups(
  inputs: GroupSearchInput[],
): Map<string, ConversationRef[]> {
  const result = new Map<string, ConversationRef[]>()
  for (const input of inputs) {
    const refs = search(input.ticketIds, input.prNumbers, input.branchNames)
    if (refs.length > 0) result.set(input.key, refs)
  }
  return result
}
