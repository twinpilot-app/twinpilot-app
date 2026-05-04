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
  Clock, DollarSign, GitBranch, Info, ListTodo, Loader2, Pause, Play, RefreshCw,
  Settings, Sparkles, TrendingUp, Wand2, XCircle,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";
import PageShell from "@/components/PageShell";
import { FAILURE_CLASS_LABELS, isFailureClass } from "@/lib/sprint-diagnostics";
import {
  CONTEXT_SOURCE_LABELS, CONTEXT_SOURCE_ORDER,
  formatBytes, sumBudget,
  type ContextBudget,
} from "@/lib/context-budget";

type Verdict = "success" | "no-output" | "partial" | "failed" | null;

interface DashboardData {
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
      setData(await res.json() as DashboardData);
    } catch (e) { setError((e as Error).message); }
    finally       { setLoading(false); }
  }, [authSession, projectId]);

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
function StatusPanel({ data, authToken, onChanged }: {
  data: DashboardData;
  authToken: string;
  onChanged: () => void;
}) {
  const { now } = data;
  const cur = now.current_sprint;
  const isRunning = !!cur;
  const projectPaused = now.project_status === "paused";
  const [resuming, setResuming] = useState(false);
  const [resumeErr, setResumeErr] = useState<string | null>(null);

  /** Move project.status from paused → ready so a new sprint can dispatch.
   * Sprint-level finalize handles transient/stuck statuses; this is the
   * project-level recovery path used when a sprint already failed (or was
   * cancelled) but the project stayed paused as the safety circuit. */
  async function resumeProject() {
    if (!confirm("Resume this project? The last sprint already finished — this only releases the project from the paused state so you can start a new one.")) return;
    setResuming(true);
    setResumeErr(null);
    try {
      const res = await fetch(`/api/projects/${data.project.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "idle" }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `Resume failed (${res.status})`);
      }
      onChanged();
    } catch (e) {
      setResumeErr((e as Error).message);
    } finally {
      setResuming(false);
    }
  }

  return (
    <div style={panelStyle}>
      <div style={panelHeader}>
        <Activity size={13} /> Status
      </div>

      {isRunning ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <Loader2 size={14} style={{ animation: "spin 1s linear infinite", color: "var(--blue)" }} />
            <span style={{ fontSize: 16, fontWeight: 700 }}>Sprint #{cur!.sprint_num}</span>
            <IntentBadge intent={cur!.intent} />
          </div>
          <div style={{ fontSize: 11, color: "var(--overlay0)" }}>
            {cur!.status} · started {timeAgo(cur!.started_at)}
          </div>
          {cur!.briefing && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--subtext0)", lineHeight: 1.4 }}>
              {cur!.briefing.length > 120 ? cur!.briefing.slice(0, 119) + "…" : cur!.briefing}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            {now.halt_reason
              ? <Pause size={14} style={{ color: "var(--peach)" }} />
              : <CheckCircle2 size={14} style={{ color: "var(--green)" }} />
            }
            <span style={{ fontSize: 16, fontWeight: 700 }}>
              {now.halt_reason ? "Halted" : "Idle"}
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--overlay0)" }}>
            {now.halt_reason ?? `${modeLabel(now.execution_mode)} · ready`}
          </div>
          {projectPaused && (
            <div style={{ marginTop: 10 }}>
              {resumeErr && <div style={{ fontSize: 10, color: "var(--red)", marginBottom: 4 }}>{resumeErr}</div>}
              <button
                onClick={() => void resumeProject()}
                disabled={resuming}
                title="Move project back to ready so a new sprint can run."
                style={{
                  padding: "5px 12px", borderRadius: 6,
                  border: "1px solid var(--green)", background: "transparent",
                  color: "var(--green)", fontSize: 11, fontWeight: 600,
                  cursor: resuming ? "not-allowed" : "pointer",
                  opacity: resuming ? 0.6 : 1,
                  fontFamily: "var(--font-sans)",
                }}
              >
                ▶ {resuming ? "Resuming…" : "Resume project"}
              </button>
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Chip>{statusLabel(now.project_status)}</Chip>
        <Chip>{modeLabel(now.execution_mode)}</Chip>
        {now.awaiting_approval && <Chip color="peach">approval gate</Chip>}
        {now.paused && <Chip color="overlay1">auto-drain paused</Chip>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
 * HEALTH panel — success rate + verdict dots
 * ════════════════════════════════════════════════════════════════════ */
function HealthPanel({ data }: { data: DashboardData }) {
  const { health } = data;
  const ratePct = health.success_rate === null ? null : Math.round(health.success_rate * 100);
  const trouble = health.consecutive_failures >= 2 || health.consecutive_no_output >= 3 || health.needs_human_count > 0;

  return (
    <div style={panelStyle}>
      <div style={panelHeader}>
        <TrendingUp size={13} /> Health
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: trouble ? "var(--peach)" : "var(--text)" }}>
          {ratePct === null ? "—" : `${ratePct}%`}
        </span>
        <span style={{ fontSize: 11, color: "var(--overlay0)" }}>
          success / last {health.window_days}d ({health.window_total} sprints)
        </span>
      </div>

      {/* Verdict dots: most recent on the right */}
      <div style={{ display: "flex", gap: 3, marginTop: 8, marginBottom: 12 }}>
        {[...health.recent].reverse().map((r, i) => (
          <span
            key={i}
            title={`#${r.sprint_num} · ${r.verdict ?? "—"}${r.needs_human ? " · needs human" : ""}`}
            style={{
              width: 10, height: 10, borderRadius: "50%",
              background: verdictColor(r.verdict),
              outline: r.needs_human ? "1.5px solid var(--peach)" : "none",
              outlineOffset: -1,
            }}
          />
        ))}
        {health.recent.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--overlay0)" }}>no completed sprints yet</span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
        {/* BL-26 Phase 1 — what kinds of failures? */}
        {Object.keys(health.failure_breakdown).length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
            {Object.entries(health.failure_breakdown)
              .sort((a, b) => b[1] - a[1])
              .map(([cls, count]) => {
                const p = isFailureClass(cls)
                  ? FAILURE_CLASS_LABELS[cls]
                  : FAILURE_CLASS_LABELS.unknown;
                return (
                  <span
                    key={cls}
                    title={p.hint}
                    style={{
                      fontSize: 10, fontWeight: 700,
                      padding: "2px 7px", borderRadius: 99,
                      background: p.bg, color: p.color,
                      textTransform: "uppercase", letterSpacing: "0.04em",
                    }}
                  >
                    {p.label} · {count}
                  </span>
                );
              })}
          </div>
        )}
        {health.consecutive_failures > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--red)" }}>
            <AlertTriangle size={11} /> {health.consecutive_failures} failed in a row
          </div>
        )}
        {health.consecutive_no_output > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--peach)" }}>
            <Info size={11} /> {health.consecutive_no_output} no-output in a row
          </div>
        )}
        {health.needs_human_count > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--peach)" }}>
            <AlertTriangle size={11} /> {health.needs_human_count} sprint{health.needs_human_count === 1 ? "" : "s"} need review
          </div>
        )}
        {!trouble && health.window_total > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--green)" }}>
            <CheckCircle2 size={11} /> No active anomalies
          </div>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
 * COST panel — total + 14d sparkline
 * ════════════════════════════════════════════════════════════════════ */
