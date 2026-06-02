"use client";

/**
 * /projects/[id] — Twin Dashboard.
 *
 * Default landing for a project. One round-trip to /api/projects/[id]/dashboard
 * pulls the full picture: live status, health window, cost rollup, backlog
 * counts, and a sprint timeline. The page renders four panels at the top
 * (Status / Health / Cost / Backlog) and a chronological sprint timeline
 * below.
 *
 * Server does the math; the client just displays it. No charts library —
 * counts and inline sparkline-style bars (CSS) are enough for slice 1.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Activity, AlertTriangle, ArrowLeft, Bot, Check, CheckCircle2, ClipboardList,
  Clock, DollarSign, FileText, GitBranch, Info, ListTodo, Loader2, Pause, Play,
  RefreshCw, Settings, Sparkles, TrendingUp, Wand2, XCircle,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";
import PageShell from "@/components/PageShell";
import { IntentBadge } from "@/components/IntentBadge";
import { FAILURE_CLASS_LABELS, isFailureClass } from "@/lib/sprint-diagnostics";
import {
  CONTEXT_SOURCE_LABELS, CONTEXT_SOURCE_ORDER,
  formatBytes, sumBudget,
  type ContextBudget,
} from "@/lib/context-budget";
import { TimelineRow } from "@/components/SprintTimeline";
import {
  CostPanel, AgentModelTable, UsageByModel, AgentsBreakdown,
} from "@/components/CostBreakdown";
import {
  StatusPanel, HealthPanel, BacklogPanel,
} from "@/components/DashboardPanels";
import {
  PrdPanel, MemoryPanel, BudgetPanel,
} from "@/components/DashboardSecondary";

export type Verdict = "success" | "no-output" | "partial" | "failed" | null;

export interface DashboardData {
  project: {
    id: string;
    name: string;
    slug: string;
    status: string;
    locked: boolean;
    execution_mode: "manual" | "kanban_manual" | "kanban_auto";
    settings: Record<string, unknown> | null;
    factory: { id: string; slug: string; name: string };
  };
  now: {
    current_sprint: null | {
      id: string;
      sprint_num: number;
      status: string;
      intent: string | null;
      started_at: string;
      briefing: string | null;
    };
    project_status: string;
    execution_mode: "manual" | "kanban_manual" | "kanban_auto";
    paused: boolean;
    awaiting_approval: boolean;
    halt_reason: string | null;
  };
  health: {
    success_rate: number | null;
    window_days: number;
    window_total: number;
    consecutive_failures: number;
    consecutive_no_output: number;
    needs_human_count: number;
    recent: Array<{
      sprint_num: number;
      verdict: Verdict;
      intent: string | null;
      completed_at: string | null;
      needs_human: boolean;
      failure_class: string | null;
    }>;
    /** BL-26 Phase 1 — count of failures by class within the health window. */
    failure_breakdown: Record<string, number>;
  };
  memory: {
    proposed_count:  number;
    approved_count:  number;
    rejected_count:  number;
    archived_count:  number;
    approved_by_type: { decision: number; convention: number; gotcha: number; dependency: number };
  };
  budget: {
    enabled:           boolean;
    scope:             "api_only" | "all";
    action:            "warn" | "halt";
    month_total_usd:   number;
    day_total_usd:     number;
    monthly_cap:       number | null;
    daily_cap:         number | null;
    status:            "ok" | "warn" | "halt";
    reason:            string | null;
    pct_of_cap:        number | null;
  };
  cost: {
    tokens_in_total:  number;
    tokens_out_total: number;
    usd_total:        number;
    usd_real:         number;
    usd_estimated:    number;
    runs_real:        number;
    runs_subscription: number;
    runs_unknown_auth: number;
    by_day: Array<{ day: string; tokens_in: number; tokens_out: number; usd: number; sprint_count: number }>;
    by_sprint_recent: Array<{ sprint_num: number; tokens_in: number; tokens_out: number; usd: number; agent_count: number }>;
    by_model: Array<{
      key:        string;
      kind:       "cli" | "api" | "unknown";
      cli:        string | null;
      provider:   string | null;
      model:      string | null;
      runs:       number;
      tokens_in:  number;
      tokens_out: number;
      usd:        number;
      inferred:   boolean;
    }>;
    /** Cross-tab agent × runtime — BL-26 phase 2. Drives the
     *  "is Opus paying off for this role?" view. */
    by_agent_model: Array<{
      agent:       string;
      runtime:     string;       // e.g. "cli:claude-code:opus"
      kind:        "cli" | "api" | "unknown";
      cli:         string | null;
      model:       string | null;
      runs:        number;
      sprints:     number;
      tokens_in:   number;
      tokens_out:  number;
      usd:         number;
      usd_per_run: number;
      inferred:    boolean;
    }>;
  };
  backlog: {
    todo: number; doing: number; done: number; cancelled: number; total: number;
    by_tag: Array<{ tag: string; todo: number; doing: number; done: number; cancelled: number; total: number }>;
    stale_doing: Array<{ id: string; title: string; since: string }>;
    last_review_marker: null | {
      agent_slug: string;
      action:     "no_change" | "added" | "refined" | "mixed" | "failed" | string;
      summary:    string;
      created_at: string;
    };
  };
  /** PRD authoring summary — Slice 1 of Discovery / Product-Manager. */
  prd: {
    has_content:        boolean;
    length_chars:       number;
    status:             "draft" | "reviewed" | "approved" | null;
    authored_at:        string | null;
    authored_by_agent:  string | null;
    authored_by_sprint: number | null;
    excerpt:            string | null;
  };
  agents: Array<{
    agent:          string;
    runs:           number;
    runs_failed:    number;
    runs_discovery: number;
    runs_execution: number;
    usd_discovery:  number;
    usd_execution:  number;
    tokens_in:      number;
    tokens_out:     number;
    usd:            number;
    avg_wall_ms:    number | null;
    total_wall_ms:  number;
    sprints:        number;
    last_run:       string | null;
    runtimes:       Array<{ key: string; runs: number; usd: number }>;
  }>;
  timeline: Array<{
    id: string;
    sprint_num: number;
    status: string;
    intent: string | null;
    verdict: Verdict;
    reason: string | null;
    started_at: string;
    completed_at: string | null;
    briefing: string | null;
    usd: number;
    agent_count: number;
    tokens_in: number;
    tokens_out: number;
    needs_human: boolean;
    auto_composed: boolean;
    auto_acknowledged: boolean;
    pending_push: { branch?: string; tag?: string } | null;
    trigger_source: string | null;
  }>;
}

