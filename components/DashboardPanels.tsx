"use client";

/** Top-row analytics panels on /projects/[id]: Status (current sprint +
 *  project chips), Health (success-rate + failure-class breakdown),
 *  Backlog (kanban counts + ReviewMarkerLine for the last PO marker). */
import React, { useState } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, ClipboardList,
  Info, Loader2, Pause, TrendingUp,
} from "lucide-react";
import { IntentBadge } from "@/components/IntentBadge";
import { FAILURE_CLASS_LABELS, isFailureClass } from "@/lib/sprint-diagnostics";
import type { DashboardData, Verdict } from "@/app/projects/[id]/page";

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

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
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
  return m === "kanban_auto" ? "auto" : m === "kanban_manual" ? "approve" : "manual";
}

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

function statusLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { StatusPanel, HealthPanel, BacklogPanel };
