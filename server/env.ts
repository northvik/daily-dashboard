/**
 * Server-side env — loaded from process.env (Vite injects .env via loadEnv).
 * No personal defaults; missing required vars fail fast with a clear message.
 */

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `Missing ${name}. Copy .env.example → .env and fill in your values.`,
    );
  }
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

/** Call once at server start to validate required config. */
export function assertEnv(): void {
  required("GITHUB_TOKEN");
  required("GITHUB_USERNAME");
  // Linear / Cursor / Slack are optional — features degrade gracefully
}

export const env = {
  get githubToken() {
    return required("GITHUB_TOKEN");
  },
  get githubUsername() {
    return required("GITHUB_USERNAME");
  },
  /** Fallback org when repo owner can't be resolved from search results */
  get githubOrg() {
    return optional("GITHUB_ORG");
  },
  get linearApiKey() {
    return optional("LINEAR_API_KEY");
  },
  get linearTeam() {
    return optional("LINEAR_TEAM");
  },
  /** Linear workspace slug for ticket URLs, e.g. "acme" → linear.app/acme/issue/… */
  get linearWorkspace() {
    return optional("LINEAR_WORKSPACE");
  },
  get cursorApiKey() {
    return optional("CURSOR_API_KEY");
  },
  get slackUserId() {
    return optional("SLACK_USER_ID");
  },
};

export function linearIssueUrl(ticketId: string): string {
  const ws = env.linearWorkspace;
  if (ws) return `https://linear.app/${ws}/issue/${ticketId}`;
  return `https://linear.app/issue/${ticketId}`;
}

export function logEnvStatus(): void {
  const ok = (v: string) => (v ? "✓" : "–");
  console.log("[env] GITHUB_TOKEN      ", ok(process.env.GITHUB_TOKEN ?? ""));
  console.log("[env] GITHUB_USERNAME   ", process.env.GITHUB_USERNAME || "(missing)");
  console.log("[env] GITHUB_ORG        ", process.env.GITHUB_ORG || "(optional)");
  console.log("[env] LINEAR_API_KEY    ", ok(process.env.LINEAR_API_KEY ?? ""));
  console.log("[env] LINEAR_TEAM       ", process.env.LINEAR_TEAM || "(optional)");
  console.log("[env] LINEAR_WORKSPACE  ", process.env.LINEAR_WORKSPACE || "(optional)");
  console.log("[env] CURSOR_API_KEY    ", ok(process.env.CURSOR_API_KEY ?? ""));
  console.log("[env] SLACK_USER_ID     ", process.env.SLACK_USER_ID || "(optional)");
}