export default function TwinDashboardPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const { session: authSession, loading: authLoading } = useAuth();

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !authSession) router.replace("/login");
  }, [authLoading, authSession, router]);

  const reload = useCallback(async () => {
    if (!authSession || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/dashboard`, {
        headers: { Authorization: `Bearer ${authSession.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Load failed (${res.status})`);
      }
      const payload = await res.json() as DashboardData;
      // PIP inception scratchpads route to their dedicated dashboard
      // — the generic Twin Dashboard is built around backlog / sprint
      // timeline / cost rollup which don't apply to one-shot inception
      // runs. /api/projects already filters them out of the list view;
      // the redirect here closes the direct-link gap.
      const kind = (payload.project.settings as Record<string, unknown> | null)?.kind;
      if (kind === "pip-inception") {
        router.replace(`/pip/projects/${projectId}`);
        return;
      }
      setData(payload);
    } catch (e) { setError((e as Error).message); }
    finally       { setLoading(false); }
  }, [authSession, projectId, router]);

  useEffect(() => { void reload(); }, [reload]);

  // ── Soft-lock claim + heartbeat (multi-user awareness) ─────────────────
  // Claims the editor slot on mount + every 2 min. If another operator
  // is already editing, the claim returns 409 with their info — we
  // surface a banner with a Take-over button. The lock doesn't block
  // any action; it warns about concurrent work.
  const [editLockHolder, setEditLockHolder] = useState<{
    user_id: string; email: string | null; started_at: string;
  } | null>(null);
  const [iAmHolder, setIAmHolder] = useState(false);

  useEffect(() => {
    if (!authSession?.access_token || !projectId) return;
    let cancelled = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    async function claim(force = false) {
      try {
        const res = await fetch(`/api/projects/${projectId}/edit-claim`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${authSession!.access_token}`, "Content-Type": "application/json" },
          body:    JSON.stringify({ force }),
        });
        const body = await res.json().catch(() => ({})) as {
          ok?: boolean;
          holder?: { user_id: string; email: string | null; started_at: string };
        };
        if (cancelled) return;
        if (res.status === 409 && body.holder) {
          setEditLockHolder(body.holder);
          setIAmHolder(false);
          return;
        }
        if (res.ok && body.holder) {
          setEditLockHolder(body.holder);
          setIAmHolder(true);
        }
      } catch { /* swallow — soft lock is best-effort */ }
    }

    async function heartbeat() {
      try {
        const res = await fetch(`/api/projects/${projectId}/edit-heartbeat`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${authSession!.access_token}` },
        });
        if (res.status === 409 && !cancelled) {
          // Someone took over — stop heartbeating and show their info.
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
          setIAmHolder(false);
          await claim();
        }
      } catch { /* swallow */ }
    }

    void claim();
    heartbeatTimer = setInterval(() => { void heartbeat(); }, 2 * 60 * 1000);

    return () => {
      cancelled = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // Best-effort release on unmount.
      try {
        void fetch(`/api/projects/${projectId}/edit-release`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${authSession!.access_token}` },
          keepalive: true,
        });
      } catch { /* swallow */ }
    };
  }, [authSession, projectId]);

  async function takeOverEditLock() {
    if (!authSession?.access_token) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/edit-claim`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${authSession.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ force: true }),
      });
      const body = await res.json().catch(() => ({})) as {
        ok?: boolean;
        holder?: { user_id: string; email: string | null; started_at: string };
      };
      if (res.ok && body.holder) {
        setEditLockHolder(body.holder);
        setIAmHolder(true);
      }
    } catch { /* swallow */ }
  }

  if (loading && !data) {
    return (
      <PageShell active="projects">
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 32, color: "var(--subtext0)" }}>
          <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /> Loading dashboard…
        </div>
      </PageShell>
    );
  }
  if (error || !data) {
    return (
      <PageShell active="projects" title="Twin Dashboard">
        <div style={panelStyle}>
          <div style={{ color: "var(--red)", display: "flex", alignItems: "center", gap: 8 }}>
            <XCircle size={16} /> {error ?? "Dashboard unavailable"}
          </div>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      active="projects"
      title={data.project.name}
      description={
        <span>
          <span style={{ color: "var(--overlay0)" }}>Twin in </span>
          <Link href={`/factory-settings/${data.project.factory.id}`} style={{ color: "var(--blue)", textDecoration: "none" }}>
            {data.project.factory.name}
          </Link>
          {" · "}
          <span style={{ color: "var(--overlay0)" }}>{modeLabel(data.project.execution_mode)}</span>
        </span>
      }
      headerActions={
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => void reload()} title="Refresh" style={iconButtonStyle}>
            <RefreshCw size={14} />
          </button>
          <Link href="/projects" style={iconButtonStyle} title="Back to projects">
            <ArrowLeft size={14} /> All projects
          </Link>
          <Link href={`/projects/${data.project.id}/backlog`} style={primaryLinkStyle}>
            <ClipboardList size={14} /> Backlog
          </Link>
        </div>
      }
    >
      {/* ── Soft-lock awareness banner (multi-user) ────────────────── */}
      {editLockHolder && !iAmHolder && (
        <div style={{
          marginBottom: 16, padding: "10px 14px", borderRadius: 8,
          background: "rgba(254,166,73,0.10)", border: "1px solid rgba(254,166,73,0.30)",
          color: "var(--peach)", fontSize: 12, lineHeight: 1.5,
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        }}>
          <strong style={{ color: "var(--text)" }}>👤 Heads up:</strong>
          <span>
            <strong>{editLockHolder.email ?? "Another operator"}</strong> is editing this project
            (started {new Date(editLockHolder.started_at).toLocaleTimeString()}).
            You can keep working — actions aren&apos;t blocked — but coordinate before dispatching a sprint.
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => void takeOverEditLock()}
            style={{
              padding: "4px 10px", borderRadius: 5, border: "1px solid var(--peach)",
              background: "transparent", color: "var(--peach)",
              fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
            }}
            title="Claim the editor slot for yourself. The other operator's heartbeat will fail and they'll see you took over."
          >
            Take over
          </button>
        </div>
      )}

      {/* ── Top 4 panels ─────────────────────────────────────────────── */}
      <div style={panelGrid}>
        <StatusPanel data={data} authToken={authSession?.access_token ?? ""} onChanged={() => void reload()} />
        <HealthPanel data={data} />
        <CostPanel data={data} />
        <BacklogPanel data={data} />
      </div>

      {/* ── PRD summary — Slice 1 of Discovery / Product-Manager ─────── */}
      <div style={{ marginTop: 24 }}>
        <PrdPanel data={data} />
      </div>

      {/* ── Project memory (proposed entries to review) ─────────────── */}
      {(data.memory.proposed_count > 0 || data.memory.approved_count > 0) && (
        <div style={{ marginTop: 24 }}>
          <MemoryPanel
            data={data}
            authToken={authSession?.access_token ?? ""}
            onChanged={() => void reload()}
          />
        </div>
      )}

      {/* ── Budget brake (opt-in) ───────────────────────────────────── */}
      <div style={{ marginTop: 24 }}>
        <BudgetPanel data={data} onChanged={() => void reload()} authToken={authSession?.access_token ?? ""} />
      </div>

      {/* ── LLM usage breakdown ──────────────────────────────────────── */}
      {data.cost.by_model.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={sectionHeader}>
            <DollarSign size={14} /> LLM usage
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--overlay0)", fontWeight: 400 }}>
              by model · {data.cost.by_model.length} {data.cost.by_model.length === 1 ? "entry" : "entries"}
            </span>
          </div>
          <UsageByModel models={data.cost.by_model} totalUsd={data.cost.usd_total} />
        </div>
      )}

      {/* ── Agent × Model — BL-26 phase 2 telemetry ─────────────────── */}
      {data.cost.by_agent_model.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={sectionHeader}>
            <TrendingUp size={14} /> Cost by agent × model
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--overlay0)", fontWeight: 400 }}>
              {data.cost.by_agent_model.length} {data.cost.by_agent_model.length === 1 ? "pair" : "pairs"} · sortable by spend
            </span>
          </div>
          <AgentModelTable rows={data.cost.by_agent_model} totalUsd={data.cost.usd_total} />
        </div>
      )}

      {/* ── Agents breakdown ────────────────────────────────────────── */}
      {data.agents.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={sectionHeader}>
            <Bot size={14} /> Agents
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--overlay0)", fontWeight: 400 }}>
              {data.agents.length} {data.agents.length === 1 ? "agent" : "agents"}
            </span>
          </div>
          <AgentsBreakdown agents={data.agents} totalUsd={data.cost.usd_total} />
        </div>
      )}

      {/* ── Sprint timeline ─────────────────────────────────────────── */}
      <div style={{ marginTop: 24 }}>
        <div style={sectionHeader}>
          <Activity size={14} /> Sprint timeline
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--overlay0)", fontWeight: 400 }}>
            last {data.timeline.length} sprints
          </span>
        </div>
        {data.timeline.length === 0 ? (
          <div style={{ ...panelStyle, color: "var(--overlay0)", fontSize: 13 }}>
            No sprints yet. Click <strong>Start Sprint</strong> on the project card to dispatch the first one.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.timeline.map((s) => (
              <TimelineRow
                key={s.id}
                sprint={s}
                projectId={data.project.id}
                authToken={authSession?.access_token ?? ""}
                onChanged={() => void reload()}
              />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}

/* ════════════════════════════════════════════════════════════════════
 * STATUS panel — current sprint, halt reason, mode
 * ════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════
 * TIMELINE row — one sprint, click to expand the Sprint Review surface
 * ════════════════════════════════════════════════════════════════════ */


/* ════════════════════════════════════════════════════════════════════
 * USAGE-BY-MODEL — list with bars, separating CLIs from APIs
 * ════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════
 * MEMORY — proposed entries pending review + approved totals
 * ════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════
 * AGENTS — collapsible breakdown per agent
 * ════════════════════════════════════════════════════════════════════ */


const detailLabel: React.CSSProperties = {
  fontSize: 9, color: "var(--overlay0)",
  textTransform: "uppercase", letterSpacing: "0.06em",
  marginBottom: 2,
};

const detailValue: React.CSSProperties = {
  fontSize: 12, color: "var(--subtext0)",
};

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3600_000)}h ${Math.floor((ms % 3600_000) / 60_000)}m`;
}

