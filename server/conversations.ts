/**
 * Conversation facade — links agent conversations to PR groups from the
 * configured AI_PROVIDER (Claude Code session logs or Cursor's search DB).
 */

import { env } from './env.ts'

export interface ConversationRef {
  id: string
  title: string
  updatedAt: string
}

export interface GroupSearchInput {
  key: string
  ticketIds: string[]
  prNumbers: number[]
  /** `repo#number` with the bare repo name */
  prRefs: string[]
  branchNames: string[]
}

async function impl() {
  return env.aiProvider === 'cursor'
    ? import('./conversations-cursor.ts')
    : import('./conversations-claude.ts')
}

export async function findConversationsForGroups(
  inputs: GroupSearchInput[],
): Promise<Map<string, ConversationRef[]>> {
  return (await impl()).findConversationsForGroups(inputs)
}

/** Batch look up conversation titles by ID. */
export async function getConversationTitles(
  ids: string[],
): Promise<Map<string, string>> {
  return (await impl()).getConversationTitles(ids)
}
