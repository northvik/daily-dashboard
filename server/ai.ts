/**
 * Provider-agnostic agent runner. AI_PROVIDER picks the backend:
 *   claude (default) — Claude Agent SDK, local Claude Code login or ANTHROPIC_API_KEY
 *   cursor           — Cursor SDK, needs CURSOR_API_KEY
 *
 * Runs are read-only: no built-in tools, only MCP tools when `mcp` is set.
 */

import { env } from './env.ts'

export interface AgentRun {
  text: string
  /** Tool names the agent had available */
  tools: string[]
  /** Tool names the agent called (one entry per call) */
  toolCalls: string[]
  /** Tool names whose call returned an error */
  toolErrors: string[]
}

export interface RunOptions {
  /** Load user MCP servers (Slack, Linear…) for this run */
  mcp: boolean
  /** Log tag, e.g. "daily" */
  tag: string
  /** Claude only — thinking depth; defaults to the model's own */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export function aiAvailable(): boolean {
  return env.aiProvider === 'claude' || Boolean(env.cursorApiKey)
}

/** After a failed run, skip the agent for a while instead of retrying on every refresh. */
const COOLDOWN_MS = 10 * 60 * 1000
let cooldownUntil = 0

export async function runAgent(
  prompt: string,
  opts: RunOptions,
): Promise<AgentRun | null> {
  if (!aiAvailable()) return null
  if (Date.now() < cooldownUntil) return null
  try {
    return env.aiProvider === 'cursor'
      ? await runCursor(prompt, opts)
      : await runClaude(prompt, opts)
  } catch (err) {
    cooldownUntil = Date.now() + COOLDOWN_MS
    const msg = err instanceof Error ? err.message : String(err)
    const hint = /401|authenticate|logged in/i.test(msg) ? authHint() : ''
    console.error(
      `[${opts.tag}] ${env.aiProvider} agent failed — pausing AI runs for 10 min: ${msg}${hint}`,
    )
    return null
  }
}

/** Manual refresh: try again right away. */
export function resetAgentCooldown(): void {
  cooldownUntil = 0
}

function authHint(): string {
  if (env.aiProvider !== 'claude') return ''
  if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return '\n  ↳ ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY is set in the environment and takes priority over your Claude Code login — refresh it or unset it.'
  }
  return '\n  ↳ Run `claude` and /login, or set ANTHROPIC_API_KEY.'
}

/* ── Claude Agent SDK ────────────────────────────────────────────── */

const READ_VERB = /(search|read|list|get|fetch|query|find|view)/i
const WRITE_VERB =
  /(send|post|create|update|delete|remove|add|schedule|save|write|edit|merge|move|upload|archive|mark|set)/i

/** MCP tools that only read (slack_search_*, list_issues…); never send or mutate. */
function isReadOnlyMcpTool(name: string): boolean {
  if (!name.startsWith('mcp__')) return false
  const tool = name.split('__').pop() ?? ''
  return READ_VERB.test(tool) && !WRITE_VERB.test(tool)
}

async function runClaude(
  prompt: string,
  opts: RunOptions,
): Promise<AgentRun | null> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')

  const run: AgentRun = { text: '', tools: [], toolCalls: [], toolErrors: [] }
  const toolNames = new Map<string, string>()

  const q = query({
    prompt,
    options: {
      model: env.aiModel,
      ...(opts.effort ? { effort: opts.effort } : {}),
      cwd: process.cwd(),
      // Dashboard runs stay out of ~/.claude/projects (and the conversation list)
      persistSession: false,
      // No built-in tools (Bash, Edit…); MCP tools only when asked
      tools: [],
      settingSources: opts.mcp ? ['user'] : [],
      ...(opts.mcp ? {} : { mcpServers: {}, strictMcpConfig: true }),
      maxTurns: opts.mcp ? 15 : 2,
      permissionMode: 'default',
      canUseTool: async (name) =>
        isReadOnlyMcpTool(name)
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'Read-only dashboard run' },
    },
  })

  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      run.tools = msg.tools
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name)
          run.toolCalls.push(block.name)
        }
      }
    } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && block.is_error) {
          run.toolErrors.push(toolNames.get(block.tool_use_id) ?? 'unknown')
        }
      }
    } else if (msg.type === 'result') {
      if (msg.subtype !== 'success') {
        console.error(`[${opts.tag}] Claude run ended:`, msg.subtype)
        return null
      }
      run.text = msg.result
    }
  }

  return run.text ? run : null
}

/* ── Cursor SDK ──────────────────────────────────────────────────── */

async function runCursor(
  prompt: string,
  opts: RunOptions,
): Promise<AgentRun | null> {
  const { Agent } = await import('@cursor/sdk')
  const apiKey = env.cursorApiKey
  const model = { id: env.aiModel }

  if (!opts.mcp) {
    const result = await Agent.prompt(prompt, {
      apiKey,
      model,
      local: { cwd: process.cwd() },
    })
    if (result.status !== 'finished' || !result.result) {
      console.error(`[${opts.tag}] Cursor run status:`, result.status)
      return null
    }
    return { text: result.result, tools: [], toolCalls: [], toolErrors: [] }
  }

  // Local SDK agent — separate from the IDE chat. Plugin MCPs load via
  // settingSources; IDE "MCPs are up" does not imply this run sees them.
  await using agent = await Agent.create({
    apiKey,
    model,
    local: {
      cwd: process.cwd(),
      settingSources: ['plugins', 'user'],
    },
  })

  const stream = await agent.send(prompt)
  const run: AgentRun = { text: '', tools: [], toolCalls: [], toolErrors: [] }
  const textParts: string[] = []

  for await (const event of stream.stream()) {
    if (event.type === 'system' && event.subtype === 'init' && event.tools) {
      run.tools = event.tools
    }
    if (event.type === 'tool_call') {
      run.toolCalls.push(event.name)
      if (event.status === 'error') {
        console.warn(`[${opts.tag}] Tool error:`, event.name, event.result)
        run.toolErrors.push(event.name)
      }
    }
    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'text') textParts.push(block.text)
      }
    }
  }

  const result = await stream.wait()
  if (result.status !== 'finished') {
    console.error(`[${opts.tag}] Cursor status:`, result.status, result.error)
    return null
  }
  run.text = result.result ?? textParts.join('\n')
  return run.text ? run : null
}
