export type PRStatus =
  | 'ready'
  | 'rebase'
  | 'ci-fail'
  | 'review'
  | 'changes-requested'
  | 'approved'
  | 'commented'
  | 'draft'

export interface PR {
  repo: string
  number: number
  title: string
  url: string
  ticket?: string
  ticketUrl?: string
  description: string
  base: string
  merged?: boolean
  /** ISO timestamp — merged PRs only */
  mergedAt?: string
  /** Per-cluster deploy status — merged PRs with a known image */
  deploys?: EnvDeploy[]
  status?: PRStatus
  depth: number
  /** ISO timestamp — last PR activity */
  updatedAt?: string
}

export type DeployState =
  | 'deployed'
  | 'applying'
  | 'promoting'
  | 'failed'
  | 'pending'
  | 'release-only'
  /** Runs a release/chart version that can't be mapped back to PRs */
  | 'untracked'

export interface EnvDeploy {
  env: string
  /** Compact label, e.g. "EU" */
  short: string
  state: DeployState
  /** Promote PR or apply run */
  url?: string
  at?: string
  /** Pinned tag on the cluster */
  tag?: string
  /** DEPLOY_LIVE_CHECK only: is the pinned image running right now? */
  live?: 'running' | 'not-running' | 'unknown'
  /** Workflow deploys: stack name shown once before its env chips */
  group?: string
}

export interface TicketInfo {
  id: string
  title: string
  url: string
  status: string
  priority: string
  priorityOrder: number
  project?: string
  labels?: string[]
  parentId?: string
  parentTitle?: string
}

export interface ConversationRef {
  id: string
  title: string
  updatedAt: string
  costCents?: number
}

export interface PRGroup {
  name: string
  description: string
  prs: PR[]
  ticket?: TicketInfo
  crossRepo?: boolean
  conversations?: ConversationRef[]
}

export interface DashboardData {
  groups: PRGroup[]
  /** Linear tickets in progress with no linked open PR */
  orphanTickets: TicketInfo[]
  /** My PRs merged in the last week that are rolling out (or just finished) */
  shipped: PR[]
  /** Source of conversation chips */
  aiProvider: AiProvider
  fetchedAt: Date
}

/* ── Daily standup ───────────────────────────────────────────────── */

export type DailyBulletTone = 'default' | 'blocked' | 'done'

export interface DailyBullet {
  /** Short action line: "merged credit flag", "waiting on review", "blocked by …" */
  text: string
  tone?: DailyBulletTone
}

export interface DailyTag {
  /** Tiny label: merged / open / ticket id / repo */
  label: string
  url?: string
}

/** One glanceable subject for standup notes */
export interface DailySubject {
  title: string
  /** 0 = most important */
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
  /** Bump when standup JSON shape changes so clients can force one free regen */
  formatVersion?: number
}

/* ── Usage (Claude Code or Cursor) ───────────────────────────────── */

export type AiProvider = 'claude' | 'cursor'

export interface UsageCycle {
  startMs: number
  endMs: number
  includedCents: number
  limitCents: number
  bonusCents: number
  percentUsed: number
  onDemandCents: number
  teamPoolCents: number
}

export interface UsageModel {
  model: string
  cents: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

export interface UsageRequestEvent {
  ts: number
  model: string
  cents: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
}

export interface UsageConversation {
  id: string
  title: string
  costCents: number
  requestCount: number
  lastEventAt: number
  events: UsageRequestEvent[]
}

export interface UsageData {
  provider: AiProvider
  cycle: UsageCycle
  models: UsageModel[]
  conversations: UsageConversation[]
  /** All events (including null/agent convId) for the daily chart */
  allEvents?: UsageRequestEvent[]
  fetchedAt: string
}
