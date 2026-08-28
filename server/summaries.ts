/**
 * Cursor SDK summary enrichment with disk cache (4h TTL).
 * Runs server-side only. Cache lives in data/ (gitignored).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SummaryOverride } from "./stacks.ts";
import { env } from "./env.ts";

const CACHE_FILE = "data/stack-overrides.json";
const MAX_AGE_MS = 4 * 60 * 60 * 1000;

interface CachedEntry extends SummaryOverride {
  cachedAt: number;
}

function loadCache(cwd: string): CachedEntry[] {
  try {
    return JSON.parse(readFileSync(resolve(cwd, CACHE_FILE), "utf-8"));
  } catch {
    return [];
  }
}

function saveCache(cwd: string, entries: CachedEntry[]): void {
  mkdirSync(resolve(cwd, "data"), { recursive: true });
  writeFileSync(resolve(cwd, CACHE_FILE), JSON.stringify(entries, null, 2) + "\n");
}

/**
 * Enrich multi-PR groups with AI-generated summaries.
 * Only calls Cursor for stacks not already cached (or cached >4h ago).
 */
export async function enrichSummaries(
  stacks: { ticket: string; prs: string[] }[],
): Promise<SummaryOverride[]> {
  if (stacks.length === 0) return [];

  const cwd = process.cwd();
  const cache = loadCache(cwd);
  const cacheMap = new Map(cache.map((e) => [e.ticket, e]));
  const now = Date.now();

  const fresh: CachedEntry[] = [];
  const stale: { ticket: string; prs: string[] }[] = [];

  for (const stack of stacks) {
    const cached = cacheMap.get(stack.ticket);
    if (cached && now - cached.cachedAt < MAX_AGE_MS) {
      fresh.push(cached);
    } else {
      stale.push(stack);
    }
  }

  if (stale.length === 0) return fresh;

  const apiKey = env.cursorApiKey;
  if (!apiKey) {
    const fallback = stale.map((s) => cacheMap.get(s.ticket)).filter(Boolean) as CachedEntry[];
    return [...fresh, ...fallback];
  }

  console.log(
    `[summaries] ${fresh.length} cached, ${stale.length} to enrich: ${stale.map((s) => s.ticket).join(", ")}`,
  );

  const stackList = stale
    .map((s) => `${s.ticket} (${s.prs.length} PRs):\n${s.prs.map((t) => `  - ${t}`).join("\n")}`)
    .join("\n\n");

  const prompt = [
    "For each PR stack, return a JSON array of {ticket, name, description}.",
    'name: 2-4 word human label (e.g. "Signup Hardening").',
    "description: one sentence explaining the stack goal.",
    "Return ONLY the JSON array, no markdown, no commentary.\n",
    stackList,
  ].join("\n");

  try {
    const { Agent } = await import("@cursor/sdk");
    const result = await Agent.prompt(prompt, {
      apiKey,
      model: { id: "claude-opus-4-6" },
      local: { cwd },
    });

    if (result.status !== "finished" || !result.result) {
      console.error("[summaries] Cursor run status:", result.status);
      return fresh;
    }

    const jsonMatch = result.result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("[summaries] Could not parse JSON from response");
      return fresh;
    }

    const parsed: SummaryOverride[] = JSON.parse(jsonMatch[0]);
    const stamped: CachedEntry[] = parsed.map((e) => ({ ...e, cachedAt: now }));

    for (const entry of stamped) cacheMap.set(entry.ticket, entry);
    saveCache(cwd, [...cacheMap.values()]);

    return [...fresh, ...stamped];
  } catch (err) {
    console.error("[summaries] Error:", err);
    return fresh;
  }
}
