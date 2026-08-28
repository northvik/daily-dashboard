/**
 * Linear API layer.
 * Runs server-side only (Vite middleware).
 */

import { env } from "./env.ts";

/* ── Types ───────────────────────────────────────────────────────── */

export interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  state: { name: string; type: string };
  project?: { name: string } | null;
  labels: { nodes: { name: string }[] };
  updatedAt?: string;
  completedAt?: string | null;
}

const ISSUE_FIELDS = `
  identifier title url priority priorityLabel
  state { name type }
  project { name }
  labels { nodes { name } }
  updatedAt completedAt
`;

/* ── Public API ──────────────────────────────────────────────────── */

export async function fetchLinearIssues(
  stateType: "started",
): Promise<LinearIssue[]> {
  if (!env.linearApiKey) return [];

  const filter: Record<string, unknown> = {
    assignee: { isMe: { eq: true } },
    state: { type: { eq: stateType } },
  };
  if (env.linearTeam) {
    filter.team = { key: { eq: env.linearTeam } };
  }

  return queryIssues(filter);
}

/**
 * Issues assigned to me updated on or after `sinceISO`.
 */
export async function fetchLinearUpdatedSince(
  sinceISO: string,
): Promise<LinearIssue[]> {
  if (!env.linearApiKey) return [];

  const filter: Record<string, unknown> = {
    assignee: { isMe: { eq: true } },
    updatedAt: { gte: sinceISO },
  };
  if (env.linearTeam) {
    filter.team = { key: { eq: env.linearTeam } };
  }

  return queryIssues(filter);
}

async function queryIssues(
  filter: Record<string, unknown>,
): Promise<LinearIssue[]> {
  const query = `
    query($filter: IssueFilter) {
      issues(filter: $filter, first: 50, orderBy: updatedAt) {
        nodes { ${ISSUE_FIELDS} }
      }
    }
  `;

  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: env.linearApiKey,
    },
    body: JSON.stringify({ query, variables: { filter } }),
  });

  if (!res.ok) {
    console.warn(`[linear] ${res.status}: ${await res.text()}`);
    return [];
  }
  const json = await res.json() as { data?: { issues?: { nodes?: LinearIssue[] } } };
  return json.data?.issues?.nodes ?? [];
}
