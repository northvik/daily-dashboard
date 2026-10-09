/**
 * Server-side env — loaded from process.env (Vite injects .env via loadEnv).
 * No personal defaults; missing required vars fail fast with a clear message.
 */

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    throw new Error(
      `Missing ${name}. Copy .env.example → .env and fill in your values.`,
    )
  }
  return v
}

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback
}

/** Call once at server start to validate required config. */
export function assertEnv(): void {
  required('GITHUB_TOKEN')
  required('GITHUB_USERNAME')
  // Linear / Cursor / Slack are optional — features degrade gracefully
}

export type AiProvider = 'claude' | 'cursor'

const DEFAULT_MODEL: Record<AiProvider, string> = {
  claude: 'claude-opus-5-5',
  cursor: 'claude-opus-4-6',
}

let warnedProvider = false

export const env = {
  get githubToken() {
    return required('GITHUB_TOKEN')
  },
  get githubUsername() {
    return required('GITHUB_USERNAME')
  },
  /** Fallback org when repo owner can't be resolved from search results */
  get githubOrg() {
    return optional('GITHUB_ORG')
  },
  get linearApiKey() {
    return optional('LINEAR_API_KEY')
  },
  get linearTeam() {
    return optional('LINEAR_TEAM')
  },
  /** Linear workspace slug for ticket URLs, e.g. "acme" → linear.app/acme/issue/… */
  get linearWorkspace() {
    return optional('LINEAR_WORKSPACE')
  },
  /** Which agent + local data source to use. Defaults to Claude Code. */
  get aiProvider(): AiProvider {
    const v = optional('AI_PROVIDER', 'claude').toLowerCase()
    if (v === 'claude' || v === 'cursor') return v
    if (!warnedProvider) {
      warnedProvider = true
      console.warn(`[env] Unknown AI_PROVIDER "${v}" — using claude`)
    }
    return 'claude'
  },
  get aiModel() {
    return optional('AI_MODEL', DEFAULT_MODEL[this.aiProvider])
  },
  get cursorApiKey() {
    return optional('CURSOR_API_KEY')
  },
  get slackUserId() {
    return optional('SLACK_USER_ID')
  },
  /** GitOps repo holding cluster image pins, owner/name */
  get deployRepo() {
    return optional('DEPLOY_REPO', 'gladiaio/kube-gladia')
  },
  /** Flux monorepo with per-cluster app values (apps/<app>/deploy/clusters/…) */
  get deployFluxRepo() {
    return optional('DEPLOY_FLUX_REPO', 'gladiaio/gladia')
  },
  /** Service repo → image name overrides, "repo:image,repo2:image2" */
  get deployImageMap(): Map<string, string> {
    const pairs = optional('DEPLOY_IMAGE_MAP')
      .split(',')
      .map((p) => p.split(':').map((x) => x.trim()))
      .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    return new Map(pairs)
  },
  /** Cross-check deploys against running pods with kubectl (read-only) */
  get deployLiveCheck() {
    return optional('DEPLOY_LIVE_CHECK') === '1'
  },
  /** kube-gladia env → kube context overrides, "prod-EU:K0S,…" */
  get deployKubeContexts(): Map<string, string> {
    const pairs = optional('DEPLOY_KUBE_CONTEXTS')
      .split(',')
      .map((p) => p.split(':').map((x) => x.trim()))
      .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    return new Map(pairs)
  },
  /** Slack user OAuth token (search:read) — direct fetch instead of MCP */
  get slackUserToken() {
    return optional('SLACK_USER_TOKEN')
  },
}

export function linearIssueUrl(ticketId: string): string {
  const ws = env.linearWorkspace
  if (ws) return `https://linear.app/${ws}/issue/${ticketId}`
  return `https://linear.app/issue/${ticketId}`
}

export function logEnvStatus(): void {
  const ok = (v: string) => (v ? '✓' : '–')
  console.log('[env] GITHUB_TOKEN      ', ok(process.env.GITHUB_TOKEN ?? ''))
  console.log(
    '[env] GITHUB_USERNAME   ',
    process.env.GITHUB_USERNAME || '(missing)',
  )
  console.log(
    '[env] GITHUB_ORG        ',
    process.env.GITHUB_ORG || '(optional)',
  )
  console.log('[env] LINEAR_API_KEY    ', ok(process.env.LINEAR_API_KEY ?? ''))
  console.log(
    '[env] LINEAR_TEAM       ',
    process.env.LINEAR_TEAM || '(optional)',
  )
  console.log(
    '[env] LINEAR_WORKSPACE  ',
    process.env.LINEAR_WORKSPACE || '(optional)',
  )
  console.log('[env] AI_PROVIDER       ', env.aiProvider)
  console.log('[env] AI_MODEL          ', env.aiModel)
  console.log(
    '[env] ANTHROPIC_API_KEY ',
    process.env.ANTHROPIC_API_KEY ? '✓' : '(optional — Claude Code login)',
  )
  console.log('[env] CURSOR_API_KEY    ', ok(process.env.CURSOR_API_KEY ?? ''))
  console.log(
    '[env] SLACK_USER_ID     ',
    process.env.SLACK_USER_ID || '(optional)',
  )
  console.log(
    '[env] SLACK_USER_TOKEN  ',
    ok(process.env.SLACK_USER_TOKEN ?? ''),
  )
}
