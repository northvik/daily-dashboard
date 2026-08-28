import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDashboard, fetchDaily, refreshDaily } from "./api";
import type {
  DashboardData,
  DailyData,
  DailySubject,
  DailyTag,
  PR,
  PRGroup,
  PRStatus,
} from "./types";
import "./index.css";

const REFRESH_MS = 60_000;
const DAILY_FORMAT_VERSION = 3;

/* ── Icons ───────────────────────────────────────────────────────── */

function IconRebase() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="status-icon rebase">
      <path d="M5.5 3.5L8 1l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 1v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3 10l2.5 2.5L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.5 12.5V15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 8c0 2.2 1.8 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="status-icon ready">
      <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm3.78 4.97a.75.75 0 00-1.06 0L7 8.69 5.28 6.97a.75.75 0 10-1.06 1.06l2.25 2.25a.75.75 0 001.06 0l4.25-4.25a.75.75 0 000-1.06z" />
    </svg>
  );
}

function IconCross() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="status-icon ci-fail">
      <path d="M8 0a8 8 0 110 16A8 8 0 018 0zm3.03 4.97a.75.75 0 00-1.06 0L8 6.94 5.97 4.97a.75.75 0 10-1.06 1.06L6.94 8l-2.03 1.97a.75.75 0 101.06 1.06L8 9.06l2.03 2.03a.75.75 0 101.06-1.06L9.06 8l2.03-2.03a.75.75 0 000-1.06z" />
    </svg>
  );
}

function IconDraft() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="status-icon draft">
      <path d="M8 0a8 8 0 110 16A8 8 0 018 0zM1.5 8a6.5 6.5 0 1013 0 6.5 6.5 0 00-13 0z" />
    </svg>
  );
}

function IconEye() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="status-icon review">
      <path d="M8 2c-2.8 0-5.2 1.7-7.4 4.7a.75.75 0 000 .6C2.8 10.3 5.2 12 8 12s5.2-1.7 7.4-4.7a.75.75 0 000-.6C13.2 3.7 10.8 2 8 2zm0 8a3 3 0 110-6 3 3 0 010 6zm0-4.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z" />
    </svg>
  );
}

function IconMerged() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="status-icon merged">
      <path d="M5 3.254V3.25a.75.75 0 110-1.5.75.75 0 010 1.5zm.45 1.207a2.25 2.25 0 10-1.4.006v7.066a2.25 2.25 0 101.5 0V9.464a4.016 4.016 0 003.206-1.778l.054-.088a2.25 2.25 0 10-1.293-.661l-.038.065A2.516 2.516 0 015.45 4.46zM11.2 5.252a.75.75 0 110-1.5.75.75 0 010 1.5zM5 13.252a.75.75 0 110-1.5.75.75 0 010 1.5z" />
    </svg>
  );
}

function IconApproved() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="status-icon approved">
      <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
    </svg>
  );
}

function IconChangesRequested() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="status-icon changes-requested">
      <path d="M1.705 8.005a.75.75 0 01.834.656 5.5 5.5 0 009.592 2.97l-1.204-1.204a.25.25 0 01.177-.427h3.646a.25.25 0 01.25.25v3.646a.25.25 0 01-.427.177l-1.38-1.38A7.001 7.001 0 011.05 8.84a.75.75 0 01.656-.834zM8 2.5a5.487 5.487 0 00-4.131 1.869l1.204 1.204A.25.25 0 014.896 6H1.25A.25.25 0 011 5.75V2.104a.25.25 0 01.427-.177l1.38 1.38A7.001 7.001 0 0114.95 7.16a.75.75 0 11-1.49.178A5.5 5.5 0 008 2.5z" />
    </svg>
  );
}

function IconCommented() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="status-icon commented">
      <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75z" />
    </svg>
  );
}

function StatusIcon({ status, merged }: { status?: PRStatus; merged?: boolean }) {
  if (merged) return <IconMerged />;
  switch (status) {
    case "ready": return <IconCheck />;
    case "approved": return <IconApproved />;
    case "rebase": return <IconRebase />;
    case "ci-fail": return <IconCross />;
    case "changes-requested": return <IconChangesRequested />;
    case "commented": return <IconCommented />;
    case "review": return <IconEye />;
    case "draft": return <IconDraft />;
    default: return null;
  }
}

/* ── Tree ────────────────────────────────────────────────────────── */

interface TreeNode {
  pr: PR;
  children: TreeNode[];
}

function buildTree(prs: PR[]): TreeNode[] {
  const sorted = [...prs].sort((a, b) => a.depth - b.depth);
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];

  for (const pr of sorted) {
    const node: TreeNode = { pr, children: [] };
    while (stack.length > pr.depth) stack.pop();
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }
  return roots;
}

