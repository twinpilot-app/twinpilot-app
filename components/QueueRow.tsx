"use client";

/** Office card header used by RunningProjectCard (in-flight sprints)
 *  and the queued-projects list. Same layout for queued / paused /
 *  running / pending_save states; the icons decide their behaviour
 *  from the collapsed-status prop. */
import React, { useState } from "react";
import {
  AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, Cloud,
  Circle, FolderOpen, GitBranch, Layers, Loader2, Pause, Play,
  RotateCcw, SkipForward, Workflow, X, XCircle,
} from "lucide-react";
import type { Project, AgentRun, DBProject } from "@/lib/types";
import { supabase } from "@/lib/supabase";

type ActionState = { loading: boolean; msg?: { type: "error" | "cli"; text: string } };

interface LatestSprintFlags {
  sprint_num: number;
  needs_human: boolean;
  verdict: "success" | "no-output" | "partial" | "failed" | null;
  reason: string | null;
  needs_human_reason: string | null;
  suggested_action: string | null;
  pending_push: { branch: string | null; tag?: string } | null;
  auto_composed: { source_sprint_id: string } | null;
}

const STATUS_COLOR: Record<string, string> = {
  provisioning: "#6b7a9e", ready: "#10b981", executing: "#1463ff",
  waiting: "#f59f00", completed: "#00c2a8", paused: "#f59f00",
  cancelled: "#6b7a9e", failed: "#e44b5f", queued: "#6b7a9e", running: "#1463ff",
  pending_save: "#f59f00",
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "#6b7a9e";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em",
      padding: "2px 8px", borderRadius: 99,
      background: `${color}18`, color,
    }}>
      {status}
    </span>
  );
}

/* ─── Icon button (icon-only, tooltip via title) ────── */
function PipelineIconBtn({ title, icon, color, onClick, disabled, loading }: {
  title: string; icon: React.ReactNode; color: string;
  onClick?: () => void; disabled?: boolean; loading?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 28, height: 28, borderRadius: 7, border: "none", flexShrink: 0,
        background: `${color}18`, color,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled ? 0.35 : 1,
        transition: "opacity 0.12s",
      }}
    >
      {loading ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : icon}
    </button>
  );
}

/* ─── Agent run status icon ─────────────────────────────── */
function RunStatusIcon({ status }: { status: string }) {
  if (status === "done")        return <CheckCircle2 size={11} color="#00c2a8" />;
  if (status === "failed")      return <XCircle size={11} color="var(--red)" />;
  if (status === "running")     return <Loader2 size={11} color="#1463ff" style={{ animation: "spin 1s linear infinite" }} />;
  if (status === "waiting")     return <Circle size={11} color="#f59f00" />;
  if (status === "interrupted") return <XCircle size={11} color="var(--yellow, #df8e1d)" />;
  return <Circle size={11} color="var(--overlay0)" />;
}

