# Daily Dashboard

Local dashboard: open GitHub PRs, Linear tickets, AI usage costs, and a daily standup — one page.

PRs group into stacks (git-spice / branch base), sort by last-commit freshness, and get optional AI summaries. Tokens stay server-side.

`AI_PROVIDER` picks the AI backend and the usage/conversation source: `claude` (default, Claude Code) or `cursor`.

## Quick start

```sh
git clone git@github.com:northvik/daily-dashboard.git && cd daily-dashboard
cp .env.example .env
# edit .env — at minimum set GITHUB_TOKEN and GITHUB_USERNAME

npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Environment variables

| Variable            | Required | Description                                                         | Where to get it                                                                                                       |
| ------------------- | -------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`      | yes      | PAT with repo/PR read access                                        | GitHub → **Settings** → **Developer settings** → **[Personal access tokens](https://github.com/settings/tokens)**     |
| `GITHUB_USERNAME`   | yes      | Your GitHub login (`author:` filter)                                | GitHub profile URL                                                                                                    |
| `GITHUB_ORG`        | no       | Fallback org for merged ancestor lookups                            | Org slug from GitHub URLs                                                                                             |
| `LINEAR_API_KEY`    | no       | Personal API key — tickets, priority, status                        | Linear → **Settings** → **[Security & access](https://linear.app/settings/account/security)** → **Personal API keys** |
| `LINEAR_TEAM`       | no       | Team key filter (e.g. `ENG`)                                        | Short key next to the team name                                                                                       |
| `LINEAR_WORKSPACE`  | no       | Workspace slug for ticket links                                     | From any issue URL: `linear.app/**workspace**/issue/…`                                                                |
| `AI_PROVIDER`       | no       | `claude` (default) or `cursor`                                      | —                                                                                                                     |
| `AI_MODEL`          | no       | Agent model. Default `claude-opus-5-5` (cursor: `claude-opus-4-6`)  | —                                                                                                                     |
| `ANTHROPIC_API_KEY` | no       | Claude API key. Unset: uses your Claude Code login                  | [Claude Console → API keys](https://platform.claude.com/settings/keys)                                                |
| `CURSOR_API_KEY`    | cursor   | Cursor SDK — AI summaries + daily brief                             | Cursor → **[Dashboard → Integrations](https://cursor.com/dashboard/integrations)**                                    |
| `SLACK_USER_ID`     | no       | Your Slack member ID — adds Slack to the daily brief                | Slack → profile → **⋯** → **Copy member ID**                                                                          |
| `DEPLOY_REPO`       | no       | GitOps repo with cluster image pins. Default `gladiaio/kube-gladia` | —                                                                                                                     |
| `DEPLOY_IMAGE_MAP`  | no       | `repo:image,…` overrides. Default image `gladia-<repo>`             | —                                                                                                                     |
| `DEPLOY_LIVE_CHECK` | no       | `1` = also check running pods with `kubectl` (read-only)            | Uses your `KUBECONFIG`; Teleport clusters need `tsh login`                                                            |
| `SLACK_USER_TOKEN`  | no       | User OAuth Token (`search:read`) — direct Slack fetch               | See [Slack for the daily](#slack-for-the-daily)                                                                       |

On startup the server prints which vars are set (`✓` / `–`).

## What you get

### Left panel — PR stacks

- **Tree view** of open PRs (git-spice comments preferred), merged ancestors in purple
- **Status icons** — ready, rebase, CI fail, approved, changes requested, commented, draft
- **Linear metadata** — priority, status, labels on each group
- **Freshness sort** — most recently pushed stacks first
- **Archive** — stacks idle 7+ days collapse into an expandable section
- **Conversation chips** — linked agent sessions per stack (matched by PR link, ticket ID, branch name, or PR number). Cost shown inline. Click copies `claude --resume <id>` (Claude) or the title (Cursor).

### Deploy status

Merged PRs get one chip per cluster, e.g. `EU✓ US12⏳ CLR–`:

| Chip | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| `✓`  | Pinned tag includes the PR and the cluster's Apply passed    |
| `⏳` | Promote PR open, or Apply running                            |
| `✗`  | Apply failed                                                 |
| `·`  | Not promoted yet                                             |
| `–`  | Release-only cluster, waits for a release                    |
| `●`  | Live check on: the pinned image is running (`?` = no access) |

Chips show on merged PRs in stacks and in **Shipped**: your PRs merged in the last 7 days, until a day after they finish rolling out. Hover for the pinned tag; click for the promote PR or Apply run.

### Right panel — tabbed sidebar

- **Daily** — Yesterday / Today standup notes (AI agent + optional Slack)
- **Tickets** — Linear tickets in progress with no linked PR
- **Usage by models** — per-model cost and token count for the billing cycle
- **Usage by conversations** — per-conversation cost, request count, last activity

### Top strip

- PR stats: open, ready, rebase, CI failing
- Claude: month-to-date API-equivalent cost and tokens
- Cursor: `included + bonus + on-demand = total`, reset date, auto-refresh 60s

## How it works

### AI agent

- **Claude** (default): the Claude Agent SDK runs Claude Code headless. Auth comes from `ANTHROPIC_API_KEY` or your Claude Code login. Runs are read-only (no built-in tools) and don't save sessions.
- **Cursor**: the Cursor SDK runs a local agent with `CURSOR_API_KEY`.

### Usage and conversations (zero tokens)

**Claude** reads Claude Code session logs in `~/.claude/projects`:

- Cost = tokens × API list price, so it's an estimate, not a bill. Subscription plans don't bill per token.
- Requests Claude Code doesn't log (title generation, for example) are missing, so totals run slightly low.
- Chips match sessions by PR links Claude Code recorded, ticket IDs in the text, and git branch.

**Cursor** reads billing from `api2.cursor.sh` with the local auth token from Cursor's `state.vscdb`, cached 5 min in `data/usage-cache-cursor.json`. Raw costs scale to the billed total. Chips come from Cursor's `conversation-search.db` (SQLite FTS5).

### Deploy status (zero tokens)

Reads `kube-gladia` through the GitHub API, no cluster access needed:

1. `.github/manifests/cd-manifest.yml` and `release-manifest.yml` list the clusters each image goes to.
2. Each cluster's `kustomization.yaml` pins a tag like `pr-1966-<sha>`. The PR is on that cluster when its merge commit is inside PR 1966's merge commit (compare API).
3. The commit that set the pin maps to its promote PR, and that PR's `*-apply.yml` run gives ✓, ⏳ or ✗.

It uses core REST calls only: GitHub search allows 30 calls per minute, shared with the rest of the dashboard. Results are cached until the rollout settles.

With `DEPLOY_LIVE_CHECK=1`, the server also runs `kubectl get deploy -A` (read-only) per cluster every 2 min and checks the pinned image is running.

### Daily standup

1. Leave `npm run dev` running (or press **↻** on the Daily tab).
2. With an AI provider available: AI-generated from GitHub + Linear + Slack.
3. Without: heuristic brief from GitHub/Linear data.

#### Slack for the daily

Set `SLACK_USER_ID`, then pick a source:

- **Direct (recommended):** set `SLACK_USER_TOKEN`. The server fetches your messages in one `search.messages` call and the agent runs one turn with no tools. That uses fewer tokens than MCP.
- **MCP fallback:** without a token, or if the call fails, the agent searches Slack with its MCP tools. Claude loads servers from your user settings. Check `[daily] Slack tools on agent:` in the Vite logs.

To get a token:

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps).
2. Under **OAuth & Permissions → User Token Scopes**, add `search:read`.
3. Install the app to your workspace (your admin may need to approve it).
4. Copy the **User OAuth Token** (`xoxp-…`). Bot tokens don't work with search.

## Project layout

```
src/                  React UI (App, types, API client, CSS)
server/
  github.ts           GitHub REST + GraphQL
  linear.ts           Linear GraphQL
  stacks.ts           Stack detection, grouping, ticket attachment
  dashboard.ts        Orchestrator — groups, summaries, conversations, costs
  ai.ts               Agent runner — Claude Agent SDK or Cursor SDK
  daily.ts            Daily standup generation
  slack.ts            Direct Slack search (SLACK_USER_TOKEN)
  summaries.ts        AI stack summaries
  conversations*.ts   Conversation lookup — facade + claude / cursor
  usage*.ts           Usage + per-conversation cost — facade + claude / cursor
  claude-sessions.ts  Claude Code session log reader
  claude-pricing.ts   Claude list prices for cost estimates
  deploys.ts          Per-cluster deploy status from kube-gladia
  kube-live.ts        Optional kubectl live check
  plugin.ts           Vite plugin — /api/dashboard, /api/daily, /api/usage
  env.ts              Server-side env validation
data/                 Local caches (gitignored)
.env                  Your secrets (gitignored)
```

## Tips

- Use your own GitHub token and username — the dashboard shows that author's PRs.
- Linear, AI, and Slack are optional. The PR list works with GitHub alone.
- Usage reads local Claude Code logs (or your Cursor auth token) automatically. No extra config.
- Local dev tool only (`configureServer`). No production deploy path.
- Never commit `.env` or `data/`.

## Scripts

| Command                | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `npm run dev`          | Start UI + APIs                                             |
| `npm run build`        | Typecheck + production client build (APIs won't be present) |
| `npm run lint`         | ESLint                                                      |
| `npm run format`       | Prettier (write)                                            |
| `npm run format:check` | Prettier (check)                                            |