function PRLeaf({ pr }: { pr: PR }) {
  return (
    <div className="pr-row">
      <StatusIcon status={pr.status} merged={pr.merged} />
      <span className="pr-meta">{pr.repo}#{pr.number}</span>
      <a href={pr.url} target="_blank" rel="noopener" className={`pr-title-link${pr.merged ? " merged" : ""}`}>
        {pr.title}
      </a>
      {pr.ticket && pr.ticketUrl && (
        <a href={pr.ticketUrl} target="_blank" rel="noopener" className="pr-ticket-link">
          {pr.ticket}
        </a>
      )}
    </div>
  );
}

function TreeNodeView({ node }: { node: TreeNode }) {
  if (node.children.length === 0) {
    return (
      <li className={node.pr.merged ? "merged" : undefined}>
        <PRLeaf pr={node.pr} />
      </li>
    );
  }
  return (
    <li className={node.pr.merged ? "merged" : undefined}>
      <details open>
        <summary><PRLeaf pr={node.pr} /></summary>
        <ul>
          {node.children.map((child) => (
            <TreeNodeView key={`${child.pr.repo}#${child.pr.number}`} node={child} />
          ))}
        </ul>
      </details>
    </li>
  );
}

/* ── Group card ──────────────────────────────────────────────────── */

