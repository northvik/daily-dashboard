# PR Dashboard

Local dashboard for **your** open GitHub PRs and in-progress Linear tickets, with a daily standup panel on the side.

PRs are grouped into stacks (git-spice / branch base), sorted by Linear priority, and optionally summarized by Cursor. Tokens never leave the Vite server — nothing is shipped to the browser.

## Quick start

```sh
git clone <repo-url> && cd pr-dashboard
cp .env.example .env
# edit .env — at minimum set GITHUB_TOKEN and GITHUB_USERNAME

npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Environment variables

| Variable | Required | Description | Where to get it |
|----------|----------|-------------|-----------------|
| `GITHUB_TOKEN` | yes | PAT with access to your repos / PRs (`repo` or fine-grained PR read) | GitHub → **Settings** → **Developer settings** → **[Personal access tokens](https://github.com/settings/tokens)** → generate (classic or fine-grained) |
| `GITHUB_USERNAME` | yes | Your GitHub login (`author:` search filter) | GitHub avatar → profile URL, e.g. `https://github.com/**you**` |
| `GITHUB_ORG` | no | Fallback org for merged ancestor PR lookups | Org slug from GitHub URLs, e.g. `https://github.com/**my-org**/…` |
| `LINEAR_API_KEY` | no | Personal API key — tickets, priority, status | Linear → **Settings** → **Account** → **[Security & access](https://linear.app/settings/account/security)** → **Personal API keys** → Create key |
| `LINEAR_TEAM` | no | Team key filter (e.g. `ENG`) | Linear team URL or settings — short key next to the team name (often 2–4 letters) |
| `LINEAR_WORKSPACE` | no | Workspace slug for ticket links | From any issue URL: `https://linear.app/**workspace**/issue/…` |
| `CURSOR_API_KEY` | no | Cursor SDK — AI stack summaries + daily brief | Cursor → **[Dashboard → Integrations](https://cursor.com/dashboard/integrations)** → create / copy API key |
| `SLACK_USER_ID` | no | Your Slack member id (daily Slack search via Cursor MCP) | Slack → profile → **⋯** → **Copy member ID** (looks like `U08ABCDEF`) |

On startup the server prints which vars are set (`✓` / `–`).

No Slack **app** install is required for Daily: sign into the Slack MCP inside Cursor once, set `SLACK_USER_ID`, and the agent reuses that session.

## What you get

- **Stacks** — open PRs as a tree (git-spice comments preferred), merged ancestors in purple
- **Status icons** — ready, rebase, CI fail, approved, changes requested, commented, draft
- **Linear** — priority / status / labels on each group when configured
- **Daily panel** — Yesterday / Today subject notes (Opus via Cursor SDK + optional Slack MCP)
- **Auto-refresh** — dashboard every 60s; daily cron ~8:00 while `npm run dev` is running

## Daily standup

1. Leave `npm run dev` running (or hit **↻** on the Daily panel).
2. With `CURSOR_API_KEY`, notes are AI-generated from GitHub + Linear (+ Slack if `SLACK_USER_ID` is set and Slack is signed in inside Cursor).
3. Without Cursor, a simple heuristic brief is used.
4. Cache: `data/daily-YYYY-MM-DD.json` and `data/stack-overrides.json` (gitignored).

## Project layout

```
src/        React UI
server/     Vite middleware APIs (GitHub, Linear, daily, summaries)
data/       Local caches (gitignored)
.env        Your secrets (gitignored) — copy from .env.example
```

## Tips for teammates

- Use your **own** GitHub token and username — the dashboard shows that author’s PRs.
- Linear / Cursor / Slack are optional; the PR list works with GitHub alone.
- This is a **local dev tool** (`configureServer`). There is no production deploy path.
- Don’t commit `.env` or anything under `data/`.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start UI + APIs |
| `npm run build` | Typecheck + production client build (APIs won’t be present) |
| `npm run lint` | oxlint |