function QueueRow({ project, index, sprintCount, activeSprintNum, brief, lastError, state, status, canStart, blockedReason,
                    runs, onPlay, onSprintModal, onRemove, onPause, onAutoDrainPauseToggle, onAutoDrainHardStop, onAutoDrainApprove, latestSprintFlags }: {
  project: Project; index?: number;
  sprintCount?: number;
  /** sprint_num of the currently active sprint record — sourced directly from the sprints table,
   *  not from projects.sprint_count, which can be inflated by failed sprint attempts. */
  activeSprintNum?: number;
  brief?: string | null;
  /** Infra-readiness blocker message stored on the project when pipeline fails pre-flight. */
  lastError?: string | null;
  state?: ActionState;
  status: string; canStart: boolean;
  /** Shown in the Start tooltip when canStart=false (e.g. "Factory at capacity (3/3)"). */
  blockedReason?: string;
  runs?: AgentRun[];
  onPlay?: () => void;
  onSprintModal?: () => void;
  onRemove: () => void;
  onPause?: () => void;
  /** Toggle auto_drain_pause_requested on/off — only wired for autonomous projects. */
  onAutoDrainPauseToggle?: () => void;
  /** Cancel in-flight sprint AND set auto_drain_pause_requested — only when running and autonomous. */
  onAutoDrainHardStop?: () => void;
  /** Clear auto_drain_awaiting_approval — release the per-sprint approval gate. */
  onAutoDrainApprove?: () => void;
  /** Verdict + needs_human flags for the project's most-recent sprint. Drives
   *  the "needs review" badge so operators can spot stalled discoveries / no-diff
   *  executions without opening each sprint. */
  latestSprintFlags?: LatestSprintFlags;
}) {
  const isLoading = state?.loading ?? false;
  const isPaused  = status === "paused" || status === "waiting";
  const isRunning = status === "running";
  // Sprint number to display in tooltips:
  //   - If there's an active sprint record → use its sprint_num (source of truth)
  //   - If paused (sprint exists, sprint_count = current num) → use sprint_count
  //   - Otherwise (queued, no sprint yet) → next sprint = sprint_count + 1
  const displaySprintNum = activeSprintNum
    ?? (isPaused ? (sprintCount ?? 1) : (sprintCount ?? 0) + 1);
  const [runsOpen, setRunsOpen] = useState(false);

  const sortedRuns = runs ? [...runs].sort((a, b) => (a.step ?? 0) - (b.step ?? 0)) : [];

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{
        borderRadius: 10, background: "var(--surface0)",
        border: isRunning ? "1px solid rgba(20,99,255,0.3)" : "1px solid var(--surface1)",
        borderLeft: isRunning ? "3px solid #1463ff" : undefined,
        overflow: "hidden",
      }}>
        {/* Main row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px" }}>
          {index !== undefined && (
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", width: 18, textAlign: "center", flexShrink: 0 }}>
              #{index}
            </span>
          )}

          {/* Project info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
              {project.name}
              {(() => {
                // Tri-modal: orchestration_mode wins; fall back to deriving
                // from execution_backend for legacy rows. local and local-git
                // share execution_backend="local" so we need orchestration_mode
                // to render the right badge.
                const cliCfg = ((project as DBProject).settings?.cli_agents as {
                  execution_backend?: string;
                  orchestration_mode?: "cloud" | "local" | "local-git";
                } | undefined);
                const mode: "cloud" | "local" | "local-git" =
                  cliCfg?.orchestration_mode
                  ?? (cliCfg?.execution_backend === "local" ? "local" : "cloud");
                const visual =
                  mode === "local-git" ? { bg: "rgba(203,166,247,0.12)", fg: "var(--mauve)", icon: <GitBranch size={8} />, label: "local + git", title: "Local + Git execution" }
                  : mode === "local"   ? { bg: "rgba(166,227,161,0.12)", fg: "var(--green)", icon: <FolderOpen size={8} />, label: "local",       title: "Local execution" }
                  :                      { bg: "rgba(20,99,255,0.10)",   fg: "var(--blue)",  icon: <Cloud size={8} />,      label: "cloud",       title: "Cloud execution" };
                return (
                  <span title={visual.title} style={{
                    display: "inline-flex", alignItems: "center", gap: 2,
                    fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 700,
                    background: visual.bg, color: visual.fg, flexShrink: 0,
                  }}>
                    {visual.icon}{visual.label}
                  </span>
                );
              })()}
              {(() => {
                // Autonomous badge — shown when execution_mode is kanban_auto.
                // Three sub-states: paused, awaiting approval, active.
                if ((project as DBProject).execution_mode !== "kanban_auto") return null;
                const projSettings = (project as DBProject).settings as {
                  auto_drain_pause_requested?: boolean;
                  auto_drain_awaiting_approval?: boolean;
                } | null | undefined;
                const paused = projSettings?.auto_drain_pause_requested === true;
                const awaitingApproval = projSettings?.auto_drain_awaiting_approval === true;
                const visual = paused
                  ? { bg: "rgba(245,159,0,0.12)", fg: "var(--yellow, #df8e1d)", label: "autonomous · paused", title: "Auto-drain enabled but paused — dispatcher skips this project until you resume" }
                  : awaitingApproval
                    ? { bg: "rgba(28,191,107,0.12)", fg: "var(--green, #1cbf6b)", label: "autonomous · awaiting approval", title: "Last sprint completed — click Approve to release the loop for the next dispatch" }
                    : { bg: "rgba(20,99,255,0.12)", fg: "var(--blue, #1463ff)",  label: "autonomous",                   title: "Auto-drain enabled — the dispatcher picks up the next backlog item on every tick" };
                return (
                  <span title={visual.title} style={{
                    display: "inline-flex", alignItems: "center", gap: 3,
                    fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 700,
                    background: visual.bg, color: visual.fg, flexShrink: 0,
                  }}>
                    <Bot size={9} />{visual.label}
                  </span>
                );
              })()}
              {(() => {
                // Sprint outcome badge — surfaces when the latest sprint
                // requires human attention (no-output discovery, no-diff
                // execution, agent failures). Hidden during active runs
                // (the running indicator already takes the slot) and when
                // no recent sprint has flagged review.
                if (isRunning || !latestSprintFlags?.needs_human) return null;
                const tooltip = [
                  `Sprint #${latestSprintFlags.sprint_num} needs review`,
                  latestSprintFlags.reason,
                  latestSprintFlags.needs_human_reason,
                  latestSprintFlags.suggested_action ? `→ ${latestSprintFlags.suggested_action}` : null,
                ].filter(Boolean).join("\n\n");
                return (
                  <span title={tooltip} style={{
                    display: "inline-flex", alignItems: "center", gap: 3,
                    fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 700,
                    background: "rgba(245,159,0,0.18)", color: "var(--yellow, #df8e1d)", flexShrink: 0,
                    cursor: "help",
                  }}>
                    <AlertTriangle size={9} />needs review
                  </span>
                );
              })()}
              {(() => {
                // Auto-composed sprint badge — the pipeline-composer's proposal
                // drove this execution sprint's pipeline. Just informational.
                const ac = latestSprintFlags?.auto_composed;
                if (isRunning || !ac) return null;
                return (
                  <span title={`Pipeline auto-composed from discovery sprint (id: ${ac.source_sprint_id.slice(0, 8)}…)`} style={{
                    display: "inline-flex", alignItems: "center", gap: 3,
                    fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 700,
                    background: "rgba(203,166,247,0.14)", color: "var(--mauve, #cba6f7)", flexShrink: 0,
                    cursor: "help",
                  }}>
                    <Bot size={9} />auto-composed
                  </span>
                );
              })()}
              {(() => {
                // Local-git auto-push off: render a small "ready to push"
                // badge with the exact git push command in the tooltip.
                // Hidden during active runs and when there's nothing pending.
                const pp = latestSprintFlags?.pending_push;
                if (isRunning || !pp) return null;
                const branch = pp.branch ?? "<branch>";
                const tag    = pp.tag;
                const cmd = tag
                  ? `git push origin ${branch} && git push origin ${tag}`
                  : `git push origin ${branch}`;
                const tooltip = [
                  `Sprint #${latestSprintFlags!.sprint_num} committed locally — auto-push is off.`,
                  `Run in your project working tree:`,
                  cmd,
                ].join("\n\n");
                return (
                  <span title={tooltip} style={{
                    display: "inline-flex", alignItems: "center", gap: 3,
                    fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 700,
                    background: "rgba(20,99,255,0.14)", color: "var(--blue, #1463ff)", flexShrink: 0,
                    cursor: "help",
                  }}>
                    <GitBranch size={9} />ready to push
                  </span>
                );
              })()}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
              <code style={{ fontSize: 10, color: "var(--overlay0)" }}>{project.slug}</code>
              {sprintCount !== undefined && sprintCount > 0 && (
                <span style={{ fontSize: 10, color: "var(--overlay0)", display: "flex", alignItems: "center", gap: 3 }}>
                  <GitBranch size={9} /> {sprintCount} sprint{sprintCount !== 1 ? "s" : ""}
                </span>
              )}
              {/* Show next sprint number when not running */}
              {!isRunning && (
                <span style={{ fontSize: 10, color: isPaused ? "var(--yellow, #df8e1d)" : "var(--blue, #1463ff)", fontWeight: 500 }}>
                  {isPaused ? `sprint ${displaySprintNum} paused` : `next: sprint ${displaySprintNum}`}
                </span>
              )}
              {isRunning && (
                sortedRuns.length > 0 ? (
                  <button
                    onClick={() => setRunsOpen((o) => !o)}
                    style={{
                      display: "flex", alignItems: "center", gap: 3,
                      background: "none", border: "none", cursor: "pointer",
                      color: "var(--subtext0)", fontSize: 10, padding: 0,
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    {runsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    sprint {displaySprintNum} · {sortedRuns.length} agent{sortedRuns.length !== 1 ? "s" : ""}
                  </button>
                ) : (
                  <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--overlay0)" }}>
                    <Loader2 size={9} style={{ animation: "spin 1s linear infinite" }} />
                    sprint {displaySprintNum} · initializing…
                  </span>
                )
              )}
            </div>
          </div>

          {!isPaused && !isRunning && <StatusBadge status={status} />}

          {/* Actions — icon only */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <PipelineIconBtn
              title="View in Studio (Project Settings + sprint history)"
              icon={<Layers size={13} />}
              color="var(--overlay0)"
              onClick={() => { window.location.href = `/projects?focus=${project.id}`; }}
              loading={false}
            />
            {(() => {
              // Prepare workspace — materialises CLAUDE.md / .claude/agents/
              // / .mcp.json at the project's local working dir without
              // dispatching a pipeline. Operator runs claude-code there
              // manually. Disabled for cloud (no local dir).
              const cliCfg = ((project as DBProject).settings?.cli_agents as {
                orchestration_mode?: "cloud" | "local" | "local-git";
                execution_backend?: "supabase" | "local";
              } | undefined);
              const mode: "cloud" | "local" | "local-git" =
                cliCfg?.orchestration_mode
                ?? (cliCfg?.execution_backend === "local" ? "local" : "cloud");
              const isCloud = mode === "cloud";
              return (
                <PipelineIconBtn
                  title={isCloud
                    ? "Prepare workspace — only available for local / local-git projects"
                    : "Prepare workspace — write CLAUDE.md, .claude/agents/, .mcp.json without dispatching a sprint"}
                  icon={<FolderOpen size={13} />}
                  color={isCloud ? "var(--overlay0)" : "var(--blue, #1463ff)"}
                  onClick={async () => {
                    if (isCloud) return;
                    try {
                      const res = await fetch(`/api/projects/${project.id}/prepare-workspace`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token ?? ""}`, "Content-Type": "application/json" },
                        body: JSON.stringify({}),
                      });
                      const body = await res.json() as { ok?: boolean; message?: string; error?: string };
                      if (!res.ok) alert(body.error ?? "Prepare workspace failed.");
                      else alert(body.message ?? "Workspace preparation dispatched.");
                    } catch (e) {
                      alert((e as Error).message);
                    }
                  }}
                  disabled={isCloud}
                  loading={false}
                />
              );
            })()}
            {/* Run Discovery quick-button retired — Start Sprint modal
                already exposes the intent picker (Discovery / Planning /
                Execution / Review) when heuristic is off, and pre-selects
                the heuristic choice when on. Removing this avoids the
                quick-button silently overriding the operator's chosen
                intent / heuristic. */}
            {(() => {
              // Per-sprint approval gate — operator action. Worker sets
              // auto_drain_awaiting_approval=true after each sprint finishes
              // (when auto_drain_approval_required is on). The dispatcher
              // skips while this is true; clicking Approve releases the loop
              // for one cycle. Distinct icon (CheckCircle2) so it doesn't
              // visually collide with Resume / Play.
              if ((project as DBProject).execution_mode !== "kanban_auto" || !onAutoDrainApprove) return null;
              const projSettings = (project as DBProject).settings as { auto_drain_awaiting_approval?: boolean } | null | undefined;
              if (projSettings?.auto_drain_awaiting_approval !== true) return null;
              return (
                <PipelineIconBtn
                  title="Approve last sprint and let the autonomous loop dispatch the next one"
                  icon={<CheckCircle2 size={13} />}
                  color="var(--green, #1cbf6b)"
                  onClick={onAutoDrainApprove}
                  loading={isLoading}
                />
              );
            })()}
            {(() => {
              // Autonomous-mode pause/resume button. Visible only when the
              // project's execution_mode is kanban_auto. Independent from
              // the "pause current sprint" button — this controls whether
              // the cron will dispatch the NEXT sprint after the current
              // one finishes.
              if ((project as DBProject).execution_mode !== "kanban_auto" || !onAutoDrainPauseToggle) return null;
              const projSettings = (project as DBProject).settings as { auto_drain_pause_requested?: boolean } | null | undefined;
              const paused = projSettings?.auto_drain_pause_requested === true;
              return (
                <PipelineIconBtn
                  title={paused
                    ? "Resume autonomous loop — the daemon/cron starts dispatching the next backlog item again"
                    : "Pause autonomous loop — current sprint finishes naturally, no new dispatches until you resume"}
                  icon={paused ? <Bot size={13} /> : <Workflow size={13} />}
                  color={paused ? "var(--blue, #1463ff)" : "#f59f00"}
                  onClick={onAutoDrainPauseToggle}
                  loading={false}
                />
              );
            })()}
            {(() => {
              // Hard-stop: kills the in-flight sprint AND pauses auto-drain.
              // Only meaningful when the project is autonomous + currently
              // running — otherwise pause-now is graceful-pause's job.
              if ((project as DBProject).execution_mode !== "kanban_auto" || !onAutoDrainHardStop) return null;
              if (!isRunning) return null;
              const projSettings = (project as DBProject).settings as { auto_drain_pause_requested?: boolean } | null | undefined;
              if (projSettings?.auto_drain_pause_requested === true) return null;  // already paused
              return (
                <PipelineIconBtn
                  title="Hard-stop — cancel current sprint immediately and pause auto-drain. Use sparingly."
                  icon={<XCircle size={13} />}
                  color="var(--red, #d20f39)"
                  onClick={onAutoDrainHardStop}
                  loading={isLoading}
                />
              );
            })()}
            {isRunning ? (
              /* Running: only pause */
              <PipelineIconBtn
                title="Pause pipeline after current agent completes"
                icon={<Pause size={13} />}
                color="#f59f00"
                onClick={onPause}
                loading={isLoading}
              />
            ) : (
              <>
                {/* Play/Continue toggle */}
                <PipelineIconBtn
                  title={isPaused
                    ? `Continue Sprint ${displaySprintNum}`
                    : canStart
                      ? `Start Sprint ${displaySprintNum}`
                      : blockedReason ?? "Another project is running"}
                  icon={<Play size={13} />}
                  color="#1463ff"
                  onClick={onPlay}
                  disabled={!canStart && !isPaused}
                  loading={isLoading && !isPaused}
                />

                {/* Sprint modal */}
                <PipelineIconBtn
                  title={isPaused
                    ? `Restart Sprint ${displaySprintNum} — configure and re-run`
                    : `Configure Sprint ${displaySprintNum}`}
                  icon={isPaused ? <RotateCcw size={13} /> : <SkipForward size={13} />}
                  color="#00c2a8"
                  onClick={onSprintModal}
                  loading={false}
                />

                {/* Mark as completed removed — projects don't have a
                    completion concept. Only sprints do. To stop running
                    sprints on this project, leave it idle (`ready`) or
                    Archive it (Trash icon at the end of this row). */}
              </>
            )}

            {/* Remove */}
            <PipelineIconBtn
              title="Remove from pipeline"
              icon={<X size={13} />}
              color="var(--overlay1)"
              onClick={onRemove}
              disabled={isLoading || isRunning}
            />
          </div>
        </div>

        {/* Brief */}
        {brief && !isRunning && (
          <div style={{ padding: "0 14px 10px", paddingLeft: index !== undefined ? 44 : 14 }}>
            <p style={{ fontSize: 11, color: "var(--subtext0)", margin: 0, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {brief}
            </p>
          </div>
        )}

        {/* Infra-readiness error — shown when paused due to pre-flight failure */}
        {isPaused && lastError && (
          <div style={{
            padding: "6px 14px 10px",
            paddingLeft: index !== undefined ? 44 : 14,
            borderTop: "1px solid rgba(239,68,68,0.2)",
          }}>
            <p style={{
              fontSize: 11, color: "var(--red, #ef4444)", margin: 0, lineHeight: 1.5,
              display: "flex", alignItems: "flex-start", gap: 5,
            }}>
              <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
              {lastError}
            </p>
          </div>
        )}

        {/* Agent runs — collapsible, shown only when running and expanded */}
        {isRunning && runsOpen && sortedRuns.length > 0 && (
          <div style={{
            borderTop: "1px solid var(--surface1)",
            padding: "8px 14px 10px",
          }}>
            {sortedRuns.map((run) => (
              <div key={run.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "4px 0",
                borderBottom: "1px solid var(--surface1)",
              }}>
                <RunStatusIcon status={run.status} />
                <span style={{ fontSize: 11, color: "var(--overlay0)", width: 22, flexShrink: 0 }}>
                  {run.step ?? "—"}
                </span>
                <span style={{ fontSize: 12, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {run.agent}
                </span>
                {run.cost_usd > 0 && (
                  <span style={{ fontSize: 10, color: "var(--overlay0)", flexShrink: 0 }}>
                    ${run.cost_usd.toFixed(3)}
                  </span>
                )}
                {run.status === "failed" && run.error && (
                  <span title={run.error} style={{ fontSize: 10, color: "var(--red)", flexShrink: 0, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {run.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Inline feedback (error / CLI) */}
      {state?.msg && (() => {
        const isError = state.msg!.type === "error";
        return (
          <div style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            padding: "8px 12px", borderRadius: 8, marginTop: 4,
            background: isError ? "rgba(228,75,95,0.08)" : "rgba(0,194,168,0.06)",
            border: `1px solid ${isError ? "rgba(228,75,95,0.25)" : "rgba(0,194,168,0.2)"}`,
            color: isError ? "var(--red)" : "var(--teal)", fontSize: 12,
          }}>
            {isError && <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />}
            <span style={{ flex: 1, fontFamily: isError ? "inherit" : "var(--font-mono)", fontSize: isError ? 12 : 11, wordBreak: "break-all" }}>
              {state.msg!.text}
            </span>
          </div>
        );
      })()}
    </div>
  );
}

export default QueueRow;
