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
  status?: PRStatus
  depth: number
  /** ISO timestamp — last PR activity */
  updatedAt?: string
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
}

export interface ConversationRef {
  id: string
  title: string
  updatedAt: string
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