/* ════════════════════════════════════════════════════════════════════
 * Small helpers + style constants
 * ════════════════════════════════════════════════════════════════════ */
function Chip({ children, color = "surface1", icon, title }: {
  children: React.ReactNode;
  color?: "surface1" | "peach" | "overlay1";
  icon?: React.ReactNode;
  title?: string;
}) {
  const palette: Record<string, { bg: string; fg: string }> = {
    surface1: { bg: "var(--surface0)",          fg: "var(--subtext0)" },
    peach:    { bg: "rgba(245,159,0,0.10)",     fg: "var(--peach)"    },
    overlay1: { bg: "var(--surface1)",          fg: "var(--overlay0)" },
  };
  const p = palette[color];
  return (
    <span title={title} style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 10, fontWeight: 600,
      padding: "2px 6px", borderRadius: 4,
      background: p.bg, color: p.fg,
    }}>
      {icon}{children}
    </span>
  );
}


// IntentBadge moved to components/IntentBadge.tsx so the Office sprint-history
// list (ProjectCard.SprintRow) can render the same badge without duplication.

function verdictColor(v: Verdict): string {
  switch (v) {
    case "success":   return "var(--green)";
    case "partial":   return "var(--peach)";
    case "no-output": return "var(--overlay1)";
    case "failed":    return "var(--red)";
    default:          return "var(--surface1)";
  }
}

function modeLabel(m: DashboardData["project"]["execution_mode"]): string {
  return m === "manual" ? "Manual" : m === "kanban_manual" ? "Kanban (manual)" : "Kanban (autonomous)";
}


function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1)    return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const panelGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 12,
};

const panelStyle: React.CSSProperties = {
  background: "var(--mantle)",
  border: "1px solid var(--surface0)",
  borderRadius: 10,
  padding: 16,
  fontFamily: "var(--font-sans)",
};

const panelHeader: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
  fontSize: 10, fontWeight: 700,
  color: "var(--overlay0)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 12,
};

const sectionHeader: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
  fontSize: 11, fontWeight: 700,
  color: "var(--subtext0)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 10,
  padding: "0 4px",
};

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "6px 12px", borderRadius: 8,
  border: "1px solid var(--surface1)",
  background: "transparent",
  color: "var(--subtext0)",
  fontSize: 11, fontWeight: 600,
  cursor: "pointer", textDecoration: "none",
  fontFamily: "var(--font-sans)",
};

const primaryLinkStyle: React.CSSProperties = {
  ...iconButtonStyle,
  background: "var(--blue)",
  color: "#fff",
  border: "none",
};