function CostPanel({ data }: { data: DashboardData }) {
  const { cost } = data;
  const max = Math.max(0.0001, ...cost.by_day.map((d) => d.usd));
  const totalTokens = cost.tokens_in_total + cost.tokens_out_total;
  const hasEstimated = cost.usd_estimated > 0;

  return (
    <div style={panelStyle}>
      <div style={panelHeader}>
        <DollarSign size={13} /> Cost
      </div>

      {/* Headline = real money. Estimated (subscription) shown next to it.
       * The split exists because claude-code Max + gemini-cli OAuth
       * report cost_usd as API-equivalent estimates, not actual spend.
       * Operator pays a flat subscription fee, not per-token. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 22, fontWeight: 700 }}>{fmtUsd(cost.usd_real)}</span>
        <span style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>
          real
        </span>
      </div>

      {hasEstimated && (
        <div
          title="Subscription-mode runs (claude-code Max, gemini-cli OAuth) — the actual bill is your monthly subscription, not this estimate. Useful for tracking quota, not money."
          style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--overlay0)" }}>
            + {fmtUsd(cost.usd_estimated)}
          </span>
          <span style={{ fontSize: 10, color: "var(--overlay1)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            est. (subscription)
          </span>
        </div>
      )}

      <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 6 }}>
        {fmtTokens(totalTokens)} tokens · last 14 days
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 32 }}>
        {cost.by_day.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--overlay0)", alignSelf: "center" }}>no spend yet</span>
        )}
        {cost.by_day.map((d) => (
          <span
            key={d.day}
            title={`${d.day} · ${fmtUsd(d.usd)} · ${d.sprint_count} sprint${d.sprint_count === 1 ? "" : "s"}`}
            style={{
              flex: 1, minWidth: 4,
              height: `${Math.max(2, (d.usd / max) * 100)}%`,
              background: "var(--blue)", opacity: 0.7,
              borderRadius: 2,
            }}
          />
        ))}
      </div>

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--subtext0)" }}>
        <div>↑ {fmtTokens(cost.tokens_in_total)} in · ↓ {fmtTokens(cost.tokens_out_total)} out</div>
        {cost.by_sprint_recent[0] && cost.by_sprint_recent[0].usd > 0 && (
          <div>last sprint: {fmtUsd(cost.by_sprint_recent[0].usd)} ({cost.by_sprint_recent[0].agent_count} agents)</div>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
 * BACKLOG panel — counts + tag breakdown
 * ════════════════════════════════════════════════════════════════════ */
function BacklogPanel({ data }: { data: DashboardData }) {
  const { backlog } = data;
  const active = backlog.todo + backlog.doing;

  return (
    <div style={panelStyle}>
      <div style={panelHeader}>
        <ClipboardList size={13} /> Backlog
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 700 }}>{active}</span>
        <span style={{ fontSize: 11, color: "var(--overlay0)" }}>open</span>
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <CountChip label="To do"  value={backlog.todo}      color="blue"    />
        <CountChip label="Doing"  value={backlog.doing}     color="peach"   />
        <CountChip label="Done"   value={backlog.done}      color="green"   />
      </div>

      {backlog.by_tag.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            top tags
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {backlog.by_tag.slice(0, 5).map((t) => (
              <span key={t.tag} style={{
                fontSize: 10, padding: "2px 6px", borderRadius: 4,
                background: "var(--surface0)", color: "var(--subtext0)",
              }}>
                #{t.tag} · {t.todo + t.doing}
              </span>
            ))}
          </div>
        </div>
      )}

      {backlog.stale_doing.length > 0 && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, color: "var(--peach)", marginBottom: 8 }}>
          <AlertTriangle size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>
            {backlog.stale_doing.length} item{backlog.stale_doing.length === 1 ? "" : "s"} stuck in Doing &gt; 24h
          </span>
        </div>
      )}

      {/* Last review marker — proves a review-style agent ran its
       * protocol recently and shows what it decided. The persona makes
       * the marker mandatory; absence is itself a signal worth showing. */}
      <div style={{
        marginTop: 4, paddingTop: 8, borderTop: "1px solid var(--surface0)",
        fontSize: 10, color: "var(--overlay0)",
      }}>
        {backlog.last_review_marker ? (
          <ReviewMarkerLine marker={backlog.last_review_marker} />
        ) : (
          <span title="No review marker yet — waiting for product-owner (or another review-style agent) to run record_review_marker.">
            <span style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>Last reviewed:</span> never
          </span>
        )}
      </div>
    </div>
  );
}

