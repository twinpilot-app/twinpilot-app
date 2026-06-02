"use client";

/** Sprint chronology block on /projects/[id]. TimelineRow is rendered
 *  by the host inside the sprint history loop; SprintReviewBody and the
 *  4 sub-components (FailureDiagnosticsBadge, ContextFileBlock,
 *  AgentRunRow, ContextBudgetBreakdown) are internal. */
import React, { useState } from "react";
import { AlertTriangle, GitBranch, Pause, Wand2 } from "lucide-react";
import { brand } from "@/lib/brand";
import { IntentBadge } from "@/components/IntentBadge";
import { FAILURE_CLASS_LABELS, isFailureClass } from "@/lib/sprint-diagnostics";
import {
  CONTEXT_SOURCE_LABELS, CONTEXT_SOURCE_ORDER,
  formatBytes, sumBudget,
  type ContextBudget,
} from "@/lib/context-budget";
import type { DashboardData, Verdict } from "@/app/projects/[id]/page";

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

function verdictColor(v: Verdict): string {
  switch (v) {
    case "success":   return "var(--green)";
    case "partial":   return "var(--peach)";
    case "no-output": return "var(--overlay1)";
    case "failed":    return "var(--red)";
    default:          return "var(--surface1)";
  }
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

export { TimelineRow };
