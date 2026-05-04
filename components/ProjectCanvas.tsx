"use client";

import React, { useEffect, useState, useCallback } from "react";
import { SkipForward, RefreshCw, Pause, Play, FolderOpen, FileText, CheckCircle2, Zap, Cloud } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "@/lib/supabase";
import type { AgentRun, AgentEvent, SquadName, SprintIntent } from "@/lib/types";
import { AGENT_META, SQUAD_ORDER } from "@/lib/types";

/* ─── Agent Node ─────────────────────────────────────────── */

interface AgentNodeProps {
  agent: string;
  run: AgentRun | null;
  isActive: boolean;
  onClick: () => void;
}

function AgentNode({ agent, run, isActive, onClick }: AgentNodeProps) {
  const meta = AGENT_META[agent] ?? { squad: "Unknown", label: agent, color: "#666" };
  const status = run?.status ?? "idle";

  const borderColor =
    status === "running" ? "var(--green)"
      : status === "waiting" ? "var(--yellow)"
        : status === "done" ? "var(--surface2)"
          : status === "failed" ? "var(--red)"
            : "var(--surface1)";

  const dotColor =
    status === "running" ? "var(--green)"
      : status === "waiting" ? "var(--yellow)"
        : status === "done" ? "var(--overlay0)"
          : status === "failed" ? "var(--red)"
            : "var(--surface1)";

  const isLive = status === "running" || status === "waiting";

  return (
    <button
      onClick={onClick}
      className={isLive ? "pulse" : undefined}
      style={{
        position: "relative",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
        width: 88, padding: 8, borderRadius: 8,
        background: isActive ? "var(--surface1)" : "var(--surface0)",
        borderRight: `2px solid ${borderColor}`,
        borderBottom: `2px solid ${borderColor}`,
        borderLeft: `2px solid ${borderColor}`,
        borderTop: `3px solid ${meta.color}`,
        cursor: "pointer",
        transition: "all 0.15s ease",
        transform: isActive ? "scale(1.05)" : "none",
        boxShadow: isLive ? `0 0 12px ${borderColor}40` : "none",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{
        width: 8, height: 8, borderRadius: "50%", background: dotColor,
        position: "absolute", top: 6, right: 6,
      }} />
      {status === "waiting" && (
        <div style={{
          position: "absolute", top: -8, right: -8,
          fontSize: 9, background: "var(--yellow)", color: "var(--crust)",
          fontWeight: 700, padding: "1px 6px", borderRadius: 10,
        }}>
          WAITING
        </div>
      )}
      {isLive && (
        <div style={{
          position: "absolute", top: -8, left: -8,
          fontSize: 8, background: borderColor, color: "var(--crust)",
          fontWeight: 700, padding: "1px 5px", borderRadius: 10,
          letterSpacing: "0.4px",
        }}>
          LIVE
        </div>
      )}
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", width: "100%", textAlign: "center" }} className="truncate">{meta.label}</span>
      {run?.cost_usd ? (
        <span style={{ fontSize: 9, color: "var(--green)" }}>${run.cost_usd.toFixed(4)}</span>
      ) : (
        <span style={{ fontSize: 9, color: "var(--overlay0)" }}>idle</span>
      )}
    </button>
  );
}

/* ─── SIPOC helpers ─────────────────────────────────────── */

/**
 * Parse "### Input" table rows from a SIPOC contract.
 * Returns { artifact, format, prefix } where prefix is extracted from
 * naming-convention formats (e.g. `ARCH-{APP}-{NNN}` → "ARCH-").
 * Formats without `{` are external artifacts (GitHub PR, etc.).
 */
function parseInputRows(contract: string): { artifact: string; format: string; prefix: string | null }[] {
  const section = contract.match(/### Input\n([\s\S]*?)(?=\n###|\n##|$)/);
  if (!section) return [];
  return [...section[1].matchAll(/^\|([^|]+)\|([^|]+)\|/gm)]
    .map(([, artifact, format]) => {
      const a = artifact.trim();
      const f = format.trim().replace(/`/g, "");
      if (!a || a === "Artifact" || a.startsWith("-")) return null;
      const braceIdx = f.indexOf("{");
      const prefix = braceIdx > 0 ? f.slice(0, braceIdx).toUpperCase() : null;
      return { artifact: a, format: f, prefix };
    })
    .filter((r): r is { artifact: string; format: string; prefix: string | null } => r !== null);
}

/** Hook: loads and parses an agent's SIPOC contract */
function useAgentContract(agentName: string) {
  const [inputRows, setInputRows] = useState<{ artifact: string; format: string; prefix: string | null }[]>([]);

  useEffect(() => {
    fetch(`/api/artifact?type=contract&agent=${encodeURIComponent(agentName)}`)
      .then((r) => r.ok ? r.text() : "")
      .then((text) => setInputRows(parseInputRows(text)))
      .catch(() => {});
  }, [agentName]);

  return { inputRows };
}

/* ─── Agent Detail ───────────────────────────────────────── */

const TRIGGER_RUNS_BASE = "https://cloud.trigger.dev/orgs/tirsa-software-7845/projects/tirsa-experiment-LkdX/env/dev/runs";

interface AgentDetailProps {
  run: AgentRun;
  projectId: string;
  onViewOutput: (ref: string, githubRef: AgentRun["github_ref"]) => void;
  onViewInput: (ref: string) => void;
  onViewSpec: (agent: string) => void;
  onBrowseDir: (subdir: string, label: string, sprintId: string) => void;
  onApprove: (runId: string, instructions?: string) => void;
  onReject: (runId: string, comment: string) => void;
}

function AgentDetail({ run, projectId, onViewOutput, onViewInput, onViewSpec, onBrowseDir, onApprove, onReject }: AgentDetailProps) {
  const [retryNote,    setRetryNote]    = React.useState("");
  const [retryBusy,   setRetryBusy]    = React.useState(false);
  const [retryMsg,    setRetryMsg]     = React.useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [retryOpen,   setRetryOpen]    = React.useState(false);

  const isFailed = run.status === "failed";

  async function handleRetry() {
    if (!run.step) return;
    setRetryBusy(true); setRetryMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/projects/${projectId}/continue`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fromStep: run.step,
          toStep:   run.step,
          note:     retryNote.trim() || undefined,
        }),
      });
      const data = await res.json() as { triggered?: boolean; error?: string };
      if (res.status === 429) {
        setRetryMsg({ type: "error", text: "Factory at concurrent project limit — wait for a sprint to finish or raise the limit in Factory Settings." });
      } else if (!res.ok) {
        setRetryMsg({ type: "error", text: data.error ?? `Error ${res.status}` });
      } else {
        setRetryMsg({ type: "ok", text: data.triggered ? `Step ${run.step} queued — agent will restart.` : "No trigger key — use CLI." });
        setRetryOpen(false);
      }
    } catch (e: unknown) {
      setRetryMsg({ type: "error", text: (e as Error).message });
    } finally {
      setRetryBusy(false);
    }
  }
  const duration =
    run.started_at && run.finished_at
      ? ((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000).toFixed(1)
      : run.started_at
        ? "running..."
        : "-";

  const statusColor =
    run.status === "running" ? "var(--green)"
      : run.status === "waiting" ? "var(--yellow)"
        : run.status === "done" ? "var(--subtext0)"
          : run.status === "failed" ? "var(--red)"
            : "var(--overlay0)";

  return (
    <div>
      {/* Status badge */}
      <div style={{ marginBottom: 16 }}>
        <span style={{
          fontSize: 12, padding: "3px 10px", borderRadius: 10,
          background: `${statusColor}20`, color: statusColor,
        }}>{run.status}</span>
      </div>

      {run.status === "waiting" && (
        <div style={{
          marginBottom: 16, padding: 12, borderRadius: 8,
          background: "var(--yellow)" + "10", border: "1px solid var(--yellow)" + "30",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          <span style={{ color: "var(--yellow)", fontSize: 18 }}>⏸</span>
          <div style={{ flex: 1 }}>
            <div style={{ color: "var(--yellow)", fontSize: 14, fontWeight: 500 }}>Awaiting human approval</div>
            <div style={{ color: "var(--yellow)", opacity: 0.6, fontSize: 12 }}>Review the output and approve or reject to continue the pipeline.</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                const instructions = prompt("Instructions for next agents (leave empty to skip):");
                if (instructions === null) return;
                onApprove(run.id, instructions || undefined);
              }}
              style={{
                padding: "6px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                background: "var(--green)", color: "var(--crust)",
                border: "none", cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              ✓ Approve
            </button>
            <button
              onClick={() => {
                const comment = prompt("Rejection reason:");
                if (comment === null) return;
                if (comment) onReject(run.id, comment);
              }}
              style={{
                padding: "6px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600,
                background: "transparent", color: "var(--red)",
                border: "1px solid var(--red)", cursor: "pointer",
                transition: "all 0.15s ease",
              }}
            >
              ✕ Reject
            </button>
          </div>
        </div>
      )}

      {/* ── Retry panel (failed runs only) ── */}
      {isFailed && run.step != null && (
        <div style={{
          marginBottom: 16, padding: 12, borderRadius: 8,
          background: "rgba(228,75,95,0.06)", border: "1px solid rgba(228,75,95,0.25)",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: retryOpen ? 10 : 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ color: "var(--red)", fontSize: 13 }}>✕</span>
              <span style={{ color: "var(--red)", fontSize: 13, fontWeight: 500 }}>Failed — step {run.step}</span>
            </div>
            <button
              onClick={() => { setRetryOpen((o) => !o); setRetryMsg(null); }}
              style={{
                padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                background: "rgba(228,75,95,0.12)", color: "var(--red)",
                border: "1px solid rgba(228,75,95,0.3)", cursor: "pointer",
                fontFamily: "var(--font-sans)",
              }}
            >
              {retryOpen ? "Cancel" : "↺ Retry"}
            </button>
          </div>

          {retryOpen && (
            <>
              <textarea
                value={retryNote}
                onChange={(e) => setRetryNote(e.target.value)}
                placeholder="Optional note for this retry (e.g. 'focus only on X', 'continue from where it stopped')…"
                rows={3}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 6, resize: "vertical",
                  background: "var(--surface0)", border: "1px solid var(--surface1)",
                  color: "var(--text)", fontSize: 12, lineHeight: 1.5,
                  fontFamily: "var(--font-sans)", boxSizing: "border-box", marginBottom: 8,
                }}
              />
              <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 8 }}>
                To increase the timeout, go to <strong style={{ color: "var(--subtext0)" }}>Projects → CLI Settings → {run.agent} → timeout_secs</strong>.
              </div>
              <button
                onClick={handleRetry}
                disabled={retryBusy}
                style={{
                  padding: "6px 16px", borderRadius: 6, fontSize: 12, fontWeight: 700,
                  background: retryBusy ? "var(--surface1)" : "var(--red)",
                  color: retryBusy ? "var(--overlay0)" : "#fff",
                  border: "none", cursor: retryBusy ? "not-allowed" : "pointer",
                  fontFamily: "var(--font-sans)",
                }}
              >
                {retryBusy ? "Retrying…" : `↺ Retry step ${run.step}`}
              </button>
            </>
          )}

          {retryMsg && (
            <div style={{
              marginTop: 8, fontSize: 12, padding: "6px 10px", borderRadius: 6,
              color: retryMsg.type === "ok" ? "var(--green)" : "var(--red)",
              background: retryMsg.type === "ok" ? "rgba(166,227,161,0.1)" : "rgba(228,75,95,0.1)",
            }}>
              {retryMsg.text}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", fontSize: 14 }}>
        <div style={{ color: "var(--overlay0)" }}>Duration</div>
        <div style={{ color: "var(--text)" }}>{duration}s</div>
        <div style={{ color: "var(--overlay0)" }}>Model</div>
        <div style={{ color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}>{run.llm_model ?? "-"}</div>
        <div style={{ color: "var(--overlay0)" }}>Tokens in</div>
        <div style={{ color: "var(--text)" }}>{run.tokens_in > 0 ? run.tokens_in.toLocaleString() : "—"}</div>
        <div style={{ color: "var(--overlay0)" }}>Tokens out</div>
        <div style={{ color: "var(--text)" }}>{run.tokens_out > 0 ? run.tokens_out.toLocaleString() : "—"}</div>
        <div style={{ color: "var(--overlay0)" }} title="Estimated API-equivalent cost. Subscription users are not charged per token.">
          Cost {run.tokens_in > 0 ? <span style={{ fontSize: 9, color: "var(--overlay0)" }}>est.</span> : ""}
        </div>
        <div style={{ color: "var(--green)" }}>{run.cost_usd > 0 ? `$${run.cost_usd.toFixed(4)}` : "—"}</div>

        {run.step != null && (
          <>
            <div style={{ color: "var(--overlay0)" }}>Step</div>
            <div style={{ color: "var(--text)" }}>{run.step}</div>
          </>
        )}

        <div style={{ color: "var(--overlay0)" }}>Trigger.dev</div>
        <a
          href={run.trigger_run_id ? `${TRIGGER_RUNS_BASE}/${run.trigger_run_id}` : TRIGGER_RUNS_BASE}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            color: "var(--mauve)", fontSize: 12, fontFamily: "var(--font-mono)",
            textDecoration: "none",
          }}
        >
          {run.trigger_run_id ? run.trigger_run_id.slice(0, 20) + "…" : "View runs"} ↗
        </a>

        <div style={{ color: "var(--overlay0)" }}>Spec</div>
        <button
          onClick={() => onViewSpec(run.agent)}
          style={{
            color: "var(--mauve)", fontSize: 12, fontFamily: "var(--font-mono)",
            textDecoration: "underline", textUnderlineOffset: 2, textAlign: "left",
            cursor: "pointer", background: "none", border: "none",
          }}
        >
          {run.agent} — spec
        </button>

        {run.input_ref && (
          <>
            <div style={{ color: "var(--overlay0)" }}>Input</div>
            <button
              onClick={() => onViewInput(run.input_ref!)}
              style={{
                color: "var(--teal)", fontSize: 12, fontFamily: "var(--font-mono)",
                textDecoration: "underline", textUnderlineOffset: 2, textAlign: "left",
                cursor: "pointer", background: "none", border: "none",
              }}
            >
              {run.input_ref.split("/").pop()}
            </button>
          </>
        )}

        {/* CLI agent runs: Audit / Docs / Workspace directory browsers */}
        {run.sprint_id && (() => {
          const agent = run.agent;
          const sid   = run.sprint_id;
          const dirs: { label: string; subdir: string; color: string }[] = [
            { label: "Audit",     subdir: `_audit/${agent}`,  color: "var(--mauve)" },
            { label: "Docs",      subdir: `_docs`,            color: "var(--teal)"  },
            { label: "Workspace", subdir: `_workspace`,       color: "var(--blue)"  },
          ];
          return (
            <>
              <div style={{ color: "var(--overlay0)" }}>Files</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {dirs.map(({ label, subdir, color }) => (
                  <button
                    key={label}
                    onClick={() => onBrowseDir(subdir, label, sid)}
                    style={{
                      fontSize: 11, padding: "2px 10px", borderRadius: 4,
                      border: `1px solid ${color}50`, color, background: `${color}10`,
                      cursor: "pointer", fontFamily: "var(--font-sans)", fontWeight: 500,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          );
        })()}

        {run.github_ref && (
          <>
            <div style={{ color: "var(--overlay0)" }}>GitHub</div>
            <div style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
              <a
                href={`https://github.com/${run.github_ref.repo}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--teal)", textDecoration: "none" }}
              >
                {run.github_ref.repo}
              </a>
              {run.github_ref.commit && (
                <span style={{ color: "var(--overlay0)", marginLeft: 4 }}>@{run.github_ref.commit.slice(0, 7)}</span>
              )}
              {run.github_ref.pr && (
                <a
                  href={`https://github.com/${run.github_ref.repo}/pull/${run.github_ref.pr}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--teal)", textDecoration: "none", marginLeft: 8 }}
                >
                  PR #{run.github_ref.pr}
                </a>
              )}
            </div>
          </>
        )}

        {run.error && (
          <>
            <div style={{ color: "var(--overlay0)" }}>Error</div>
            <div style={{ color: "var(--red)", fontSize: 12 }}>{run.error}</div>
          </>
        )}
      </div>

      {/* Execution log */}
      <ExecutionLog runId={run.id} isActive={run.status === "running" || run.status === "waiting"} />
    </div>
  );
}

/* ─── Execution Log ─────────────────────────────────────── */

function ExecutionLog({ runId, isActive }: { runId: string; isActive: boolean }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    supabase
      .from("agent_events")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: true })
      .then(({ data }) => { if (data) setEvents(data as AgentEvent[]); });
  }, [runId]);

  useEffect(() => {
    if (!isActive) return;
    const channel = supabase
      .channel(`events-${runId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_events", filter: `run_id=eq.${runId}` },
        (payload) => setEvents((prev) => {
          const newEv = payload.new as AgentEvent;
          // Guard against duplicates: initial fetch + realtime may both deliver the same row
          if (prev.some((e) => e.id === newEv.id)) return prev;
          return [...prev, newEv];
        }),
      )
      .subscribe();
    return () => { channel.unsubscribe().then(() => supabase.removeChannel(channel)); };
  }, [runId, isActive]);

  if (events.length === 0) return null;

  const EVENT_META: Record<string, { label: string; color: string; dot: string }> = {
    started:          { label: "Started",        color: "var(--green)",    dot: "var(--green)" },
    progress:         { label: "Tool calls",     color: "var(--blue)",     dot: "var(--blue)" },
    log:              { label: "Step",           color: "var(--teal)",     dot: "var(--teal)" },
    output:           { label: "Output",         color: "var(--subtext0)", dot: "var(--surface2)" },
    completed:        { label: "Completed",      color: "var(--overlay0)", dot: "var(--overlay0)" },
    waiting_approval: { label: "Waiting",        color: "var(--yellow)",   dot: "var(--yellow)" },
    approved:         { label: "Approved",       color: "var(--green)",    dot: "var(--green)" },
    rejected:         { label: "Rejected",       color: "var(--red)",      dot: "var(--red)" },
    human_escalation: { label: "Escalated",      color: "var(--peach)",    dot: "var(--peach)" },
    error:            { label: "Error",          color: "var(--red)",      dot: "var(--red)" },
  };

  function summarise(ev: AgentEvent): string {
    const p = ev.payload ?? {};
    if (ev.event_type === "log")     return (p["message"] as string | undefined) ?? "";
    if (ev.event_type === "output")  return "";  // rendered as terminal block below
    if (ev.event_type === "progress") {
      const round = p["round"] as number ?? "?";
      const tools = (p["tools"] as { name: string }[] | undefined)?.map((t) => t.name).join(", ") ?? "";
      return tools ? `Round ${round} · ${tools}` : `Round ${round}`;
    }
    if (ev.event_type === "started") {
      const toolList = (p["tools"] as string[] | undefined)?.join(", ");
      const cli = p["cli"] as string | undefined;
      return cli
        ? `${cli}${toolList ? ` · ${toolList}` : ""}`
        : toolList ? `tools: ${toolList}` : "";
    }
    if (ev.event_type === "completed") {
      const tokens = (p["tokens_in"] as number ?? 0) + (p["tokens_out"] as number ?? 0);
      const ms  = p["duration_ms"] as number | undefined;
      const cost = p["cost_usd"]   as number | undefined;
      const files = p["filesChanged"] as number | undefined;
      return [
        files !== undefined ? `${files} file(s)` : "",
        tokens ? `${tokens.toLocaleString()} tokens` : "",
        cost !== undefined ? `$${cost.toFixed(4)}` : "",
        ms   !== undefined ? `${(ms / 1000).toFixed(1)}s` : "",
      ].filter(Boolean).join(" · ");
    }
    if (ev.event_type === "human_escalation") return (p["message"] as string | undefined) ?? "";
    if (ev.event_type === "error") return (p["message"] as string | undefined) ?? "";
    return "";
  }

  // Collapse consecutive "output" events into a single terminal block
  type EventGroup =
    | { kind: "event"; ev: AgentEvent }
    | { kind: "output"; chunks: string[]; firstId: string; ts: string };

  const groups: EventGroup[] = [];
  for (const ev of events) {
    if (ev.event_type === "output") {
      const text = (ev.payload["text"] as string | undefined) ?? "";
      const last = groups[groups.length - 1];
      if (last?.kind === "output") {
        last.chunks.push(text);
      } else {
        groups.push({
          kind: "output",
          chunks: [text],
          firstId: ev.id,
          ts: new Date(ev.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
        });
      }
    } else {
      groups.push({ kind: "event", ev });
    }
  }

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 6, width: "100%",
          background: "none", border: "none", cursor: "pointer",
          padding: "6px 0", marginBottom: open ? 8 : 0,
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.6px" }}>
          Execution log
        </span>
        <span style={{ fontSize: 10, color: "var(--overlay0)", background: "var(--surface1)", padding: "1px 6px", borderRadius: 4 }}>
          {events.length}
        </span>
        {isActive && (
          <span style={{ fontSize: 8, color: "var(--green)", fontWeight: 700, letterSpacing: "0.5px", animation: "pulse 1.5s ease-in-out infinite" }}>
            ● LIVE
          </span>
        )}
        <span style={{ fontSize: 9, color: "var(--overlay0)", marginLeft: "auto" }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, position: "relative" }}>
          {/* Vertical line */}
          <div style={{
            position: "absolute", left: 5, top: 8, bottom: 8, width: 1,
            background: "var(--surface2)",
          }} />

          {groups.map((g) => {
            if (g.kind === "output") {
              const combined = g.chunks.join("");
              return (
                <div key={g.firstId} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "4px 0" }}>
                  <div style={{
                    width: 11, height: 11, borderRadius: "50%", flexShrink: 0, marginTop: 3,
                    background: "var(--surface2)", border: "2px solid var(--mantle)",
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: "var(--overlay0)" }}>CLI output</span>
                      <span style={{ fontSize: 9, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{g.ts}</span>
                    </div>
                    <pre style={{
                      margin: 0, padding: "6px 8px", borderRadius: 6,
                      background: "var(--mantle)",
                      fontFamily: "var(--font-mono)", fontSize: 10,
                      color: "var(--subtext1)", whiteSpace: "pre-wrap", wordBreak: "break-all",
                      maxHeight: 200, overflowY: "auto",
                    }}>
                      {combined.slice(-2000)}{combined.length > 2000 ? "\n…" : ""}
                    </pre>
                  </div>
                </div>
              );
            }

            const ev = g.ev;
            const m = EVENT_META[ev.event_type] ?? { label: ev.event_type, color: "var(--overlay0)", dot: "var(--overlay0)" };
            const summary = summarise(ev);
            const ts = new Date(ev.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            return (
              <div key={ev.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "4px 0" }}>
                <div style={{
                  width: 11, height: 11, borderRadius: "50%", flexShrink: 0, marginTop: 3,
                  background: m.dot, border: "2px solid var(--mantle)",
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: m.color }}>{m.label}</span>
                    <span style={{ fontSize: 9, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{ts}</span>
                  </div>
                  {summary && (
                    <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 1, wordBreak: "break-word" }}>
                      {summary}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {isActive && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 11, height: 11, borderRadius: "50%", flexShrink: 0, marginTop: 3, background: "var(--green)", animation: "pulse 1.5s ease-in-out infinite" }} />
              <span style={{ fontSize: 11, color: "var(--overlay0)" }}>Running…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Markdown Viewer Modal ─────────────────────────────── */

// Label → badge color mapping
const LABEL_COLORS: Record<string, string> = {
  Input:  "var(--teal)",
  Output: "var(--blue)",
  Spec:   "var(--mauve)",
};

// Shared markdown component overrides — defined in lib/md-components.tsx
import MD_COMPONENTS from "@/lib/md-components";

function MarkdownModal({
  label = "Output",
  outputRef,
  agentName,
  githubRef,
  onClose,
}: {
  label?: string;
  outputRef: string;
  /** Set when label === "Spec" — fetches contract instead of staging artifact */
  agentName?: string;
  githubRef: AgentRun["github_ref"] | null;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Build GitHub URLs for linking (not fetching)
  const ghRepo = githubRef?.repo ?? null;
  const ghBranch = githubRef?.branch ?? "main";
  const ghFileUrl = ghRepo ? `https://github.com/${ghRepo}/blob/${ghBranch}/${outputRef}` : null;

  useEffect(() => {
    async function fetchMd() {
      setLoading(true);
      setError(null);
      try {
        // Spec: fetch from contracts API (built-in) or agent_definitions (freestyle custom)
        if (label === "Spec" && agentName) {
          const res = await fetch(`/api/artifact?type=contract&agent=${encodeURIComponent(agentName)}`);
          if (res.ok) { setContent(await res.text()); return; }
          // 404 means no file-based contract — treat as no spec available
          setContent(`_No SIPOC contract for **${agentName}**. This is a freestyle custom agent._`);
          return;
        }

        // 1. Try local API (serves from .staging/ on the server)
        const localRes = await fetch(`/api/artifact?ref=${encodeURIComponent(outputRef)}`);
        if (localRes.ok) {
          setContent(await localRes.text());
          return;
        }

        // 2. Fallback to GitHub raw content if github_ref is set
        if (ghRepo) {
          const raw = `https://raw.githubusercontent.com/${ghRepo}/${ghBranch}/${outputRef}`;
          const ghRes = await fetch(raw);
          if (ghRes.ok) {
            setContent(await ghRes.text());
            return;
          }
        }

        throw new Error("Artifact not available locally or on GitHub");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to fetch");
      } finally {
        setLoading(false);
      }
    }
    fetchMd();
  }, [outputRef, agentName, label, ghRepo, ghBranch]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--mantle)", border: "1px solid var(--surface1)",
          borderRadius: 16, width: "90vw", maxWidth: 720,
          maxHeight: "80vh", overflow: "hidden",
          display: "flex", flexDirection: "column",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 20px", borderBottom: "1px solid var(--surface1)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
              background: `${LABEL_COLORS[label] ?? "var(--blue)"}20`,
              color: LABEL_COLORS[label] ?? "var(--blue)",
              flexShrink: 0,
            }}>{label}</span>
            <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--subtext0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{outputRef.split("/").pop()}</span>
            {ghFileUrl && (
              <a
                href={ghFileUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="View on GitHub"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0,
                  fontSize: 11, color: "var(--teal)", textDecoration: "none",
                  padding: "2px 8px", borderRadius: 4,
                  background: "var(--surface1)",
                  transition: "all 0.15s ease",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                GitHub
              </a>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              fontSize: 18, color: "var(--overlay0)", cursor: "pointer",
              background: "none", border: "none",
              transition: "all 0.15s ease",
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          {loading && <div style={{ color: "var(--overlay0)" }}>Loading...</div>}
          {error && <div style={{ color: "var(--red)", fontSize: 13 }}>Error: {error}</div>}
          {content && (
            <div style={{ lineHeight: 1.7 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                {content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Dir Browser Modal ─────────────────────────────────── */

/**
 * Shows files inside one of the sprint staging subdirectories:
 *   _audit/{agent}/   _docs/{agent}/   _workspace/{agent}/
 *
 * For local backend: lists files with their relative paths (copy-to-clipboard).
 * For Supabase: lists files — clicking triggers download via the artifact API.
 */
function DirBrowserModal({
  projectId,
  sprintId,
  subdir,
  label,
  onClose,
  authToken,
}: {
  projectId: string;
  sprintId: string;
  subdir: string;   // e.g. "_audit/carlos-cto"
  label: string;
  onClose: () => void;
  authToken: string | null;
}) {
  const [files, setFiles]         = useState<{ path: string; size: number | null }[]>([]);
  const [backend, setBackend]     = useState<"supabase" | "local" | "unavailable" | null>(null);
  // localBase removed — paths are now relative only (no absolute paths exposed)
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [copied, setCopied]       = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/projects/${projectId}/sprints/${sprintId}/files?subdir=${encodeURIComponent(subdir)}`;
        const res = await fetch(url, authToken
          ? { headers: { Authorization: `Bearer ${authToken}` } }
          : {});
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json() as {
          storageFiles: { path: string; size: number | null }[];
          storageBackend: "supabase" | "local" | "unavailable";
        };
        setFiles(data.storageFiles);
        setBackend(data.storageBackend);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [projectId, sprintId, subdir, authToken]);

  function copyPath(p: string) {
    const full = subdir ? `${subdir}/${p}` : p;
    navigator.clipboard.writeText(full).catch(() => {});
    setCopied(p);
    setTimeout(() => setCopied(null), 1500);
  }

  const labelColor: Record<string, string> = { Audit: "var(--mauve)", Docs: "var(--teal)", Workspace: "var(--blue)" };
  const color = labelColor[label] ?? "var(--blue)";

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--mantle)", border: "1px solid var(--surface1)", borderRadius: 16, width: "90vw", maxWidth: 640, maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column" }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid var(--surface1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: `${color}20`, color }}>{label}</span>
            <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--subtext0)" }}>{subdir}</span>
            {backend && (
              <span style={{ fontSize: 10, color: "var(--overlay0)", padding: "1px 6px", borderRadius: 3, background: "var(--surface1)" }}>{backend}</span>
            )}
          </div>
          <button onClick={onClose} style={{ fontSize: 18, color: "var(--overlay0)", cursor: "pointer", background: "none", border: "none" }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {loading && <div style={{ color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>}
          {error && <div style={{ color: "var(--red)", fontSize: 13 }}>Error: {error}</div>}
          {!loading && !error && files.length === 0 && (
            <div style={{ color: "var(--overlay0)", fontSize: 13 }}>No files found in {subdir}/</div>
          )}
          {files.map((f) => (
            <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--surface0)" }}>
              <span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
              {f.size != null && (
                <span style={{ fontSize: 10, color: "var(--overlay0)", flexShrink: 0 }}>{f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}K`}</span>
              )}
              {backend === "local" ? (
                <button
                  onClick={() => copyPath(f.path)}
                  style={{ fontSize: 10, color: copied === f.path ? "var(--green)" : "var(--overlay0)", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}
                  title="Copy full path"
                >
                  {copied === f.path ? "✓" : "⎘"}
                </button>
              ) : (
                <a
                  href={`/api/artifact?ref=${encodeURIComponent(f.path)}`}
                  download
                  style={{ fontSize: 10, color: "var(--teal)", textDecoration: "none", flexShrink: 0 }}
                  title="Download"
                >
                  ↓
                </a>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Artifact Tree Modal ────────────────────────────────── */

function ArtifactTreeModal({
  projectId,
  projectSlug,
  sprintId,
  sprintNum,
  authToken,
  onClose,
}: {
  projectId: string;
  projectSlug?: string;
  sprintId: string | null;
  sprintNum?: number;
  authToken: string | null;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<{ path: string; size: number | null }[]>([]);
  const [storageBackend, setStorageBackend] = useState<"supabase" | "local" | "unavailable">("unavailable");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!sprintId) { setLoading(false); return; }
    setLoading(true);
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = authToken || session?.access_token || null;
      if (!token) { setError("Not authenticated"); setLoading(false); return; }
      return fetch(`/api/projects/${projectId}/sprints/${sprintId}/files`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    })()
      .then(async (r) => {
        if (!r || !r.ok) return;
        const data = await r.json() as {
          storageFiles: { path: string; size: number | null }[];
          storageBackend?: "supabase" | "local" | "unavailable";
        };
        setFiles(data.storageFiles ?? []);
        if (data.storageBackend) setStorageBackend(data.storageBackend);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId, sprintId, authToken]);

  // Load file preview when selected
  useEffect(() => {
    if (!selectedFile || !sprintId) { setPreviewContent(null); return; }
    setPreviewLoading(true);
    (async () => {
      const { data: { session: s } } = await supabase.auth.getSession();
      const token = authToken || s?.access_token || null;
      if (!token) { setPreviewLoading(false); return; }
      try {
        // Build ref with projectSlug prefix for the artifact API
        const ref = projectSlug ? `${projectSlug}/${selectedFile}` : selectedFile;
        const res = await fetch(`/api/artifact?ref=${encodeURIComponent(ref)}${sprintNum ? `&sprintNum=${sprintNum}` : ""}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          setPreviewContent(await res.text());
        } else {
          setPreviewContent(`Error loading file: ${res.status}`);
        }
      } catch {
        setPreviewContent("Error loading file");
      } finally {
        setPreviewLoading(false);
      }
    })();
  }, [selectedFile, sprintId, authToken]);

  // Build tree structure from flat file list
  type TreeNode = { name: string; isDir: boolean; size: number | null; children: TreeNode[]; path: string };
  const tree = React.useMemo(() => {
    const root: TreeNode = { name: "", isDir: true, size: null, children: [], path: "" };
    for (const f of files) {
      const parts = f.path.split("/");
      let node = root;
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i]!;
        const isLast = i === parts.length - 1;
        let child = node.children.find((c) => c.name === name);
        if (!child) {
          child = { name, isDir: !isLast, size: isLast ? f.size : null, children: [], path: parts.slice(0, i + 1).join("/") };
          node.children.push(child);
        }
        node = child;
      }
    }
    // Sort: dirs first, then alphabetical
    const sortTree = (n: TreeNode) => {
      n.children.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      n.children.forEach(sortTree);
    };
    sortTree(root);
    return root;
  }, [files]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--mantle)", border: "1px solid var(--surface1)",
          borderRadius: 16, width: "92vw", maxWidth: 960,
          height: "82vh", overflow: "hidden",
          display: "flex", flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 20px", borderBottom: "1px solid var(--surface1)", flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {storageBackend === "supabase"
              ? <Cloud size={15} color="var(--teal)" />
              : <FolderOpen size={15} color="var(--teal)" />}
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Sprint Files</span>
            <span style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 4,
              background: "var(--teal)20", color: "var(--teal)",
            }}>{files.length}</span>
          </div>
          <button
            onClick={onClose}
            style={{ fontSize: 18, color: "var(--overlay0)", cursor: "pointer", background: "none", border: "none" }}
          >
            ✕
          </button>
        </div>

        {/* Body: tree + preview */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Left: directory tree */}
        <div style={{ width: 280, flexShrink: 0, overflowY: "auto", padding: "12px 16px", borderRight: "1px solid var(--surface1)" }}>
          {loading && (
            <div style={{ color: "var(--overlay0)", fontSize: 13, padding: "20px 0" }}>Loading…</div>
          )}
          {error && (
            <div style={{ color: "var(--red)", fontSize: 13 }}>Error: {error}</div>
          )}
          {!loading && files.length === 0 && (
            <div style={{ color: "var(--overlay0)", fontSize: 13, textAlign: "center", padding: "40px 0" }}>
              No files in this sprint yet.
            </div>
          )}
          {!loading && files.length > 0 && (() => {
            function TreeNodeView({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
              const [open, setOpen] = React.useState(depth < 2);
              if (node.isDir) {
                const icon = node.name.startsWith("_audit") ? "📋"
                  : node.name.startsWith("_docs") ? "📄"
                  : node.name.startsWith("_workspace") ? "💻"
                  : "📁";
                return (
                  <div>
                    <button onClick={() => setOpen(o => !o)} style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "3px 0", paddingLeft: depth * 16,
                      background: "none", border: "none", cursor: "pointer",
                      fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--text)",
                      width: "100%", textAlign: "left",
                    }}>
                      <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{open ? "▼" : "▶"}</span>
                      <span>{icon}</span>
                      <span style={{ fontWeight: 600 }}>{node.name}</span>
                      <span style={{ fontSize: 10, color: "var(--overlay0)", marginLeft: 4 }}>
                        ({node.children.length})
                      </span>
                    </button>
                    {open && node.children.map(c => (
                      <TreeNodeView key={c.path} node={c} depth={depth + 1} />
                    ))}
                  </div>
                );
              }
              const sizeStr = node.size != null
                ? node.size < 1024 ? `${node.size} B` : `${(node.size / 1024).toFixed(1)} KB`
                : "";
              const isSelected = selectedFile === node.path;
              return (
                <button
                  onClick={() => setSelectedFile(node.path)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, width: "100%",
                    padding: "3px 4px", paddingLeft: depth * 16,
                    fontSize: 11, background: isSelected ? "var(--surface1)" : "none",
                    border: "none", cursor: "pointer", textAlign: "left",
                    borderRadius: 4,
                  }}>
                  <FileText size={10} color={isSelected ? "var(--teal)" : "var(--overlay0)"} style={{ flexShrink: 0 }} />
                  <span style={{ color: isSelected ? "var(--text)" : "var(--subtext0)", fontFamily: "var(--font-mono)", fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {node.name}
                  </span>
                  {sizeStr && <span style={{ fontSize: 9, color: "var(--overlay0)", flexShrink: 0 }}>{sizeStr}</span>}
                </button>
              );
            }
            return tree.children.map(c => <TreeNodeView key={c.path} node={c} />);
          })()}
        </div>

        {/* Right: file preview */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {!selectedFile && (
            <div style={{ color: "var(--overlay0)", fontSize: 13, textAlign: "center", paddingTop: 48 }}>
              Select a file to preview
            </div>
          )}
          {selectedFile && previewLoading && (
            <div style={{ color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>
          )}
          {selectedFile && !previewLoading && previewContent && (
            <>
              <div style={{
                marginBottom: 12, fontSize: 10, fontFamily: "var(--font-mono)",
                color: "var(--overlay0)", paddingBottom: 8,
                borderBottom: "1px solid var(--surface1)",
              }}>
                {selectedFile}
              </div>
              {selectedFile.endsWith(".md") ? (
                <div style={{ lineHeight: 1.7 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                    {previewContent}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre style={{
                  fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)",
                  whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.6,
                }}>
                  {previewContent}
                </pre>
              )}
            </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Agent Run History ─────────────────────────────────── */

function AgentRunHistory({
  runs,
  onViewOutput,
}: {
  runs: AgentRun[];
  onViewOutput: (ref: string, githubRef: AgentRun["github_ref"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const totalCost = runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);

  return (
    <div style={{ borderTop: "1px solid var(--surface1)", paddingTop: 12 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 6, background: "none",
          border: "none", cursor: "pointer", color: "var(--subtext0)",
          fontSize: 11, padding: 0, width: "100%",
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? "▾" : "▸"}</span>
        <span>All Executions</span>
        <span style={{ marginLeft: "auto", color: "var(--overlay0)" }}>
          {runs.length} runs · ${totalCost.toFixed(4)}
        </span>
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {runs.map((r) => {
            const isLatest = r === runs[0];
            const date = r.started_at
              ? new Date(r.started_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
              : new Date(r.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
            return (
              <div
                key={r.id}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "6px 8px", borderRadius: 6,
                  background: "var(--surface0)",
                  border: `1px solid ${isLatest ? "var(--surface2)" : "transparent"}`,
                  fontSize: 11,
                }}
              >
                {/* run type badge */}
                <span style={{
                  padding: "1px 5px", borderRadius: 4, fontSize: 9, fontWeight: 600,
                  background: r.run_type === "run-once" ? "rgba(223,142,29,0.15)" : "rgba(136,192,208,0.15)",
                  color: r.run_type === "run-once" ? "var(--yellow, #df8e1d)" : "var(--sapphire, #88c0d0)",
                  textTransform: "uppercase", letterSpacing: "0.4px", flexShrink: 0,
                }}>
                  {r.run_type === "run-once" ? "once" : "sprint"}
                </span>
                {/* status dot */}
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                  background: r.status === "done" ? "var(--green)" : r.status === "failed" ? "var(--red)" : "var(--overlay0)",
                }} />
                <span style={{ color: "var(--subtext0)", flex: 1 }}>{date}</span>
                <span style={{ color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>
                  ${(r.cost_usd ?? 0).toFixed(4)}
                </span>
                {/* view output button — only for latest (artifacts from last run) */}
                {isLatest && r.output_ref && (
                  <button
                    onClick={() => onViewOutput(r.output_ref!, r.github_ref)}
                    style={{
                      fontSize: 10, color: "var(--green)", background: "none", border: "none",
                      cursor: "pointer", textDecoration: "underline", flexShrink: 0,
                    }}
                  >output ↗</button>
                )}
                {isLatest && (
                  <span style={{
                    padding: "1px 5px", borderRadius: 4, fontSize: 9,
                    background: "rgba(64,160,43,0.15)", color: "var(--green, #40a02b)",
                    textTransform: "uppercase", letterSpacing: "0.4px", flexShrink: 0,
                  }}>latest</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Agent Drawer ──────────────────────────────────────── */

function AgentDrawer({
  agent,
  run,
  allRunsForAgent,
  runsByAgent,
  projectId,
  projectStatus,
  stepNum,
  onClose,
  onViewOutput,
  onViewInput,
  onViewSpec,
  onBrowseDir,
  onApprove,
  onReject,
}: {
  agent: string;
  run: AgentRun | null;
  allRunsForAgent: AgentRun[];
  runsByAgent: Map<string, AgentRun>;
  projectId: string;
  projectStatus: string;
  stepNum: number | null;
  onClose: () => void;
  onViewOutput: (ref: string, githubRef: AgentRun["github_ref"]) => void;
  onViewInput: (ref: string) => void;
  onViewSpec: (agent: string) => void;
  onBrowseDir: (subdir: string, label: string, sprintId: string) => void;
  onApprove: (runId: string, instructions?: string) => void;
  onReject: (runId: string, comment: string) => void;
}) {
  const meta = AGENT_META[agent] ?? { squad: "Unknown", label: agent, color: "#666" };
  const { inputRows } = useAgentContract(agent);
  const [runOnceOpen, setRunOnceOpen] = useState(false);
  const [runOnceNote, setRunOnceNote] = useState("");
  const [runOnceBusy, setRunOnceBusy] = useState(false);
  const [runOnceMsg, setRunOnceMsg] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  const canRunOnce = stepNum !== null;

  async function handleRunOnce() {
    if (!stepNum) return;
    setRunOnceBusy(true);
    setRunOnceMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/projects/${projectId}/continue`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fromStep: stepNum, toStep: stepNum, note: runOnceNote.trim() || undefined }),
      });
      const data = await res.json() as { triggered?: boolean; resume_step?: number; error?: string };
      if (!res.ok) {
        setRunOnceMsg({ type: "error", text: data.error ?? `Error ${res.status}` });
      } else {
        setRunOnceMsg({ type: "ok", text: data.triggered ? `Running step ${stepNum} (${meta.label})…` : "No trigger key — use CLI" });
        setRunOnceOpen(false);
      }
    } catch (e: unknown) {
      setRunOnceMsg({ type: "error", text: (e as Error).message });
    } finally {
      setRunOnceBusy(false);
    }
  }

  // Build a flat list of all available output_refs from all runs
  const allRefs: { agent: string; ref: string; run: AgentRun }[] = [];
  for (const [a, r] of runsByAgent.entries()) {
    if (r.output_ref) allRefs.push({ agent: a, ref: r.output_ref, run: r });
  }

  // Match each input row to an available ref by prefix
  const matchedInputs = inputRows.map((row) => {
    if (!row.prefix) return { ...row, matched: null as typeof allRefs[0] | null };
    const matched = allRefs.find((r) =>
      (r.ref.split("/").pop() ?? "").toUpperCase().startsWith(row.prefix!)
    ) ?? null;
    return { ...row, matched };
  });

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 40,
          background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)",
        }}
      />

      {/* Drawer */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 41,
        width: "min(480px, 92vw)",
        background: "var(--mantle)",
        borderLeft: "1px solid var(--surface1)",
        display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 32px rgba(0,0,0,0.4)",
        animation: "slideInRight 0.2s ease",
      }}>
        {/* Drawer header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 20px",
          borderBottom: "1px solid var(--surface1)",
          flexShrink: 0,
        }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
          <span style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", flex: 1 }}>{meta.label}</span>
          <span style={{
            fontSize: 10, color: "var(--overlay0)", background: "var(--surface1)",
            padding: "2px 8px", borderRadius: 4,
          }}>{meta.squad}</span>
          <button
            onClick={onClose}
            style={{
              marginLeft: 8, fontSize: 18, lineHeight: 1,
              color: "var(--overlay0)", background: "none", border: "none",
              cursor: "pointer", padding: "2px 6px", borderRadius: 4,
              transition: "color 0.15s",
            }}
            title="Close (Esc)"
          >✕</button>
        </div>

        {/* Drawer body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 20 }}>

          {/* ── Special Operations ── */}
          <div>
            <div style={{
              fontSize: 10, fontWeight: 600, color: "var(--overlay0)",
              textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 8,
            }}>
              Special Operations
            </div>

            {/* Run-Once button */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <button
                onClick={() => { setRunOnceOpen((o) => !o); setRunOnceMsg(null); }}
                disabled={!canRunOnce}
                title={
                  !canRunOnce
                    ? "No step number available for this agent"
                    : `Run ${meta.label} once (step ${stepNum})`
                }
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "8px 12px", borderRadius: 8,
                  border: `1px solid ${canRunOnce ? "var(--yellow, #df8e1d)40" : "var(--surface2)"}`,
                  background: canRunOnce ? "rgba(223,142,29,0.06)" : "var(--surface1)",
                  cursor: canRunOnce ? "pointer" : "not-allowed",
                  color: canRunOnce ? "var(--yellow, #df8e1d)" : "var(--overlay0)",
                  fontSize: 12, fontWeight: 500,
                  opacity: canRunOnce ? 1 : 0.5,
                  transition: "all 0.15s",
                  width: "100%", textAlign: "left",
                }}
              >
                <Zap size={13} />
                Run-Once
              </button>

              {/* Run-Once panel (inline modal) */}
              {runOnceOpen && (
                <div style={{
                  background: "var(--surface0)", borderRadius: 8,
                  border: "1px solid var(--yellow, #df8e1d)30",
                  padding: 12, display: "flex", flexDirection: "column", gap: 8,
                }}>
                  <div style={{ fontSize: 11, color: "var(--subtext0)" }}>
                    This will run <strong>{meta.label}</strong> (step {stepNum}) in isolation.
                    The project will resume from &quot;paused&quot; state after.
                  </div>
                  <textarea
                    value={runOnceNote}
                    onChange={(e) => setRunOnceNote(e.target.value)}
                    placeholder="Special instructions for this run (optional)…"
                    rows={3}
                    style={{
                      width: "100%", resize: "vertical",
                      background: "var(--mantle)", color: "var(--text)",
                      border: "1px solid var(--surface2)", borderRadius: 6,
                      padding: "8px 10px", fontSize: 12,
                      fontFamily: "var(--font-sans)", boxSizing: "border-box",
                    }}
                  />
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      onClick={() => { setRunOnceOpen(false); setRunOnceNote(""); }}
                      style={{
                        padding: "5px 12px", borderRadius: 6, border: "1px solid var(--surface2)",
                        background: "none", cursor: "pointer", color: "var(--subtext0)", fontSize: 11,
                      }}
                    >Cancel</button>
                    <button
                      onClick={handleRunOnce}
                      disabled={runOnceBusy}
                      style={{
                        padding: "5px 12px", borderRadius: 6,
                        border: "none", background: "var(--yellow, #df8e1d)",
                        cursor: runOnceBusy ? "not-allowed" : "pointer",
                        color: "#1e1e2e", fontSize: 11, fontWeight: 600,
                        opacity: runOnceBusy ? 0.6 : 1,
                      }}
                    >{runOnceBusy ? "Starting…" : "Run Agent"}</button>
                  </div>
                </div>
              )}

              {/* Feedback */}
              {runOnceMsg && (
                <div style={{
                  fontSize: 11, padding: "6px 10px", borderRadius: 6,
                  background: runOnceMsg.type === "error" ? "rgba(210,15,57,0.08)" : "rgba(64,160,43,0.08)",
                  color: runOnceMsg.type === "error" ? "var(--red)" : "var(--green, #40a02b)",
                  border: `1px solid ${runOnceMsg.type === "error" ? "var(--red)30" : "var(--green, #40a02b)30"}`,
                }}>
                  {runOnceMsg.text}
                </div>
              )}
            </div>
          </div>

          {/* SIPOC Required Inputs section */}
          {matchedInputs.length > 0 && (
            <div>
              <div style={{
                fontSize: 10, fontWeight: 600, color: "var(--overlay0)",
                textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 8,
              }}>
                Required Inputs (SIPOC)
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {matchedInputs.map((row, i) => {
                  const m = row.matched;
                  const isExternal = row.prefix === null;
                  const supplierMeta = m ? AGENT_META[m.agent] : null;
                  return (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 10px", borderRadius: 6,
                      background: m ? "var(--green)08" : "var(--surface1)",
                      border: `1px solid ${m ? "var(--green)30" : "var(--surface2)"}`,
                    }}>
                      <div style={{
                        width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                        background: m ? "var(--green)" : isExternal ? "var(--overlay0)" : "var(--surface2)",
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 12, color: m ? "var(--text)" : "var(--subtext0)", fontWeight: m ? 500 : 400 }}>
                          {row.artifact}
                        </span>
                        <span style={{
                          marginLeft: 6, fontSize: 10, color: "var(--overlay0)",
                          fontFamily: "var(--font-mono)",
                        }}>
                          {row.format}
                        </span>
                      </div>
                      {m ? (
                        <button
                          onClick={() => onViewOutput(m.ref, m.run.github_ref)}
                          style={{
                            fontSize: 10, color: "var(--green)", background: "none", border: "none",
                            cursor: "pointer", fontFamily: "var(--font-mono)", textDecoration: "underline",
                            flexShrink: 0,
                          }}
                        >
                          {supplierMeta?.label ?? m.agent} ↗
                        </button>
                      ) : isExternal ? (
                        <span style={{ fontSize: 10, color: "var(--overlay0)", flexShrink: 0 }}>external</span>
                      ) : (
                        <span style={{ fontSize: 10, color: "var(--overlay0)", flexShrink: 0 }}>pending</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Run details — latest run */}
          {run ? (
            <AgentDetail
              run={run}
              projectId={projectId}
              onViewOutput={onViewOutput}
              onViewInput={onViewInput}
              onViewSpec={onViewSpec}
              onBrowseDir={onBrowseDir}
              onApprove={onApprove}
              onReject={onReject}
            />
          ) : (
            <div style={{ color: "var(--overlay0)", fontSize: 13 }}>
              Agent <span style={{ color: "var(--text)" }}>{agent}</span> has not run yet in this project.
            </div>
          )}

          {/* All runs history */}
          {allRunsForAgent.length > 1 && (
            <AgentRunHistory runs={allRunsForAgent} onViewOutput={onViewOutput} />
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </>
  );
}

/* ─── Squad Section ──────────────────────────────────────── */

function SquadSection({
  squad,
  agents,
  runsByAgent,
  selectedAgent,
  onSelectAgent,
  color,
}: {
  squad: string;
  agents: string[];
  runsByAgent: Map<string, AgentRun>;
  selectedAgent: string | null;
  onSelectAgent: (agent: string | null) => void;
  color: string;
}) {
  const squadRuns = agents.map((a) => runsByAgent.get(a)).filter(Boolean) as AgentRun[];
  const running = squadRuns.filter((r) => r.status === "running").length;
  const waiting = squadRuns.filter((r) => r.status === "waiting").length;
  const done = squadRuns.filter((r) => r.status === "done").length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
        <span style={{
          fontSize: 11, fontWeight: 600, color: "var(--subtext0)",
          textTransform: "uppercase", letterSpacing: "0.6px",
        }}>
          {squad}
        </span>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto", fontSize: 10 }}>
          {running > 0 && <span style={{ color: "var(--green)" }}>{running} running</span>}
          {waiting > 0 && <span style={{ color: "var(--yellow)" }}>{waiting} waiting</span>}
          {done > 0 && <span style={{ color: "var(--overlay0)" }}>{done} done</span>}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {agents.map((agent) => (
          <AgentNode
            key={agent}
            agent={agent}
            run={runsByAgent.get(agent) ?? null}
            isActive={selectedAgent === agent}
            onClick={() => onSelectAgent(selectedAgent === agent ? null : agent)}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── Pipeline Segment ───────────────────────────────────── */

interface SegmentStep {
  agent: string;
  role: "prev" | "active" | "next";
  status: AgentRun["status"] | "idle";
  gate: string | null;
}

function StartButton({ projectId, status }: { projectId: string; status: string }) {
  const [busy, setBusy] = useState(false);

  async function handleStart(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/projects/${projectId}/continue`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const json = await res.json() as { triggered?: boolean; cli_command?: string; error?: string };
      if (!res.ok) alert(`Start failed: ${json.error}`);
      else if (!json.triggered) alert(`Run from terminal:\n\n${json.cli_command}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 14px", borderRadius: 8,
      background: "var(--surface0)", border: "1px solid var(--surface1)",
    }}>
      {status === "running" && (
        <span style={{ fontSize: 11, color: "var(--yellow)" }}>
          Previous start attempt may be stuck.
        </span>
      )}
      <button
        onClick={handleStart}
        disabled={busy}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 16px", borderRadius: 6, border: "none",
          background: "var(--green)", color: "var(--crust)",
          fontSize: 12, fontWeight: 600, cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        <Play size={11} />
        {busy ? "Starting…" : "Start Pipeline"}
      </button>
    </div>
  );
}

function PipelineSegment({
  pipeline,
  runsByAgent,
  onSelectAgent,
  projectId,
  projectStatus,
  onOpenArtifactTree,
  localWorkspacePath,
  sprintIntent,
}: {
  pipeline: { step: number; agent: string; gate: string | null }[];
  runsByAgent: Map<string, AgentRun>;
  onSelectAgent: (agent: string) => void;
  projectId: string;
  projectStatus: string;
  onOpenArtifactTree: () => void;
  localWorkspacePath?: string;
  /** Drives the "discovery" / "execution" badge in the segment header so
   *  operators can tell which kind of sprint they're watching. */
  sprintIntent?: SprintIntent | null;
}) {
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const busy = busyOp !== null;

  const anyAgentActive = Array.from(runsByAgent.values()).some(
    (r) => r.status === "running" || r.status === "waiting",
  );
  const canStop        = projectStatus === "running" && anyAgentActive;
  const canMarkComplete = projectStatus === "running" && !anyAgentActive;
  const canContinue    = RESUMABLE_STATUSES.includes(projectStatus) || projectStatus === "idle";
  const canReset       = ACTIVE_STATUSES.includes(projectStatus);

  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? "";
  }

  async function handleContinue(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusyOp("continue");
    try {
      const res = await fetch(`/api/projects/${projectId}/continue`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json() as { triggered?: boolean; cli_command?: string; error?: string };
      if (!res.ok) alert(`Continue failed: ${json.error}`);
      else if (!json.triggered) alert(`Run from terminal:\n\n${json.cli_command}`);
    } finally {
      setBusyOp(null);
    }
  }

  async function handleReset(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Reset project to ready? Use only if the pipeline is stuck.")) return;
    setBusyOp("reset");
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "idle" }),
      });
      if (!res.ok) {
        const json = await res.json() as { error?: string };
        alert(`Reset failed: ${json.error}`);
      }
    } finally {
      setBusyOp(null);
    }
  }

  async function handlePause(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusyOp("pause");
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paused" }),
      });
      if (!res.ok) {
        const json = await res.json() as { error?: string };
        alert(`Pause failed: ${json.error}`);
      }
    } finally {
      setBusyOp(null);
    }
  }

  async function handleMarkComplete(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusyOp("complete");
    try {
      // Project no longer has a 'completed' state. Marking the work
      // done here means: stop the active sprint and return the project
      // to idle. The sprint row keeps its terminal status separately.
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "idle" }),
      });
      if (!res.ok) {
        const json = await res.json() as { error?: string };
        alert(`Mark complete failed: ${json.error}`);
      }
    } finally {
      setBusyOp(null);
    }
  }

  // Find the "active" step: running or waiting. Fall back to the most-recent done step + 1.
  // When the project hasn't started yet (idle / locked) don't highlight any agent.
  const notStarted = projectStatus === "idle" || projectStatus === "locked";

  const runningStep = pipeline.find((s) => {
    const r = runsByAgent.get(s.agent);
    return r?.status === "running" || r?.status === "waiting";
  });

  let activeIdx = runningStep ? pipeline.indexOf(runningStep) : -1;

  if (!notStarted && activeIdx === -1) {
    // No active agent — find the last done step
    let lastDoneIdx = -1;
    for (let i = 0; i < pipeline.length; i++) {
      if (runsByAgent.get(pipeline[i]!.agent)?.status === "done") lastDoneIdx = i;
    }
    activeIdx = lastDoneIdx + 1 < pipeline.length ? lastDoneIdx + 1 : lastDoneIdx;
  }

  // When not started: show first 3 agents neutrally (no active highlight)
  const sliceStart = notStarted ? 0 : Math.max(0, activeIdx - 1);
  const sliceEnd   = notStarted
    ? Math.min(pipeline.length, 3)
    : Math.min(pipeline.length, activeIdx + 2);
  const segment: SegmentStep[] = pipeline.slice(sliceStart, sliceEnd).map((s, i) => {
    const absIdx = sliceStart + i;
    const run = runsByAgent.get(s.agent);
    return {
      agent: s.agent,
      role: notStarted ? "next" : (absIdx < activeIdx ? "prev" : absIdx === activeIdx ? "active" : "next"),
      status: run?.status ?? "idle",
      gate: s.gate,
    };
  });

  if (segment.length === 0) return null;

  const roleStyle = (role: SegmentStep["role"], status: SegmentStep["status"]): React.CSSProperties => {
    const isActive = role === "active";
    const color =
      status === "running" ? "var(--green)" :
      status === "waiting" ? "var(--peach)" :
      status === "done" ? "var(--overlay0)" :
      status === "failed" ? "var(--red)" :
      isActive ? "var(--blue)" :
      "var(--surface2)";

    return {
      display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
      opacity: role === "prev" ? 0.45 : role === "next" ? 0.65 : 1,
    };
  };

  const iconBtn = (title: string, onClick: (e: React.MouseEvent) => void, color: string, children: React.ReactNode, op?: string) => {
    const isThisOp = op !== undefined && busyOp === op;
    return (
      <button
        title={title}
        onClick={onClick}
        disabled={busy}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 24, height: 24, borderRadius: 5, border: "none",
          background: "transparent", color, cursor: busy ? "default" : "pointer",
          opacity: isThisOp ? 0.35 : busy ? 0.65 : 1, flexShrink: 0,
          transition: "opacity 0.15s ease",
        }}
      >
        {children}
      </button>
    );
  };

  // Intent badge — leading the pipeline so the operator immediately knows
  // whether the current sprint is figuring-out-what-to-do (discovery) or
  // delivering-a-defined-task (execution). Hidden when no sprint is running.
  const intentBadge = sprintIntent ? (() => {
    const v = sprintIntent === "discovery"
      ? { bg: "rgba(203,166,247,0.15)", fg: "var(--mauve, #cba6f7)", label: "Discovery", title: "Discovery sprint — agents decide what to do (populate backlog, write specs)" }
      : { bg: "rgba(28,191,107,0.15)",  fg: "var(--green, #40a02b)", label: "Execution", title: "Execution sprint — delivers the defined backlog item" };
    return (
      <span title={v.title} style={{
        fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
        textTransform: "uppercase",
        padding: "2px 7px", borderRadius: 4,
        background: v.bg, color: v.fg, flexShrink: 0,
        marginRight: 8,
      }}>
        {v.label}
      </span>
    );
  })() : null;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 0,
      padding: "6px 12px", borderRadius: 8,
      background: "var(--surface0)", border: "1px solid var(--surface1)",
      fontFamily: "var(--font-mono)",
    }}>
      {intentBadge}
      {segment.map((s, i) => {
        const meta = AGENT_META[s.agent];
        const isActive = s.role === "active";
        const dotColor =
          s.status === "running" ? "var(--green)" :
          s.status === "waiting" ? "var(--peach)" :
          s.status === "done" ? "var(--overlay0)" :
          s.status === "failed" ? "var(--red)" :
          isActive ? "var(--blue)" : "var(--surface2)";

        return (
          <React.Fragment key={s.agent}>
            {i > 0 && (
              <div style={{ color: "var(--surface2)", fontSize: 10, padding: "0 6px", flexShrink: 0 }}>→</div>
            )}
            <button
              onClick={() => onSelectAgent(s.agent)}
              style={{
                ...roleStyle(s.role, s.status),
                background: "none", border: "none", padding: "4px 6px", borderRadius: 6,
                cursor: "pointer",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--surface1)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
            >
              <div style={{
                fontSize: isActive ? 11 : 10,
                fontWeight: isActive ? 700 : 400,
                color: isActive ? "var(--text)" : "var(--overlay1)",
                whiteSpace: "nowrap",
                display: "flex", alignItems: "center", gap: 4,
              }}>
                <span
                  className={s.status === "running" ? "pulse" : undefined}
                  style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor, flexShrink: 0, display: "inline-block" }}
                />
                {meta?.label ?? s.agent}
                {s.gate === "human" && (
                  <span style={{ fontSize: 8, color: "var(--yellow)", letterSpacing: 0 }}>🔒</span>
                )}
              </div>
              {isActive && (
                <div style={{ fontSize: 9, color: dotColor, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {s.status === "idle" ? "up next" : s.status}
                </div>
              )}
            </button>
          </React.Fragment>
        );
      })}

      {/* Spacer + control icons aligned to the right */}
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", gap: 4, paddingLeft: 8, borderLeft: "1px solid var(--surface1)", marginLeft: 8 }}>
        {canMarkComplete && iconBtn(
          "Pipeline appears finished — mark as completed",
          handleMarkComplete,
          "var(--green)",
          <CheckCircle2 size={13} />,
          "complete",
        )}
        {canStop && iconBtn(
          "Pause pipeline (stops after current agent finishes)",
          handlePause,
          "var(--yellow)",
          <Pause size={12} />,
          "pause",
        )}
        {canContinue && iconBtn(
          "Resume pipeline from last step",
          handleContinue,
          "var(--teal)",
          <Play size={12} />,
          "continue",
        )}
        {canReset && iconBtn(
          "Reset to ready (use if pipeline is stuck)",
          handleReset,
          "var(--overlay1)",
          <RefreshCw size={13} />,
          "reset",
        )}
        {localWorkspacePath ? iconBtn(
          `Copy workspace path: ${localWorkspacePath}`,
          (e) => { e.stopPropagation(); navigator.clipboard.writeText(localWorkspacePath); },
          "var(--teal)",
          <FolderOpen size={13} />,
        ) : iconBtn(
          "Browse generated artifacts (cloud)",
          (e) => { e.stopPropagation(); onOpenArtifactTree(); },
          "var(--mauve)",
          <Cloud size={13} />,
        )}
      </div>
    </div>
  );
}