function ReviewMarkerLine({ marker }: {
  marker: NonNullable<DashboardData["backlog"]["last_review_marker"]>;
}) {
  const palette: Record<string, { bg: string; fg: string; label: string }> = {
    no_change: { bg: "var(--surface0)",          fg: "var(--overlay0)", label: "no change" },
    added:     { bg: "rgba(28,191,107,0.10)",    fg: "var(--green)",    label: "added" },
    refined:   { bg: "rgba(20,99,255,0.10)",     fg: "var(--blue)",     label: "refined" },
    mixed:     { bg: "rgba(245,159,0,0.10)",     fg: "var(--peach)",    label: "added + refined" },
    failed:    { bg: "rgba(255,77,77,0.10)",     fg: "var(--red)",      label: "failed" },
  };
  const p = palette[marker.action] ?? palette.no_change;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>
        Last reviewed:
      </span>
      <span>{timeAgo(marker.created_at)}</span>
      <span style={{
        fontSize: 9, fontWeight: 700, letterSpacing: "0.04em",
        padding: "1px 5px", borderRadius: 3,
        background: p.bg, color: p.fg, textTransform: "uppercase",
      }}>
        {p.label}
      </span>
      <span style={{ fontSize: 10, color: "var(--subtext0)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={marker.summary}>
        {marker.summary}
      </span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
 * TIMELINE row — one sprint, click to expand the Sprint Review surface
 * ════════════════════════════════════════════════════════════════════ */
interface SprintReview {
  sprint: {
    id: string; sprint_num: number; status: string; intent: string | null;
    briefing: string | null; repo_tag: string | null; commit_sha: string | null;
    outcome: { verdict?: string; reason?: string; metrics?: Record<string, unknown>; failure_class?: string; failure_rule?: string } | null;
    /** BL-26 Phase 1 — populated by the worker when status='failed'. */
    failure_class: string | null;
    failure_reason: string | null;
    needs_human: boolean; created_at: string; completed_at: string | null;
    composed_pipeline: Record<string, unknown> | null;
  };
  context_snapshot: null | {
    project_md:      string | null;
    memory_md:       string | null;
    sprint_md:       string | null;
    sprint_items_md: string | null;
    captured_at:     string;
  };
  step_routing: Record<string, unknown> | null;
  agent_instructions: Record<string, unknown> | null;
  runs: Array<{
    id: string; agent: string; status: string; step: number | null; run_type: string | null;
    llm_model: string | null;
    tokens_in: number | null; tokens_out: number | null;
    cost_usd: number | null; output_size_bytes: number | null;
    started_at: string | null; finished_at: string | null;
    error: string | null; output_ref: string | null; output_content: string | null;
    metrics: { cli?: string; provider?: string; model?: string; auth_mode?: string; wall_ms?: number } | null;
    parent_run_id: string | null;
    /** BL-26 Phase 3 — bytes per context source materialised for this run. */
    context_bytes: ContextBudget | null;
  }>;
  approved_memory_entries: Array<{ id: string; type: string; title: string; content: string }>;
}

function TimelineRow({ sprint: s, projectId, authToken, onChanged }: {
  sprint: DashboardData["timeline"][number];
  projectId: string;
  authToken: string;
  onChanged?: () => void;
}) {
  // Stuck = needs operator action. auto_acknowledged is the explicit
  // pre-acceptance flag stamped by the worker when the sprint dispatched
  // with auto_close on — the operator already decided "do not page me",
  // so failed sprints in that state aren't stuck.
  const isStuck = ["paused", "pending_save", "waiting", "awaiting_approval", "failed"].includes(s.status)
    && !s.auto_acknowledged;
  const verdictBg = isStuck ? "var(--peach)" : verdictColor(s.verdict);
  const [expanded, setExpanded] = useState(false);
  const [quickFinalizing, setQuickFinalizing] = useState(false);
  const [quickFinalizeErr, setQuickFinalizeErr] = useState<string | null>(null);

  /** Direct row-level finalize — operator picks status from a small inline
   * menu without expanding the review pane first. The expanded pane keeps
   * the same buttons for operators who want to read context before
   * deciding; this exists for the "I just need to unblock this" case. */
  async function quickFinalize(target: "cancelled" | "failed" | "completed") {
    const labels = { cancelled: "cancel this sprint", failed: "mark this sprint failed", completed: "mark this sprint completed" };
    if (!confirm(`Are you sure you want to ${labels[target]}? Keeps audit; releases the project from paused.`)) return;
    setQuickFinalizing(true);
    setQuickFinalizeErr(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/sprints/${s.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: target }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `Finalize failed (${res.status})`);
      }
      onChanged?.();
    } catch (e) {
      setQuickFinalizeErr((e as Error).message);
    } finally {
      setQuickFinalizing(false);
    }
  }
  const [review, setReview]     = useState<SprintReview | null>(null);
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  async function toggle() {
    if (!expanded && !review && !loading) {
      setLoading(true);
      setErr(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/sprints/${s.id}/review`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? `Load failed (${res.status})`);
        }
        setReview(await res.json() as SprintReview);
      } catch (e) { setErr((e as Error).message); }
      finally       { setLoading(false); }
    }
    setExpanded((v) => !v);
  }

  return (
    <div style={{
      borderRadius: 8,
      border: "1px solid var(--surface0)",
      background: "var(--mantle)",
      overflow: "hidden",
    }}>
      <button
        onClick={() => void toggle()}
        title="Click to inspect the context delivered to agents in this sprint"
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          padding: "10px 12px", border: "none", background: "transparent",
          cursor: "pointer", textAlign: "left", fontFamily: "var(--font-sans)",
          color: "var(--text)",
        }}
      >
        <span
          title={s.verdict ?? s.status}
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: verdictBg, flexShrink: 0,
            boxShadow: s.needs_human ? "0 0 0 2px var(--peach)" : undefined,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 700, minWidth: 56 }}>#{s.sprint_num}</span>
        <IntentBadge intent={s.intent} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {s.briefing ?? <span style={{ color: "var(--overlay0)", fontStyle: "italic" }}>no briefing</span>}
            {s.reason && (
              <span style={{ color: "var(--overlay0)", marginLeft: 6 }}>· {s.reason}</span>
            )}
          </div>
          <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2 }}>
            {s.completed_at ? `${timeAgo(s.completed_at)}` : `started ${timeAgo(s.started_at)}`}
            {" · "}{s.agent_count} agents
            {s.usd > 0 && <> · {fmtUsd(s.usd)}</>}
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {isStuck && (
            <Chip color="peach" title="Sprint stuck — click to expand and finalize manually" icon={<Pause size={10} />}>
              {s.status}
            </Chip>
          )}
          {s.auto_composed && <Chip title="Pipeline auto-composed by meta-agent" icon={<Wand2 size={10} />}>auto</Chip>}
          {s.pending_push && <Chip color="peach" title={`Local commit ready: ${s.pending_push.tag ?? s.pending_push.branch ?? "?"}`} icon={<GitBranch size={10} />}>push</Chip>}
          {s.needs_human && <Chip color="peach" icon={<AlertTriangle size={10} />}>review</Chip>}
          <span style={{
            fontSize: 10, color: "var(--overlay0)",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 120ms",
          }}>▶</span>
        </div>
      </button>

      {/* Quick finalize bar — visible without expanding when sprint is
       *  stuck. Operators who just want to unblock the project don't need
       *  to read the full review first. The expanded pane has the same
       *  buttons for the "decide based on context" path. */}
      {isStuck && (
        <div style={{
          padding: "8px 12px",
          borderTop: "1px solid var(--surface0)",
          background: "rgba(245,159,0,0.04)",
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 11, color: "var(--peach)", fontWeight: 600, flex: 1, minWidth: 200 }}>
            ⚠ Sprint in <code>{s.status}</code> — operator action required:
          </span>
          {quickFinalizeErr && (
            <span style={{
              fontSize: 11, color: "var(--red)", fontWeight: 600,
              padding: "3px 8px", borderRadius: 4,
              background: "rgba(255,77,77,0.10)", width: "100%",
            }}>{quickFinalizeErr}</span>
          )}
          {/* Hide a button when its target matches the current status —
           *  a no-op transition (e.g., failed → failed) looks like the
           *  click did nothing because the post-reload state is unchanged. */}
          {s.status !== "cancelled" && (
            <button
              onClick={(e) => { e.stopPropagation(); void quickFinalize("cancelled"); }}
              disabled={quickFinalizing}
              title="Mark cancelled — operator gave up. Keeps audit."
              style={finalizeBtn("var(--overlay0)")}
            >
              {quickFinalizing ? "…" : "Cancel"}
            </button>
          )}
          {s.status !== "failed" && (
            <button
              onClick={(e) => { e.stopPropagation(); void quickFinalize("failed"); }}
              disabled={quickFinalizing}
              title="Mark failed — explicit failure. Keeps audit."
              style={finalizeBtn("var(--red)")}
            >
              {quickFinalizing ? "…" : "Failed"}
            </button>
          )}
          {/* Completed override: lets operator declare a sprint's work
           *  acceptable even when the worker marked it failed (partial
           *  output still useful) or when pending_save artifacts are good
           *  enough to keep. Audit retains the original verdict. */}
          {(s.status === "pending_save" || s.status === "paused" || s.status === "failed") && (
            <button
              onClick={(e) => { e.stopPropagation(); void quickFinalize("completed"); }}
              disabled={quickFinalizing}
              title="Mark completed — operator accepts the work despite the worker's verdict."
              style={finalizeBtn("var(--green)")}
            >
              {quickFinalizing ? "…" : "Completed"}
            </button>
          )}
        </div>
      )}

      {expanded && (
        <div style={{ padding: "8px 12px 14px", borderTop: "1px solid var(--surface0)", background: "var(--crust)" }}>
          {loading && <div style={{ fontSize: 11, color: "var(--overlay0)" }}>Loading review…</div>}
          {err && <div style={{ fontSize: 11, color: "var(--red)" }}>{err}</div>}
          {review && (
            <SprintReviewBody
              review={review}
              projectId={projectId}
              authToken={authToken}
              onChanged={() => {
                setReview(null);  // force refetch on next expand
                onChanged?.();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * BL-26 Phase 1 — failure diagnostics badge. Renders a coloured pill
 * with the failure class label and exposes the long-form hint plus the
 * raw failure_reason in the title tooltip. Returns null when the sprint
 * succeeded (failure_class is null) so the surface stays clean for
 * passing sprints.
 */
function FailureDiagnosticsBadge({
  failureClass,
  failureReason,
}: {
  failureClass: string | null;
  failureReason: string | null;
}) {
  if (!failureClass) return null;
  const presentation = isFailureClass(failureClass)
    ? FAILURE_CLASS_LABELS[failureClass]
    : FAILURE_CLASS_LABELS.unknown;
  return (
    <div style={{
      padding: "10px 12px", borderRadius: 6,
      background: presentation.bg,
      border: `1px solid ${presentation.color}33`,
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 700,
          padding: "2px 8px", borderRadius: 99,
          background: presentation.color, color: "#0a0a0a",
          textTransform: "uppercase", letterSpacing: "0.04em",
        }}>
          {presentation.label}
        </span>
        <span style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4 }}>
          {presentation.hint}
        </span>
      </div>
      {failureReason && (
        <pre style={{
          margin: 0, fontSize: 10, lineHeight: 1.4,
          color: "var(--overlay1)", fontFamily: "var(--font-mono)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 80, overflow: "auto",
        }}>
          {failureReason}
        </pre>
      )}
    </div>
  );
}

function SprintReviewBody({ review, projectId, authToken, onChanged }: {
  review:    SprintReview;
  projectId: string;
  authToken: string;
  onChanged: () => void;
}) {
  const snap = review.context_snapshot;
  const sprintStatus = review.sprint.status;
  const isFinalizable = ["paused", "pending_save", "waiting", "awaiting_approval"].includes(sprintStatus);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);

  async function finalize(target: "cancelled" | "failed" | "completed") {
    const labels = { cancelled: "cancel this sprint", failed: "mark this sprint failed", completed: "mark this sprint completed" };
    if (!confirm(`Are you sure you want to ${labels[target]}? This is a manual operator action — keeps the audit trail and unblocks the project.`)) return;
    setFinalizing(true);
    setFinalizeError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/sprints/${review.sprint.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: target }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `Finalize failed (${res.status})`);
      }
      onChanged();
    } catch (e) {
      setFinalizeError((e as Error).message);
    } finally {
      setFinalizing(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header line summarising the dispatch */}
      <div style={{ fontSize: 11, color: "var(--overlay0)" }}>
        Context captured at {snap?.captured_at ? timeAgo(snap.captured_at) : "—"}
        {review.sprint.repo_tag && <> · tag <code>{review.sprint.repo_tag}</code></>}
        {review.sprint.outcome?.verdict && <> · verdict <strong>{review.sprint.outcome.verdict}</strong></>}
      </div>

      {/* BL-26 Phase 1 — failure class badge + reason. Only shows when
       *  the worker classified a failure (sprints.failure_class). The
       *  raw failure_reason is the operator's debugging text; the badge
       *  + tooltip turn it into a structured signal. */}
      <FailureDiagnosticsBadge
        failureClass={review.sprint.failure_class}
        failureReason={review.sprint.failure_reason}
      />


      {/* Manual finalization for stuck sprints (paused / pending_save /
       *  waiting / awaiting_approval). Worker leaves these as-is when it
       *  hits an error or asks for human attention; without an explicit
       *  finalize the project's status stays paused and blocks new sprints. */}
      {isFinalizable && (
        <div style={{
          padding: "10px 12px", borderRadius: 6,
          background: "rgba(245,159,0,0.06)", border: "1px solid rgba(245,159,0,0.20)",
        }}>
          <div style={{ fontSize: 11, color: "var(--peach)", fontWeight: 600, marginBottom: 6 }}>
            ⚠ Sprint stuck in <code>{sprintStatus}</code> — finalize manually to unblock the project
          </div>
          <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4, marginBottom: 8 }}>
            {sprintStatus === "paused"      && "The worker halted this sprint due to an error. Pick a terminal status — audit stays."}
            {sprintStatus === "pending_save" && "Sprint completed without a commit. Decide whether to keep it (completed) or discard (cancelled)."}
            {sprintStatus === "waiting"      && "Sprint is waiting on human approval. Cancel to abort, or approve via the per-sprint approval gate."}
            {sprintStatus === "awaiting_approval" && "Per-sprint approval gate is set. Cancel to abort, or approve to continue the auto-drain loop."}
          </div>
          {finalizeError && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 6 }}>{finalizeError}</div>}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              onClick={() => void finalize("cancelled")}
              disabled={finalizing}
              title="Mark cancelled — operator gave up on this sprint. Keeps audit trail. Releases the project from paused."
              style={finalizeBtn("var(--overlay0)")}
            >
              Mark cancelled
            </button>
            <button
              onClick={() => void finalize("failed")}
              disabled={finalizing}
              title="Mark failed — explicit failure. Keeps audit trail. Releases the project from paused."
              style={finalizeBtn("var(--red)")}
            >
              Mark failed
            </button>
            {(sprintStatus === "pending_save" || sprintStatus === "paused") && (
              <button
                onClick={() => void finalize("completed")}
                disabled={finalizing}
                title="Mark completed — the work this sprint did is acceptable despite the failure."
                style={finalizeBtn("var(--green)")}
              >
                Mark completed
              </button>
            )}
            {finalizing && <span style={{ fontSize: 10, color: "var(--overlay0)", alignSelf: "center" }}>Finalizing…</span>}
          </div>
        </div>
      )}

      {/* Context files delivered to the agents */}
      <details>
        <summary style={{ cursor: "pointer", fontSize: 11, fontWeight: 700, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          .tp/ context files (level: project + sprint)
        </summary>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          {!snap && <div style={{ fontSize: 11, color: "var(--overlay0)" }}>No snapshot — sprint dispatched before Phase 3 was active, or in cloud mode.</div>}
          {snap?.project_md      && <ContextFileBlock label=".tp/PROJECT.md"      content={snap.project_md} />}
          {snap?.memory_md       && <ContextFileBlock label=".tp/MEMORY.md"       content={snap.memory_md} />}
          {snap?.sprint_md       && <ContextFileBlock label=".tp/SPRINT.md"       content={snap.sprint_md} />}
          {snap?.sprint_items_md && <ContextFileBlock label=".tp/SPRINT-ITEMS.md" content={snap.sprint_items_md} />}
        </div>
      </details>

      {/* Per-agent runs */}
      <details open>
        <summary style={{ cursor: "pointer", fontSize: 11, fontWeight: 700, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Agent runs ({review.runs.length})
        </summary>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {review.runs.map((r) => <AgentRunRow key={r.id} run={r} />)}
        </div>
      </details>

      {/* Approved memory entries that were loaded */}
      {review.approved_memory_entries.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 11, fontWeight: 700, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Approved memory loaded ({review.approved_memory_entries.length})
          </summary>
          <div style={{ marginTop: 8, fontSize: 11, color: "var(--subtext0)" }}>
            {review.approved_memory_entries.map((e) => (
              <div key={e.id} style={{ marginBottom: 6 }}>
                <strong style={{ color: "var(--text)" }}>[{e.type}]</strong> {e.title}
                <div style={{ color: "var(--overlay0)", marginTop: 2 }}>{e.content}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ContextFileBlock({ label, content }: { label: string; content: string }) {
  return (
    <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 6 }}>
      <div style={{ padding: "6px 10px", fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid var(--surface0)" }}>
        {label}
      </div>
      <pre style={{
        margin: 0, padding: "8px 10px", fontSize: 11, lineHeight: 1.4,
        color: "var(--subtext0)", whiteSpace: "pre-wrap", wordBreak: "break-word",
        maxHeight: 240, overflow: "auto",
        fontFamily: "var(--font-mono, monospace)",
      }}>
        {content}
      </pre>
    </div>
  );
}

function AgentRunRow({ run: r }: { run: SprintReview["runs"][number] }) {
  const isError = r.status === "failed";
  const cliLabel = r.metrics?.cli ?? null;
  const auth     = r.metrics?.auth_mode ?? null;
  const model    = r.metrics?.model ?? r.llm_model ?? null;
  const wall     = r.metrics?.wall_ms ?? (r.started_at && r.finished_at
    ? Math.max(0, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) : 0);
  const tokens = (r.tokens_in ?? 0) + (r.tokens_out ?? 0);
  // BL-26 Phase 3 — collapse the budget breakdown by default; expand
  // on click. Total stays in the header line so it's visible without
  // a click for any operator scanning the run list.
  const [budgetOpen, setBudgetOpen] = React.useState(false);
  const budget       = r.context_bytes ?? null;
  const budgetTotal  = budget?.total ?? sumBudget(budget);
  const hasBudget    = budgetTotal > 0;

  return (
    <div style={{
      padding: "8px 10px", borderRadius: 6,
      border: `1px solid ${isError ? "rgba(255,77,77,0.25)" : "var(--surface0)"}`,
      background: "var(--mantle)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {r.step !== null && <span style={{ fontSize: 10, color: "var(--overlay0)", minWidth: 18 }}>#{r.step}</span>}
        <span style={{ fontSize: 12, fontWeight: 600 }}>{r.agent}</span>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3,
          background: isError ? "rgba(255,77,77,0.10)" : r.status === "done" ? "rgba(28,191,107,0.10)" : "var(--surface0)",
          color: isError ? "var(--red)" : r.status === "done" ? "var(--green)" : "var(--overlay0)",
          textTransform: "uppercase", letterSpacing: "0.04em",
        }}>{r.status}</span>
        {r.run_type && r.run_type !== "run-sprint" && (
          <span style={{ fontSize: 9, color: "var(--mauve)", fontStyle: "italic" }}>{r.run_type}</span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--overlay0)" }}>
          {cliLabel ? `cli:${cliLabel}` : model ? `api:${model}` : "unknown"}
          {auth === "subscription" && " · sub"}
          {wall > 0 && ` · ${(wall / 1000).toFixed(1)}s`}
          {tokens > 0 && ` · ${fmtTokens(tokens)} tokens`}
          {r.cost_usd && r.cost_usd > 0 && ` · ${fmtUsd(Number(r.cost_usd))}`}
          {hasBudget && (
            <>
              {" · "}
              <button
                onClick={() => setBudgetOpen((v) => !v)}
                title="Show context budget breakdown — bytes per source materialised for this run"
                style={{
                  background: "none", border: "none", padding: 0,
                  color: "var(--mauve)", fontSize: 10, cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                }}
              >
                ctx:{formatBytes(budgetTotal)} {budgetOpen ? "▾" : "▸"}
              </button>
            </>
          )}
        </span>
      </div>
      {r.error && <div style={{ marginTop: 4, fontSize: 11, color: "var(--red)" }}>{r.error}</div>}
      {hasBudget && budgetOpen && budget && (
        <ContextBudgetBreakdown budget={budget} />
      )}
    </div>
  );
}

/**
 * BL-26 Phase 3 — stacked-bar style breakdown of bytes per source. Bars
 * are scaled to the largest source so the operator can eyeball "MEMORY
 * is half my context" without doing arithmetic. Sources with zero bytes
 * are omitted entirely (most projects don't materialise SPRINT.md, for
 * example) so the surface stays compact.
 */
function ContextBudgetBreakdown({ budget }: { budget: ContextBudget }) {
  const rows = CONTEXT_SOURCE_ORDER
    .map((key) => ({ key, value: budget[key] ?? 0 }))
    .filter((r) => r.value > 0);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
      {rows.map(({ key, value }) => {
        const p = CONTEXT_SOURCE_LABELS[key];
        const pct = (value / max) * 100;
        return (
          <div key={key} title={p.hint} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10 }}>
            <span style={{ minWidth: 92, color: "var(--subtext0)" }}>{p.label}</span>
            <div style={{
              flex: 1, height: 6, borderRadius: 2,
              background: "var(--surface0)", overflow: "hidden",
            }}>
              <div style={{ width: `${pct}%`, height: "100%", background: p.color }} />
            </div>
            <span style={{ minWidth: 52, textAlign: "right", color: "var(--overlay1)", fontFamily: "var(--font-mono)" }}>
              {formatBytes(value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
 * AGENT × MODEL — sortable table, BL-26 phase 2 telemetry
 * Surfaces "is Opus paying off for this agent?" by showing runs,
 * sprints touched, total cost, and avg cost-per-run side by side.
 * ════════════════════════════════════════════════════════════════════ */
type AgentModelSortKey = "usd" | "usd_per_run" | "runs" | "sprints" | "agent";

function AgentModelTable({ rows, totalUsd }: {
  rows: DashboardData["cost"]["by_agent_model"];
  totalUsd: number;
}) {
  const [sortKey, setSortKey] = React.useState<AgentModelSortKey>("usd");
  const [sortDesc, setSortDesc] = React.useState(true);
  const [hideZero, setHideZero] = React.useState(true);

  const filtered = hideZero ? rows.filter((r) => r.usd > 0 || r.usd_per_run > 0) : rows;
  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "agent") cmp = a.agent.localeCompare(b.agent);
    else                     cmp = (a[sortKey] as number) - (b[sortKey] as number);
    return sortDesc ? -cmp : cmp;
  });

  function toggleSort(k: AgentModelSortKey) {
    if (sortKey === k) setSortDesc(!sortDesc);
    else { setSortKey(k); setSortDesc(true); }
  }

  function shortRuntime(r: DashboardData["cost"]["by_agent_model"][number]): string {
    if (r.kind === "cli") {
      const cli   = r.cli ?? "?";
      const model = r.model ?? "auto";
      return `${cli} · ${shortModel(model)}${r.inferred ? " (inf)" : ""}`;
    }
    if (r.kind === "api") return `api · ${shortModel(r.model ?? "?")}`;
    return "unknown";
  }

  return (
    <div style={{
      background: "var(--mantle)", border: "1px solid var(--surface0)",
      borderRadius: 8, overflow: "hidden",
    }}>
      <div style={{
        padding: "8px 12px", borderBottom: "1px solid var(--surface0)",
        display: "flex", alignItems: "center", gap: 12, fontSize: 11,
      }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "var(--subtext0)" }}>
          <input
            type="checkbox"
            checked={hideZero}
            onChange={(e) => setHideZero(e.target.checked)}
          />
          Hide zero-cost rows
        </label>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--overlay0)" }}>Total: {fmtUsd(totalUsd)}</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--surface0)" }}>
              <Th label="Agent"      active={sortKey === "agent"}        desc={sortDesc} onClick={() => toggleSort("agent")} />
              <Th label="Runtime"    active={false}                       desc={false}    onClick={undefined} />
              <Th label="Runs"       active={sortKey === "runs"}          desc={sortDesc} onClick={() => toggleSort("runs")}        align="right" />
              <Th label="Sprints"    active={sortKey === "sprints"}       desc={sortDesc} onClick={() => toggleSort("sprints")}     align="right" />
              <Th label="Tokens"     active={false}                       desc={false}    onClick={undefined}                       align="right" />
              <Th label="Total $"    active={sortKey === "usd"}           desc={sortDesc} onClick={() => toggleSort("usd")}         align="right" />
              <Th label="Avg $/run"  active={sortKey === "usd_per_run"}   desc={sortDesc} onClick={() => toggleSort("usd_per_run")} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={`${r.agent}::${r.runtime}`} style={{ borderTop: "1px solid var(--surface0)" }}>
                <td style={{ padding: "6px 10px", fontWeight: 600 }}>{r.agent}</td>
                <td style={{ padding: "6px 10px", color: "var(--subtext0)", fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>
                  {shortRuntime(r)}
                </td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--subtext0)" }}>{r.runs}</td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--subtext0)" }}>{r.sprints}</td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--overlay0)", fontSize: 11 }}>
                  ↑{fmtTokens(r.tokens_in)} ↓{fmtTokens(r.tokens_out)}
                </td>
                <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: r.usd > 0 ? "var(--text)" : "var(--overlay0)" }}>
                  {r.usd > 0 ? fmtUsd(r.usd) : "—"}
                </td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: r.usd_per_run > 0 ? "var(--peach)" : "var(--overlay0)" }}>
                  {r.usd_per_run > 0 ? fmtUsd(r.usd_per_run) : "—"}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: "16px 10px", textAlign: "center", color: "var(--overlay0)", fontSize: 11 }}>
                  {hideZero ? "All rows have zero cost — uncheck to see CLI subscription runs." : "No data yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ label, active, desc, onClick, align }: {
  label:   string;
  active:  boolean;
  desc:    boolean;
  onClick: (() => void) | undefined;
  align?:  "right" | "left";
}) {
  return (
    <th
      onClick={onClick}
      style={{
        padding: "6px 10px",
        textAlign: align ?? "left",
        fontSize: 10, fontWeight: 700,
        color: active ? "var(--blue)" : "var(--overlay0)",
        textTransform: "uppercase", letterSpacing: "0.06em",
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
      }}
    >
      {label}{active ? (desc ? " ↓" : " ↑") : ""}
    </th>
  );
}

function shortModel(m: string): string {
  // Strip the verbose "claude-" prefix and trailing date stamps so the
  // table column stays narrow. opus-4-7 / sonnet-4-6 / haiku-4-5 read
  // cleaner than the full canonical IDs.
  return m
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
}

/* ════════════════════════════════════════════════════════════════════
 * USAGE-BY-MODEL — list with bars, separating CLIs from APIs
 * ════════════════════════════════════════════════════════════════════ */
function UsageByModel({ models, totalUsd }: {
  models: DashboardData["cost"]["by_model"];
  totalUsd: number;
}) {
  const cliCount = models.filter((m) => m.kind === "cli").length;
  const apiCount = models.filter((m) => m.kind === "api").length;
  // For bar scaling: max single-entry usd, with a floor so 0-cost CLI runs
  // still render a sliver rather than nothing.
  const maxUsd = Math.max(0.0001, ...models.map((m) => m.usd));

  return (
    <div style={{ ...panelStyle, padding: 0 }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        borderBottom: "1px solid var(--surface0)",
      }}>
        <div style={{ padding: "10px 14px", borderRight: "1px solid var(--surface0)" }}>
          <div style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            CLIs used
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
            {cliCount} {cliCount === 1 ? "CLI" : "CLIs"}
          </div>
        </div>
        <div style={{ padding: "10px 14px" }}>
          <div style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            API models
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
            {apiCount} {apiCount === 1 ? "model" : "models"}
          </div>
        </div>
      </div>

      <div>
        {models.map((m) => {
          const pctTotal = totalUsd > 0 ? Math.round((m.usd / totalUsd) * 100) : 0;
          const barPct = (m.usd / maxUsd) * 100;
          return (
            <div
              key={m.key}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto auto auto",
                alignItems: "center", gap: 12,
                padding: "10px 14px",
                borderBottom: "1px solid var(--surface0)",
                fontSize: 12,
              }}
            >
              <KindBadge kind={m.kind} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.kind === "cli"
                    ? <>
                        {m.cli}
                        {m.model
                          ? <span style={{ color: "var(--overlay0)", fontWeight: 400 }}> · {m.model}</span>
                          : <span style={{ color: "var(--overlay0)", fontWeight: 400 }}> · subscription</span>}
                        {m.inferred && (
                          <span
                            title="Legacy run before the worker patch — CLI inferred from token/cost shape (claude-code is the only CLI that emits parseable cost). New runs land here directly."
                            style={{ color: "var(--overlay1)", fontWeight: 400, fontSize: 10, marginLeft: 6 }}
                          >
                            (inferred)
                          </span>
                        )}
                      </>
                    : m.kind === "api" ? m.model
                    : <span style={{ color: "var(--overlay0)" }}>(unknown — pre-patch run)</span>}
                </div>
                <div style={{ marginTop: 4, height: 4, background: "var(--surface0)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{
                    width: `${Math.max(2, barPct)}%`,
                    height: "100%",
                    background: m.kind === "cli" ? "var(--peach)" : m.kind === "api" ? "var(--blue)" : "var(--overlay1)",
                    opacity: 0.7,
                  }} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "right", minWidth: 80 }}>
                {m.runs} run{m.runs === 1 ? "" : "s"}
              </div>
              <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "right", minWidth: 90 }}>
                {fmtTokens(m.tokens_in + m.tokens_out)} tokens
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, textAlign: "right", minWidth: 80 }}>
                {fmtUsd(m.usd)} <span style={{ color: "var(--overlay0)", fontWeight: 400, fontSize: 10 }}>{pctTotal}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
 * MEMORY — proposed entries pending review + approved totals
 * ════════════════════════════════════════════════════════════════════ */
interface MemoryEntry {
  id:               string;
  type:             "decision" | "convention" | "gotcha" | "dependency" | string;
  title:            string;
  content:          string;
  status:           "proposed" | "approved" | "rejected" | "archived" | string;
  agent_slug:       string;
  sprint_id:        string | null;
  created_at:       string;
  approved_at:      string | null;
  rejection_reason: string | null;
}

/* ════════════════════════════════════════════════════════════════════
 * PRD PANEL — Slice 1 of Discovery / Product-Manager
 * Surfaces PRD status (draft/reviewed/approved/missing), excerpt, and
 * authoring trail. Drives operator awareness of "is the PRD ready for
 * the product-owner to consume?". Edits happen in Project Settings.
 * ════════════════════════════════════════════════════════════════════ */
function PrdPanel({ data }: { data: DashboardData }) {
  const prd = data.prd;
  const router = useRouter();

  const statusPalette: Record<string, { bg: string; fg: string; label: string }> = {
    draft:    { bg: "rgba(254,166,73,0.12)", fg: "var(--peach)", label: "Draft" },
    reviewed: { bg: "rgba(20,99,255,0.12)",  fg: "var(--blue)",  label: "Reviewed" },
    approved: { bg: "rgba(28,191,107,0.12)", fg: "var(--green)", label: "Approved" },
  };

  const isMissing = !prd.has_content;
  const palette = prd.status ? statusPalette[prd.status] : null;

  return (
    <div style={{
      background: "var(--mantle)", border: "1px solid var(--surface0)",
      borderRadius: 8, padding: "12px 16px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <ClipboardList size={14} color={isMissing ? "var(--overlay0)" : "var(--blue)"} />
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
          Product Requirements Document
        </div>
        {palette && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
            background: palette.bg, color: palette.fg,
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>{palette.label}</span>
        )}
        {isMissing && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
            background: "var(--surface0)", color: "var(--overlay0)",
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>not authored</span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => router.push(`/projects?focus=${data.project.id}#prd`)}
          style={{
            padding: "4px 10px", borderRadius: 5,
            border: "1px solid var(--surface1)", background: "transparent",
            color: "var(--subtext0)", fontSize: 10, fontWeight: 600,
            cursor: "pointer", fontFamily: "var(--font-sans)",
          }}
          title="Edit PRD in Project Settings"
        >
          {isMissing ? "Author PRD" : "Edit"}
        </button>
      </div>

      {isMissing ? (
        <div style={{ fontSize: 12, color: "var(--overlay0)", lineHeight: 1.5 }}>
          No PRD authored yet. The <code>product-manager</code> agent composes a draft during Discovery
          from the briefing + scout findings. You can also write directly in Project Settings → PRD.
        </div>
      ) : (
        <>
          <div style={{
            padding: "10px 12px", borderRadius: 6,
            background: "var(--base)", border: "1px solid var(--surface0)",
            fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5,
            fontFamily: "var(--font-mono, monospace)",
            whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto",
          }}>
            {prd.excerpt}
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 12, marginTop: 8,
            fontSize: 10, color: "var(--overlay0)",
          }}>
            <span>{prd.length_chars.toLocaleString()} chars</span>
            {prd.authored_by_agent && (
              <span>· authored by <strong style={{ color: "var(--subtext0)" }}>{prd.authored_by_agent}</strong></span>
            )}
            {prd.authored_by_sprint !== null && (
              <span>· in sprint <strong style={{ color: "var(--subtext0)" }}>#{prd.authored_by_sprint}</strong></span>
            )}
            {prd.authored_at && (
              <span>· {new Date(prd.authored_at).toLocaleString()}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MemoryPanel({ data, authToken, onChanged }: {
  data: DashboardData;
  authToken: string;
  onChanged: () => void;
}) {
  const { memory } = data;
  const [tab, setTab] = useState<"proposed" | "approved">(memory.proposed_count > 0 ? "proposed" : "approved");
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadEntries = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${data.project.id}/memory?status=${tab}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `Load failed (${res.status})`);
      }
      const body = await res.json() as { entries: MemoryEntry[] };
      setEntries(body.entries ?? []);
    } catch (e) { setError((e as Error).message); }
    finally       { setLoading(false); }
  }, [authToken, data.project.id, tab]);

  useEffect(() => { void reloadEntries(); }, [reloadEntries]);

  async function transition(entryId: string, status: "approved" | "rejected" | "archived", reason?: string) {
    setBusyId(entryId);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${data.project.id}/memory/${entryId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...(reason ? { rejection_reason: reason } : {}) }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `Update failed (${res.status})`);
      }
      await reloadEntries();
      onChanged();  // refresh dashboard counts
    } catch (e) { setError((e as Error).message); }
    finally       { setBusyId(null); }
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Sparkles size={13} color="var(--overlay0)" />
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Project memory
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setTab("proposed")}
            style={{
              ...iconButtonStyle,
              background: tab === "proposed" ? "var(--surface1)" : "transparent",
              color: tab === "proposed" ? "var(--text)" : "var(--overlay0)",
            }}
          >
            Proposed {memory.proposed_count > 0 && (
              <span style={{
                background: "var(--peach)", color: "#000",
                fontSize: 9, fontWeight: 700,
                padding: "1px 5px", borderRadius: 8, marginLeft: 4,
              }}>{memory.proposed_count}</span>
            )}
          </button>
          <button
            onClick={() => setTab("approved")}
            style={{
              ...iconButtonStyle,
              background: tab === "approved" ? "var(--surface1)" : "transparent",
              color: tab === "approved" ? "var(--text)" : "var(--overlay0)",
            }}
          >
            Approved {memory.approved_count > 0 && (
              <span style={{
                background: "var(--green)", color: "#000",
                fontSize: 9, fontWeight: 700,
                padding: "1px 5px", borderRadius: 8, marginLeft: 4,
              }}>{memory.approved_count}</span>
            )}
          </button>
        </div>
      </div>

      {tab === "proposed" && memory.proposed_count > 0 && (
        <div style={{
          marginBottom: 10, padding: "8px 10px", borderRadius: 6,
          background: "rgba(245,159,0,0.06)",
          fontSize: 11, color: "var(--peach)", lineHeight: 1.4,
        }}>
          Agents proposed {memory.proposed_count} entr{memory.proposed_count === 1 ? "y" : "ies"} for this project's memory. Approved entries land in the next sprint's <code>.tp/MEMORY.md</code>; rejected stays in audit only.
        </div>
      )}

      {error && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 8 }}>{error}</div>}

      {loading ? (
        <div style={{ padding: 16, color: "var(--overlay0)", fontSize: 12 }}>Loading…</div>
      ) : entries.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--overlay0)" }}>
          {tab === "proposed"
            ? "No entries waiting for review."
            : "No approved entries yet — agents must propose them via the record_decision MCP tool."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {entries.map((e) => (
            <MemoryEntryRow
              key={e.id}
              entry={e}
              busy={busyId === e.id}
              onApprove={() => void transition(e.id, "approved")}
              onReject={() => {
                const reason = prompt("Reason for rejection (optional, ≤500 chars):") ?? undefined;
                if (reason !== null) void transition(e.id, "rejected", reason);
              }}
              onArchive={() => {
                if (confirm("Archive this entry? It will no longer load into future sprints.")) {
                  void transition(e.id, "archived");
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryEntryRow({ entry, busy, onApprove, onReject, onArchive }: {
  entry: MemoryEntry;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onArchive: () => void;
}) {
  const palette: Record<string, { bg: string; fg: string }> = {
    decision:   { bg: "rgba(20,99,255,0.10)",  fg: "var(--blue)"  },
    convention: { bg: "rgba(28,191,107,0.10)", fg: "var(--green)" },
    gotcha:     { bg: "rgba(245,159,0,0.10)",  fg: "var(--peach)" },
    dependency: { bg: "rgba(203,166,247,0.10)", fg: "var(--mauve)" },
  };
  const p = palette[entry.type] ?? palette.decision;
  return (
    <div style={{
      padding: "10px 12px", borderRadius: 8,
      border: "1px solid var(--surface0)", background: "var(--mantle)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
          background: p.bg, color: p.fg,
          textTransform: "uppercase", letterSpacing: "0.04em",
        }}>{entry.type}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entry.title}
        </span>
        <span style={{ fontSize: 10, color: "var(--overlay0)" }}>
          {entry.agent_slug} · {timeAgo(entry.created_at)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5, marginBottom: 8 }}>
        {entry.content}
      </div>
      {entry.status === "proposed" && (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button onClick={onReject} disabled={busy} style={{ ...iconButtonStyle, color: "var(--red)" }}>
            Reject
          </button>
          <button onClick={onApprove} disabled={busy}
            style={{ ...primaryLinkStyle, opacity: busy ? 0.6 : 1, cursor: busy ? "not-allowed" : "pointer", background: "var(--green)" }}>
            Approve
          </button>
        </div>
      )}
      {entry.status === "approved" && (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button onClick={onArchive} disabled={busy} style={{ ...iconButtonStyle, color: "var(--overlay0)" }}>
            Archive
          </button>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
 * BUDGET — opt-in soft brake (the actual hard limit lives at the provider)
 * ════════════════════════════════════════════════════════════════════ */
function BudgetPanel({ data, authToken, onChanged }: {
  data: DashboardData;
  authToken: string;
  onChanged: () => void;
}) {
  const { budget } = data;
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(budget.enabled);
  const [scope,   setScope]   = useState(budget.scope);
  const [action,  setAction]  = useState(budget.action);
  const [monthly, setMonthly] = useState(budget.monthly_cap !== null ? String(budget.monthly_cap) : "");
  const [daily,   setDaily]   = useState(budget.daily_cap   !== null ? String(budget.daily_cap)   : "");
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  function startEdit() {
    setEnabled(budget.enabled);
    setScope(budget.scope);
    setAction(budget.action);
    setMonthly(budget.monthly_cap !== null ? String(budget.monthly_cap) : "");
    setDaily  (budget.daily_cap   !== null ? String(budget.daily_cap)   : "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const m = monthly.trim();
      const d = daily.trim();
      const body = {
        budget: {
          enabled,
          scope,
          action,
          monthly_usd_cap: m === "" ? null : Number(m),
          daily_usd_cap:   d === "" ? null : Number(d),
        },
      };
      const res = await fetch(`/api/projects/${data.project.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `Save failed (${res.status})`);
      }
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const statusColor = budget.status === "halt" ? "var(--red)" : budget.status === "warn" ? "var(--peach)" : "var(--green)";
  const monthPct = budget.monthly_cap ? Math.min(100, (budget.month_total_usd / budget.monthly_cap) * 100) : null;
  const dayPct   = budget.daily_cap   ? Math.min(100, (budget.day_total_usd   / budget.daily_cap)   * 100) : null;

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <DollarSign size={13} color="var(--overlay0)" />
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Budget brake
        </span>
        {budget.enabled && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
            background: budget.status === "ok" ? "rgba(28,191,107,0.10)" : budget.status === "warn" ? "rgba(245,159,0,0.10)" : "rgba(255,77,77,0.10)",
            color: statusColor, textTransform: "uppercase", letterSpacing: "0.04em",
          }}>
            {budget.status}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {!editing && (
          <button onClick={startEdit} style={iconButtonStyle}>
            <Settings size={11} /> {budget.enabled ? "Edit" : "Configure"}
          </button>
        )}
      </div>

      {!editing ? (
        budget.enabled ? (
          <>
            {budget.reason && (
              <div style={{
                marginBottom: 10, padding: "8px 10px", borderRadius: 6,
                background: budget.status === "halt" ? "rgba(255,77,77,0.08)" : "rgba(245,159,0,0.08)",
                color: statusColor, fontSize: 11, lineHeight: 1.4,
              }}>
                {budget.reason}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <BudgetMeter label="This month" used={budget.month_total_usd} cap={budget.monthly_cap} pct={monthPct} />
              <BudgetMeter label="Today"      used={budget.day_total_usd}   cap={budget.daily_cap}   pct={dayPct}   />
            </div>
            <div style={{ marginTop: 10, fontSize: 10, color: "var(--overlay0)" }}>
              Scope: <strong style={{ color: "var(--subtext0)" }}>{budget.scope === "api_only" ? "API runs only (real $)" : "all runs (incl. subscription estimates)"}</strong>
              {" · "}
              On cap: <strong style={{ color: "var(--subtext0)" }}>{budget.action === "halt" ? "halt auto-drain" : "warn only"}</strong>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--overlay0)", lineHeight: 1.5 }}>
            Off. When enabled, the dispatcher can soft-pause auto-drain when a USD cap is hit.
            {" "}
            <strong style={{ color: "var(--subtext0)" }}>This is a soft brake</strong> — set actual hard limits at your provider's console (Anthropic Console, OpenAI Usage).
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{
            padding: "8px 10px", borderRadius: 6,
            background: "rgba(245,159,0,0.06)", border: "1px solid rgba(245,159,0,0.15)",
            fontSize: 10, color: "var(--peach)", lineHeight: 1.5,
          }}>
            ⚠ This is a soft brake inside {brand.name}. Set <strong>actual hard limits</strong> at your provider's console
            (Anthropic, OpenAI, Google) — {brand.name} cannot guarantee spending stops at this cap.
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span style={{ fontWeight: 600 }}>Enable budget brake for this project</span>
          </label>

          <div>
            <div style={{ ...detailLabel, marginBottom: 4 }}>Scope</div>
            <select value={scope} onChange={(e) => setScope(e.target.value as "api_only" | "all")} disabled={!enabled} style={selectStyle}>
              <option value="api_only">API runs only — real $ to provider (recommended)</option>
              <option value="all">All runs — includes subscription estimates</option>
            </select>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <div style={{ ...detailLabel, marginBottom: 4 }}>Monthly cap (USD)</div>
              <input type="number" min={0} step={0.01} value={monthly} onChange={(e) => setMonthly(e.target.value)}
                placeholder="e.g. 50" disabled={!enabled} style={inputStyle} />
            </div>
            <div>
              <div style={{ ...detailLabel, marginBottom: 4 }}>Daily cap (USD)</div>
              <input type="number" min={0} step={0.01} value={daily} onChange={(e) => setDaily(e.target.value)}
                placeholder="e.g. 5" disabled={!enabled} style={inputStyle} />
            </div>
          </div>

          <div>
            <div style={{ ...detailLabel, marginBottom: 4 }}>On cap reached</div>
            <select value={action} onChange={(e) => setAction(e.target.value as "warn" | "halt")} disabled={!enabled} style={selectStyle}>
              <option value="warn">Warn — show banner, keep running</option>
              <option value="halt">Halt — pause auto-drain until next billing window</option>
            </select>
          </div>

          {error && <div style={{ fontSize: 11, color: "var(--red)" }}>{error}</div>}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setEditing(false)} disabled={saving} style={iconButtonStyle}>Cancel</button>
            <button onClick={() => void save()} disabled={saving}
              style={{ ...primaryLinkStyle, opacity: saving ? 0.6 : 1, cursor: saving ? "not-allowed" : "pointer" }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BudgetMeter({ label, used, cap, pct }: { label: string; used: number; cap: number | null; pct: number | null }) {
  const barColor = pct !== null && pct >= 100 ? "var(--red)" : pct !== null && pct >= 80 ? "var(--peach)" : "var(--blue)";
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
        <span style={{ fontSize: 11, color: "var(--subtext0)" }}>
          {fmtUsd(used)} {cap !== null && <span style={{ color: "var(--overlay0)" }}>/ {fmtUsd(cap)}</span>}
        </span>
      </div>
      <div style={{ height: 6, background: "var(--surface0)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          width: `${pct === null ? 0 : Math.max(2, pct)}%`,
          height: "100%", background: barColor, opacity: 0.8,
        }} />
      </div>
      {cap === null && <div style={{ fontSize: 9, color: "var(--overlay1)", marginTop: 3 }}>no cap set</div>}
    </div>
  );
}

function finalizeBtn(accent: string): React.CSSProperties {
  return {
    padding: "5px 12px", borderRadius: 6,
    border: `1px solid ${accent}`, background: "transparent",
    color: accent,
    fontSize: 11, fontWeight: 600, cursor: "pointer",
    fontFamily: "var(--font-sans)",
  };
}

const selectStyle: React.CSSProperties = {
  width: "100%", padding: "6px 8px", fontSize: 12,
  background: "var(--base)", color: "var(--text)",
  border: "1px solid var(--surface1)", borderRadius: 6,
  fontFamily: "var(--font-sans)",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "6px 8px", fontSize: 12,
  background: "var(--base)", color: "var(--text)",
  border: "1px solid var(--surface1)", borderRadius: 6,
  fontFamily: "var(--font-sans)",
};

/* ════════════════════════════════════════════════════════════════════
 * AGENTS — collapsible breakdown per agent
 * ════════════════════════════════════════════════════════════════════ */
function AgentsBreakdown({ agents, totalUsd }: {
  agents: DashboardData["agents"];
  totalUsd: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const maxUsd = Math.max(0.0001, ...agents.map((a) => a.usd));

  return (
    <div style={{ ...panelStyle, padding: 0 }}>
      {agents.map((a) => {
        const isOpen = expanded === a.agent;
        const pctTotal = totalUsd > 0 ? Math.round((a.usd / totalUsd) * 100) : 0;
        const barPct = (a.usd / maxUsd) * 100;
        const failRate = a.runs > 0 ? Math.round((a.runs_failed / a.runs) * 100) : 0;
        return (
          <div key={a.agent} style={{ borderBottom: "1px solid var(--surface0)" }}>
            <button
              onClick={() => setExpanded(isOpen ? null : a.agent)}
              style={{
                width: "100%",
                display: "grid",
                gridTemplateColumns: "auto 1fr auto auto auto auto",
                alignItems: "center", gap: 12,
                padding: "12px 14px",
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--text)", textAlign: "left", fontFamily: "var(--font-sans)",
              }}
            >
              <Bot size={14} color="var(--overlay0)" />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.agent}
                </div>
                <div style={{ marginTop: 4, height: 4, background: "var(--surface0)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{
                    width: `${Math.max(2, barPct)}%`,
                    height: "100%",
                    background: failRate >= 30 ? "var(--peach)" : "var(--blue)",
                    opacity: 0.7,
                  }} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "right", minWidth: 80 }}>
                {a.runs} run{a.runs === 1 ? "" : "s"}
                {a.runs_failed > 0 && (
                  <span style={{ color: "var(--red)", marginLeft: 4 }} title={`${a.runs_failed} failed (${failRate}%)`}>
                    · {a.runs_failed}✗
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "right", minWidth: 70 }}>
                {a.sprints} sprint{a.sprints === 1 ? "" : "s"}
              </div>
              <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "right", minWidth: 70 }}>
                {a.avg_wall_ms ? `~${fmtDuration(a.avg_wall_ms)}` : "—"}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, textAlign: "right", minWidth: 90 }}>
                {fmtUsd(a.usd)} <span style={{ color: "var(--overlay0)", fontWeight: 400, fontSize: 10 }}>{pctTotal}%</span>
              </div>
            </button>

            {isOpen && (
              <div style={{ padding: "8px 14px 14px 38px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, background: "var(--crust)" }}>
                <div>
                  <div style={detailLabel}>Tokens</div>
                  <div style={detailValue}>
                    ↑ {fmtTokens(a.tokens_in)} in · ↓ {fmtTokens(a.tokens_out)} out
                  </div>
                </div>
                <div>
                  <div style={detailLabel}>Total wall time</div>
                  <div style={detailValue}>{fmtDuration(a.total_wall_ms)}</div>
                </div>
                <div>
                  <div style={detailLabel}>Last run</div>
                  <div style={detailValue}>{a.last_run ? timeAgo(a.last_run) : "—"}</div>
                </div>
                <div>
                  <div style={detailLabel}>Sprints touched</div>
                  <div style={detailValue}>{a.sprints}</div>
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <div style={detailLabel}>By intent</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                    <IntentSplitChip intent="discovery" runs={a.runs_discovery} usd={a.usd_discovery} />
                    <IntentSplitChip intent="execution" runs={a.runs_execution} usd={a.usd_execution} />
                    {a.runs - a.runs_discovery - a.runs_execution > 0 && (
                      <IntentSplitChip
                        intent="other"
                        runs={a.runs - a.runs_discovery - a.runs_execution}
                        usd={a.usd - a.usd_discovery - a.usd_execution}
                      />
                    )}
                  </div>
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <div style={detailLabel}>Runtimes used</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                    {a.runtimes.length === 0 ? (
                      <span style={{ fontSize: 11, color: "var(--overlay0)" }}>—</span>
                    ) : a.runtimes.map((rt) => (
                      <RuntimeChip key={rt.key} label={rt.key} runs={rt.runs} usd={rt.usd} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function IntentSplitChip({ intent, runs, usd }: {
  intent: "discovery" | "planning" | "execution" | "review" | "other";
  runs: number;
  usd: number;
}) {
  const cfg = {
    discovery: { label: "Discovery", icon: <Sparkles size={10} />, bg: "rgba(20,99,255,0.10)",  fg: "var(--blue)"   },
    planning:  { label: "Planning",  icon: <ListTodo size={10} />, bg: "rgba(167,139,250,0.10)", fg: "var(--mauve)" },
    execution: { label: "Execution", icon: <Bot size={10} />,      bg: "rgba(28,191,107,0.10)", fg: "var(--green)"  },
    review:    { label: "Review",    icon: <Check size={10} />,    bg: "rgba(245,159,0,0.10)",  fg: "var(--peach)"  },
    other:     { label: "Other",     icon: <Info size={10} />,     bg: "var(--surface0)",       fg: "var(--overlay0)" },
  }[intent];
  const dim = runs === 0;
  return (
    <span
      title={`${runs} run${runs === 1 ? "" : "s"} · ${fmtUsd(usd)}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontSize: 11, padding: "3px 8px", borderRadius: 4,
        background: cfg.bg, color: cfg.fg, fontWeight: 600,
        opacity: dim ? 0.4 : 1,
      }}
    >
      {cfg.icon}
      <span>{cfg.label}</span>
      <span style={{ opacity: 0.85 }}>{runs}</span>
      {usd > 0 && <span style={{ opacity: 0.7, fontSize: 10 }}>· {fmtUsd(usd)}</span>}
    </span>
  );
}

function RuntimeChip({ label, runs, usd }: { label: string; runs: number; usd: number }) {
  const [kind, ...rest] = label.split(":");
  const isCli = kind === "cli";
  const isInferred = label.endsWith(":~");
  const cleanLabel = rest.join(":").replace(/:~$/, "");
  const palette = isCli
    ? { bg: "rgba(245,159,0,0.10)", fg: "var(--peach)" }
    : kind === "api"
      ? { bg: "rgba(20,99,255,0.10)", fg: "var(--blue)" }
      : { bg: "var(--surface0)", fg: "var(--overlay0)" };
  return (
    <span
      title={`${runs} run${runs === 1 ? "" : "s"} · ${fmtUsd(usd)}${isInferred ? " · inferred" : ""}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 10, padding: "3px 7px", borderRadius: 4,
        background: palette.bg, color: palette.fg, fontWeight: 600,
      }}
    >
      <span style={{ fontWeight: 700, letterSpacing: "0.04em" }}>{(kind || "?").toUpperCase()}</span>
      <span style={{ opacity: 0.85 }}>{cleanLabel || (isCli ? "subscription" : "?")}</span>
      <span style={{ opacity: 0.6 }}>· {runs}</span>
      {isInferred && <span style={{ opacity: 0.5 }}>~</span>}
    </span>
  );
}

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

function KindBadge({ kind }: { kind: "cli" | "api" | "unknown" }) {
  const cfg = {
    cli:     { label: "CLI", bg: "rgba(245,159,0,0.10)", fg: "var(--peach)" },
    api:     { label: "API", bg: "rgba(20,99,255,0.10)", fg: "var(--blue)"  },
    unknown: { label: "?",   bg: "var(--surface0)",      fg: "var(--overlay0)" },
  }[kind];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
      width: 32, padding: "2px 0", borderRadius: 4,
      background: cfg.bg, color: cfg.fg,
    }}>
      {cfg.label}
    </span>
  );
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

function CountChip({ label, value, color }: { label: string; value: number; color: "blue" | "peach" | "green" }) {
  const palette = {
    blue:  { bg: "rgba(20,99,255,0.08)",  fg: "var(--blue)"  },
    peach: { bg: "rgba(245,159,0,0.08)",  fg: "var(--peach)" },
    green: { bg: "rgba(28,191,107,0.08)", fg: "var(--green)" },
  }[color];
  return (
    <div style={{
      flex: 1, padding: "6px 8px", borderRadius: 6,
      background: palette.bg, color: palette.fg,
    }}>
      <div style={{ fontSize: 16, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.8 }}>{label}</div>
    </div>
  );
}

function IntentBadge({ intent }: { intent: string | null }) {
  if (!intent) return null;
  const isDiscovery = intent === "discovery";
  return (
    <span
      title={isDiscovery ? "Discovery sprint" : "Execution sprint"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em",
        padding: "1px 5px", borderRadius: 3,
        background: isDiscovery ? "rgba(20,99,255,0.08)" : "rgba(28,191,107,0.08)",
        color: isDiscovery ? "var(--blue)" : "var(--green)",
      }}
    >
      {isDiscovery ? <Sparkles size={9} /> : <Bot size={9} />}
      {intent}
    </span>
  );
}

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

function statusLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