function GroupCard({ group }: { group: PRGroup }) {
  const tree = group.prs.length > 0 ? buildTree(group.prs) : [];
  const ticket = group.ticket;
  const priClass = ticket?.priority.toLowerCase().replace(/\s+/g, "") ?? "";
  const openPRs = group.prs.filter((p) => !p.merged);
  const ticketId = ticket?.id ?? group.prs.find((p) => p.ticket)?.ticket;
  const ticketUrl = ticket?.url ?? group.prs.find((p) => p.ticketUrl)?.ticketUrl;

  return (
    <div className="stack-card">
      <div className="stack-header">
        <div className="stack-header-left">
          {ticketId && ticketUrl && (
            <a href={ticketUrl} target="_blank" rel="noopener" className="stack-ticket-id">
              {ticketId}
            </a>
          )}
          <span className="stack-name">{group.name}</span>
          {group.crossRepo && <span className="stack-badge">cross-repo</span>}
        </div>
        <div className="stack-header-right">
          {ticket?.labels?.map((l) => (
            <span key={l} className="ticket-label">{l}</span>
          ))}
          {ticket && <span className={`ticket-priority ${priClass}`}>{ticket.priority}</span>}
          {ticket && <span className="ticket-status">{ticket.status}</span>}
          {openPRs.length > 0 && (
            <span className="stack-badge">
              {openPRs.length} PR{openPRs.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
      {group.description && <div className="stack-desc-row">{group.description}</div>}
      {tree.length > 0 && (
        <div className="stack-body">
          <ul className="tree">
            {tree.map((node) => (
              <TreeNodeView key={`${node.pr.repo}#${node.pr.number}`} node={node} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ── Legend ───────────────────────────────────────────────────────── */

function Legend() {
  return (
    <div className="legend">
      <span className="legend-item"><IconCheck /> Ready</span>
      <span className="legend-item"><IconApproved /> Approved</span>
      <span className="legend-item"><IconRebase /> Needs rebase</span>
      <span className="legend-item"><IconCross /> CI failing</span>
      <span className="legend-item"><IconChangesRequested /> Changes requested</span>
      <span className="legend-item"><IconCommented /> Commented</span>
      <span className="legend-item"><IconEye /> Awaiting review</span>
      <span className="legend-item"><IconDraft /> Draft</span>
      <span className="legend-item"><IconMerged /> Merged</span>
    </div>
  );
}

/* ── Daily panel ─────────────────────────────────────────────────── */

function SubjectTags({ tags }: { tags?: DailyTag[] }) {
  if (!tags?.length) return null;
  return (
    <div className="daily-tags">
      {tags.slice(0, 3).map((t, i) => (
        <span key={t.label + i}>
          {i > 0 && <span className="daily-tag-sep">·</span>}
          {t.url ? (
            <a href={t.url} target="_blank" rel="noopener" className="daily-tag">
              {t.label}
            </a>
          ) : (
            <span className="daily-tag">{t.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function SubjectBlock({ subject }: { subject: DailySubject }) {
  return (
    <div className="daily-subject">
      <div className="daily-subject-title">{subject.title}</div>
      {subject.bullets.length > 0 && (
        <ul className="daily-subject-bullets">
          {subject.bullets.map((b, i) => (
            <li
              key={i}
              className={`daily-subject-bullet${b.tone === "blocked" ? " blocked" : ""}${b.tone === "done" ? " done" : ""}`}
            >
              {b.text}
            </li>
          ))}
        </ul>
      )}
      <SubjectTags tags={subject.tags} />
    </div>
  );
}

function DailyColumn({
  title,
  subjects,
  empty,
}: {
  title: string;
  subjects: DailySubject[];
  empty: string;
}) {
  return (
    <section className="daily-col">
      <h3>{title}</h3>
      {subjects.length === 0 ? (
        <p className="daily-empty-section">{empty}</p>
      ) : (
        <div className="daily-subjects">
          {subjects.map((s, i) => (
            <SubjectBlock key={`${title}-${s.title}-${i}`} subject={s} />
          ))}
        </div>
      )}
    </section>
  );
}

function DailyPanel() {
  const [daily, setDaily] = useState<DailyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoRegenRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const d = await fetchDaily();
      setDaily(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => {
      void fetchDaily().then((d) => {
        if (d) setDaily(d);
      });
    }, 120_000);
    return () => clearInterval(id);
  }, [load]);

  // One free regen when format is outdated
  useEffect(() => {
    if (!daily || autoRegenRef.current) return;
    if ((daily.formatVersion ?? 0) >= DAILY_FORMAT_VERSION) return;
    autoRegenRef.current = true;
    setRefreshing(true);
    void refreshDaily()
      .then(setDaily)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRefreshing(false));
  }, [daily]);

  const onRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const d = await refreshDaily();
      setDaily(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const generatedLabel = daily
    ? new Date(daily.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  const alerts = (daily?.alerts ?? []).slice(0, 2);

  return (
    <aside className="daily-panel">
      <div className="daily-header">
        <h2>Daily</h2>
        <div className="daily-header-meta">
          {generatedLabel && <span>{generatedLabel}</span>}
          <button
            className="refresh-btn"
            onClick={onRefresh}
            disabled={refreshing}
            title="Regenerate daily"
          >
            {refreshing ? "…" : "↻"}
          </button>
        </div>
      </div>

      {error && <div className="daily-error">{error}</div>}
      {loading && !daily && <div className="daily-empty">Preparing…</div>}
      {!loading && !daily && (
        <div className="daily-empty">No daily yet — hit ↻</div>
      )}

      {daily && (
        <div className="daily-grid">
          {alerts.length > 0 && (
            <div className="daily-alerts">
              {alerts.map((a, i) => (
                <div key={i} className={`daily-alert-inline ${a.type}`}>
                  {a.message}
                </div>
              ))}
            </div>
          )}
          <DailyColumn title="Yesterday" subjects={daily.yesterday} empty="—" />
          <DailyColumn title="Today" subjects={daily.today} empty="—" />
        </div>
      )}
    </aside>
  );
}

/* ── App ─────────────────────────────────────────────────────────── */

export default function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setLoading(true);
      setError(null);
      const d = await fetchDashboard(controller.signal);
      if (!controller.signal.aborted) setData(d);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [refresh]);

  const openPRs = data?.groups.flatMap((g) => g.prs).filter((p) => !p.merged) ?? [];
  const readyCount = openPRs.filter((p) => p.status === "ready").length;
  const rebaseCount = openPRs.filter((p) => p.status === "rebase").length;
  const ciFailCount = openPRs.filter((p) => p.status === "ci-fail").length;
  const ticketCount = data?.groups.filter((g) => g.ticket).length ?? 0;

  return (
    <>
      <div className="header">
        <h1>PR Dashboard</h1>
        <div className="header-meta">
          {data && <span>Updated {data.fetchedAt.toLocaleTimeString()}</span>}
          <button className="refresh-btn" onClick={refresh} disabled={loading}>
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">⚠ {error}</div>}

      <div className="stats-row">
        <span className="stat blue">{openPRs.length} Open PRs</span>
        {readyCount > 0 && <span className="stat green">✓ {readyCount} Ready</span>}
        {rebaseCount > 0 && <span className="stat orange">↑ {rebaseCount} Need rebase</span>}
        {ciFailCount > 0 && <span className="stat red">✕ {ciFailCount} CI failing</span>}
        {ticketCount > 0 && <span className="stat purple">{ticketCount} Tickets</span>}
      </div>

      <Legend />

      {!data && loading && <div className="loading">Fetching PRs and tickets…</div>}

      <div className="dashboard-layout">
        <div className="dashboard-main">
          {data && (
            <div className="group-list">
              {data.groups.map((g) => (
                <GroupCard key={g.ticket?.id ?? `${g.name}-${g.prs[0]?.number}`} group={g} />
              ))}
            </div>
          )}
        </div>
        <DailyPanel />
      </div>
    </>
  );
}
