# Daily Dashboard

Local dashboard: open GitHub PRs, Linear tickets, Cursor usage costs, and a daily standup — one page.

PRs group into stacks (git-spice / branch base), sort by last-commit freshness, and get optional AI summaries via Cursor SDK. Tokens stay server-side.

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

| Variable           | Required | Description                                              | Where to get it                                                                                                       |
| ------------------ | -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`     | yes      | PAT with repo/PR read access                             | GitHub → **Settings** → **Developer settings** → **[Personal access tokens](https://github.com/settings/tokens)**     |
| `GITHUB_USERNAME`  | yes      | Your GitHub login (`author:` filter)                     | GitHub profile URL                                                                                                    |
| `GITHUB_ORG`       | no       | Fallback org for merged ancestor lookups                 | Org slug from GitHub URLs                                                                                             |
| `LINEAR_API_KEY`   | no       | Personal API key — tickets, priority, status             | Linear → **Settings** → **[Security & access](https://linear.app/settings/account/security)** → **Personal API keys** |
| `LINEAR_TEAM`      | no       | Team key filter (e.g. `ENG`)                             | Short key next to the team name                                                                                       |
| `LINEAR_WORKSPACE` | no       | Workspace slug for ticket links                          | From any issue URL: `linear.app/**workspace**/issue/…`                                                                |
| `CURSOR_API_KEY`   | no       | Cursor SDK — AI summaries + daily brief                  | Cursor → **[Dashboard → Integrations](https://cursor.com/dashboard/integrations)**                                    |
| `SLACK_USER_ID`    | no       | Your Slack member ID (daily Slack search via Cursor MCP) | Slack → profile → **⋯** → **Copy member ID**                                                                          |

On startup the server prints which vars are set (`✓` / `–`).

## What you get

### Left panel — PR stacks

- **Tree view** of open PRs (git-spice comments preferred), merged ancestors in purple
- **Status icons** — ready, rebase, CI fail, approved, changes requested, commented, draft
- **Linear metadata** — priority, status, labels on each group
- **Freshness sort** — most recently pushed stacks first
- **Archive** — stacks idle 7+ days collapse into an expandable section
- **Conversation chips** — linked Cursor agent chats per stack (matched by ticket ID, PR number, or branch name from local `conversation-search.db`). Click copies the title. Scaled cost shown inline.

### Right panel — tabbed sidebar

- **Daily** — Yesterday / Today standup notes (Opus via Cursor SDK + optional Slack MCP)
- **Tickets** — Linear tickets in progress with no linked PR
- **Usage by models** — per-model cost and token count for the billing cycle
- **Usage by conversations** — per-conversation cost, request count, last activity

### Top strip

- PR stats: open, ready, rebase, CI failing
- Cursor billing: `included + bonus + on-demand = total`, reset date, auto-refresh 60s

## How it works

### Cursor usage (zero tokens)

Reads billing data from `api2.cursor.sh` using the local auth token (from Cursor's `state.vscdb`). Per-conversation costs aggregate from paginated usage events. Cached 5 min in `data/usage-cache.json`. Raw internal costs scale proportionally to match the billed total.

### Conversation linking (zero tokens)

Reads Cursor's `conversation-search.db` (SQLite FTS5). Searches ticket IDs in body text, ticket slugs in branch names, and exact head-ref matches. Sub-millisecond.

### Daily standup

No Slack app install needed — sign into Slack MCP in Cursor once, set `SLACK_USER_ID`.

The SDK agent runs with `settingSources: plugins,user` (separate from the IDE chat). Check `[daily] Slack tools on agent:` in Vite logs.

1. Leave `npm run dev` running (or press **↻** on the Daily tab).
2. With `CURSOR_API_KEY`: AI-generated from GitHub + Linear + Slack.
3. Without: heuristic brief from GitHub/Linear data.

## Project layout

```
src/                  React UI (App, types, API client, CSS)
server/
  github.ts           GitHub REST + GraphQL
  linear.ts           Linear GraphQL
  stacks.ts           Stack detection, grouping, ticket attachment
  dashboard.ts        Orchestrator — groups, summaries, conversations, costs
  daily.ts            Daily standup generation (Cursor SDK agent)
  summaries.ts        AI stack summaries (Cursor SDK)
  conversations.ts    Local SQLite conversation lookup
  cursor-usage.ts     Billing cycle + per-conversation cost aggregation
  plugin.ts           Vite plugin — /api/dashboard, /api/daily, /api/usage
  env.ts              Server-side env validation
data/                 Local caches (gitignored)
.env                  Your secrets (gitignored)
```

## Tips

- Use your own GitHub token and username — the dashboard shows that author's PRs.
- Linear, Cursor, Slack are optional. The PR list works with GitHub alone.
- Cursor usage reads your local auth token automatically — no extra config.
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