// Project-side status sets after migration 160. Sprint-side states
// (paused/waiting/pending_save) live on sprints and are surfaced via
// activeSprintStatus where the canvas needs them.
const ACTIVE_STATUSES    = ["running"];
const RESUMABLE_STATUSES = ["queued"];

/* ─── Main Canvas ────────────────────────────────────────── */

interface ProjectCanvasProps {
  projectId: string;
  projectName: string;
  projectSlug?: string;
  projectStatus: string;
  projectPhase: string;
  projectRepoUrl?: string | null;
  projectBaseRef?: string;
  pipeline: { step: number; agent: string; gate: string | null }[];
  /** When provided by a parent that owns the subscription, the canvas skips its own fetch + channel. */
  externalRuns?: AgentRun[];
  /** Active sprint metadata — shown in the header when provided */
  sprintNum?: number;
  sprintBriefing?: string;
  triggerRunId?: string;
  /** Intent of the running sprint — drives the badge in the Agent Pipeline
   *  header so operators can tell at a glance whether they're watching a
   *  discovery (agents decide) or execution (backlog-driven) sprint. */
  sprintIntent?: SprintIntent | null;
  /** Orchestration mode — determines how the folder button behaves */
  executionBackend?: "supabase" | "local";
}

export default function ProjectCanvas({
  projectId,
  projectName,
  projectSlug,
  projectStatus,
  projectPhase,
  projectRepoUrl,
  projectBaseRef = "unversioned",
  pipeline,
  externalRuns,
  sprintNum,
  sprintBriefing,
  triggerRunId,
  sprintIntent,
  executionBackend,
}: ProjectCanvasProps) {
  const [internalRuns, setInternalRuns] = useState<AgentRun[]>([]);
  const runs = externalRuns ?? internalRuns;
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [showArtifactTree, setShowArtifactTree] = useState(false);
  const [viewingArtifact, setViewingArtifact] = useState<{
    ref: string;
    label: string;
    agentName?: string;
    githubRef: AgentRun["github_ref"];
  } | null>(null);
  const [browsingDir, setBrowsingDir] = useState<{
    subdir: string;
    label: string;
    sprintId: string;
    authToken: string | null;
  } | null>(null);

  // Only fetch + subscribe when the parent doesn't supply runs.
  useEffect(() => {
    if (externalRuns !== undefined) return;
    async function fetchRuns() {
      const { data } = await supabase
        .from("agent_runs")
        .select("*")
        .eq("project_id", projectId)
        .order("step", { ascending: true });
      if (data) setInternalRuns(data);
    }
    fetchRuns();
  }, [projectId, externalRuns]);

  useEffect(() => {
    if (externalRuns !== undefined) return;
    const channel = supabase
      .channel(`project-${projectId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_runs", filter: `project_id=eq.${projectId}` },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setInternalRuns((prev) => [...prev, payload.new as AgentRun]);
          } else if (payload.eventType === "UPDATE") {
            setInternalRuns((prev) =>
              prev.map((r) => (r.id === (payload.new as AgentRun).id ? (payload.new as AgentRun) : r))
            );
          }
        }
      )
      .subscribe();
    return () => { channel.unsubscribe().then(() => supabase.removeChannel(channel)); };
  }, [projectId, externalRuns]);

  const runsByAgent = new Map<string, AgentRun>();
  for (const r of runs) {
    const existing = runsByAgent.get(r.agent);
    if (!existing || new Date(r.created_at) > new Date(existing.created_at)) {
      runsByAgent.set(r.agent, r);
    }
  }

  // All runs per agent, sorted newest-first (for history display)
  const allRunsByAgent = new Map<string, AgentRun[]>();
  for (const r of [...runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())) {
    if (!allRunsByAgent.has(r.agent)) allRunsByAgent.set(r.agent, []);
    allRunsByAgent.get(r.agent)!.push(r);
  }

  const selectedRun = selectedAgent ? runsByAgent.get(selectedAgent) : null;
  const totalCost = runs.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  const totalTokens = runs.reduce((sum, r) => sum + r.tokens_in + r.tokens_out, 0);
  const runningCount = runs.filter((r) => r.status === "running").length;
  const waitingCount = runs.filter((r) => r.status === "waiting").length;
  // Count distinct agent slugs with a done run — retries must not inflate the count
  const doneCount = new Set(runs.filter((r) => r.status === "done").map((r) => r.agent)).size;

  // Group pipeline agents by squad.
  // Agents not in AGENT_META (custom / user-defined) are shown under their pipeline
  // phase name (derived from agent_run.squad) or "Custom" — sorted to the end.
  const pipelineAgents = new Set(pipeline.map((s) => s.agent));
  const squadAgents = new Map<string, string[]>();
  for (const agent of pipelineAgents) {
    const meta = AGENT_META[agent];
    // Custom agents: use squad from the most-recent run, fall back to "Custom"
    const latestRun = runs.filter((r) => r.agent === agent).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    const squad = meta?.squad ?? latestRun?.squad ?? "Custom";
    if (!squadAgents.has(squad)) squadAgents.set(squad, []);
    squadAgents.get(squad)!.push(agent);
  }

  // Also include any agents from runs that aren't in pipeline
  for (const r of runs) {
    if (!pipelineAgents.has(r.agent)) {
      const meta = AGENT_META[r.agent];
      const squad = meta?.squad ?? r.squad ?? "Custom";
      if (!squadAgents.has(squad)) squadAgents.set(squad, []);
      if (!squadAgents.get(squad)!.includes(r.agent)) {
        squadAgents.get(squad)!.push(r.agent);
      }
    }
  }

  // Sort squads by SQUAD_ORDER; unknown/custom squads go to the end
  const sortedSquads = [...squadAgents.entries()].sort((a, b) => {
    const ia = SQUAD_ORDER.indexOf(a[0] as SquadName);
    const ib = SQUAD_ORDER.indexOf(b[0] as SquadName);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  const handleBrowseDir = useCallback(
    async (subdir: string, label: string, sprintId: string) => {
      const { data: { session } } = await supabase.auth.getSession();
      setBrowsingDir({ subdir, label, sprintId, authToken: session?.access_token ?? null });
    },
    [],
  );

  const handleViewOutput = useCallback(
    (ref: string, githubRef: AgentRun["github_ref"]) => {
      setViewingArtifact({ ref, label: "Output", githubRef });
    },
    []
  );

  const handleViewInput = useCallback(
    (ref: string) => {
      setViewingArtifact({ ref, label: "Input", githubRef: null });
    },
    []
  );

  const handleViewSpec = useCallback(
    (agent: string) => {
      // ref is unused for spec (agentName drives the fetch), but MarkdownModal requires it
      setViewingArtifact({ ref: `${agent}.md`, label: "Spec", agentName: agent, githubRef: null });
    },
    []
  );

  const handleApprove = useCallback(async (runId: string, instructions?: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`/api/projects/${projectId}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session?.access_token ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ runId, instructions }),
    });
    const json = await res.json() as { ok?: boolean; triggered?: boolean; cli_command?: string; error?: string };
    if (res.status === 429) {
      alert("Factory is at its concurrent project limit. Wait for a running sprint to finish, or raise Max concurrent projects in Factory Settings.");
      return;
    }
    if (!res.ok) {
      alert(`Approval failed: ${json.error}`);
      return;
    }
    if (!json.triggered && json.cli_command) {
      alert(`Approved. Resume from terminal:\n\n${json.cli_command}`);
    }
  }, [projectId]);

  const handleReject = useCallback(async (runId: string, comment: string) => {
    await supabase.from("agent_events").insert({
      run_id: runId,
      event_type: "rejected",
      payload: {
        action: "reject",
        comment,
        approved_by: "founder",
        approved_at: new Date().toISOString(),
      },
    });
    await supabase.from("agent_runs").update({ status: "cancelled" }).eq("id", runId);
    // Operator hard-cancel from canvas: pause the active sprint and
    // settle the project to idle so the slot is freed.
    await supabase.from("sprints")
      .update({ status: "paused" })
      .eq("project_id", projectId)
      .in("status", ["running", "queued", "waiting"]);
    await supabase.from("projects").update({ status: "idle" }).eq("id", projectId);
  }, [projectId]);

  const statusColor =
    projectStatus === "running" ? "var(--green)" :
    projectStatus === "queued"  ? "var(--blue)"  :
    projectStatus === "locked"  ? "var(--yellow)" :
    "var(--overlay0)"; // idle

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>{projectName}</h2>
            {projectRepoUrl && (
              <a
                href={projectRepoUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 10, color: "var(--teal)", fontFamily: "var(--font-mono)", textDecoration: "none" }}
              >
                {projectRepoUrl.replace("https://github.com/", "")}
              </a>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 4, fontSize: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: statusColor, fontWeight: 600 }}>{projectStatus}</span>
            {sprintNum !== undefined && (
              <>
                <span style={{ color: "var(--overlay0)" }}>·</span>
                <span style={{ color: "var(--overlay0)" }}>Sprint {sprintNum}</span>
              </>
            )}
            <span style={{ color: "var(--overlay0)" }}>·</span>
            <span style={{ color: "var(--overlay0)" }}>Phase: {projectPhase}</span>
            <span style={{ color: "var(--overlay0)" }}>·</span>
            <span style={{
              fontFamily: "var(--font-mono)", fontSize: 11,
              color: projectBaseRef === "unversioned" ? "var(--overlay0)" : "var(--teal)",
              background: "var(--surface1)", padding: "1px 7px", borderRadius: 6,
            }}>
              {projectBaseRef === "unversioned" ? "unversioned" : `@ ${projectBaseRef}`}
            </span>
            {triggerRunId && (
              <>
                <span style={{ color: "var(--overlay0)" }}>·</span>
                <a
                  href={`https://cloud.trigger.dev/runs/${triggerRunId}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 11, color: "var(--blue)", textDecoration: "none", fontFamily: "var(--font-mono)" }}
                >
                  {triggerRunId.slice(0, 16)}… ↗
                </a>
              </>
            )}
          </div>
          {sprintBriefing && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--subtext0)", maxWidth: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {sprintBriefing}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 20, textAlign: "right", fontSize: 13 }}>
          <div title={totalTokens > 0 ? "Estimated API-equivalent cost based on token usage. Subscription users are not charged per token." : undefined}>
            <div style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.4px" }}>
              Cost{totalCost > 0 && totalTokens > 0 ? <span style={{ textTransform: "none", fontWeight: 400 }}> est.</span> : ""}
            </div>
            <div style={{ color: "var(--green)", fontFamily: "var(--font-mono)" }}>
              {totalCost > 0 ? `$${totalCost.toFixed(4)}` : "—"}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.4px" }}>Tokens</div>
            <div style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
              {totalTokens > 0 ? totalTokens.toLocaleString() : "—"}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.4px" }}>Agents</div>
            <div style={{ fontSize: 12 }}>
              {runningCount > 0 && <span style={{ color: "var(--green)" }}>{runningCount} running </span>}
              {waitingCount > 0 && <span style={{ color: "var(--yellow)" }}>{waitingCount} waiting </span>}
              <span style={{ color: "var(--overlay0)" }}>{doneCount} done</span>
            </div>
          </div>
        </div>
      </div>

      {/* Approval banner — shown when one or more agents are waiting for human review */}
      {runs.filter((r) => r.status === "waiting").map((r) => (
        <div key={r.id} style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "10px 16px", borderRadius: 8,
          background: "var(--yellow)" + "12", border: "1px solid " + "var(--yellow)" + "40",
        }}>
          <span style={{ fontSize: 18 }}>⏸</span>
          <div style={{ flex: 1 }}>
            <div style={{ color: "var(--yellow)", fontWeight: 600, fontSize: 13 }}>
              {AGENT_META[r.agent]?.label ?? r.agent} — awaiting human approval
            </div>
            <div style={{ color: "var(--yellow)", opacity: 0.7, fontSize: 11, marginTop: 2 }}>
              Review the output below, then approve or reject to continue the pipeline.
            </div>
          </div>
          <button
            onClick={() => {
              const instructions = prompt("Instructions for next agents (leave empty to skip):");
              if (instructions === null) return;
              handleApprove(r.id, instructions || undefined);
            }}
            style={{
              padding: "5px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600,
              background: "var(--green)", color: "var(--crust)", border: "none", cursor: "pointer",
            }}
          >
            ✓ Approve
          </button>
          <button
            onClick={() => {
              const comment = prompt("Reason for rejection (required):");
              if (comment === null || !comment) return;
              handleReject(r.id, comment);
            }}
            style={{
              padding: "5px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600,
              background: "var(--red)" + "22", color: "var(--red)", border: "1px solid " + "var(--red)" + "40",
              cursor: "pointer",
            }}
          >
            ✗ Reject
          </button>
          <button
            onClick={() => setSelectedAgent(r.agent)}
            style={{
              padding: "5px 10px", borderRadius: 6, fontSize: 11,
              background: "transparent", color: "var(--overlay1)", border: "1px solid var(--surface1)",
              cursor: "pointer",
            }}
          >
            View output
          </button>
        </div>
      ))}

      {/* Start button — shown when project hasn't started yet */}
      {projectStatus === "idle" && (
        <StartButton projectId={projectId} status={projectStatus} />
      )}

      {/* Pipeline segment (with inline control icons) */}
      {pipeline.length > 0 && (
        <PipelineSegment
          pipeline={pipeline}
          runsByAgent={runsByAgent}
          onSelectAgent={setSelectedAgent}
          projectId={projectId}
          projectStatus={projectStatus}
          onOpenArtifactTree={() => setShowArtifactTree(true)}
          localWorkspacePath={executionBackend === "local" ? projectSlug : undefined}
          sprintIntent={sprintIntent ?? null}
        />
      )}

      {/* Squad-grouped agents */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {sortedSquads.map(([squad, agents]) => {
          const color = AGENT_META[agents[0]]?.color ?? "#666";
          return (
            <SquadSection
              key={squad}
              squad={squad}
              agents={agents}
              runsByAgent={runsByAgent}
              selectedAgent={selectedAgent}
              onSelectAgent={setSelectedAgent}
              color={color}
            />
          );
        })}
      </div>

      {/* Agent detail drawer */}
      {selectedAgent && (
        <AgentDrawer
          agent={selectedAgent}
          run={selectedRun ?? null}
          allRunsForAgent={allRunsByAgent.get(selectedAgent) ?? []}
          runsByAgent={runsByAgent}
          projectId={projectId}
          projectStatus={projectStatus}
          stepNum={pipeline.find((s) => s.agent === selectedAgent)?.step ?? null}
          onClose={() => setSelectedAgent(null)}
          onViewOutput={handleViewOutput}
          onViewInput={handleViewInput}
          onViewSpec={handleViewSpec}
          onBrowseDir={handleBrowseDir}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}

      {/* Dir browser modal (Audit / Docs / Workspace) */}
      {browsingDir && (
        <DirBrowserModal
          projectId={projectId}
          sprintId={browsingDir.sprintId}
          subdir={browsingDir.subdir}
          label={browsingDir.label}
          authToken={browsingDir.authToken}
          onClose={() => setBrowsingDir(null)}
        />
      )}

      {/* Artifact viewer modal (input or output) */}
      {viewingArtifact && (
        <MarkdownModal
          label={viewingArtifact.label}
          outputRef={viewingArtifact.ref}
          agentName={viewingArtifact.agentName}
          githubRef={viewingArtifact.githubRef}
          onClose={() => setViewingArtifact(null)}
        />
      )}

      {/* Artifact tree modal */}
      {showArtifactTree && (
        <ArtifactTreeModal
          projectId={projectId}
          projectSlug={projectSlug}
          sprintId={runs.find(r => r.sprint_id)?.sprint_id ?? null}
          sprintNum={sprintNum}
          authToken={null}
          onClose={() => setShowArtifactTree(false)}
        />
      )}
    </div>
  );
}
