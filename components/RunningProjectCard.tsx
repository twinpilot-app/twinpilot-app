"use client";

/** Office card surfaced while a sprint is in flight (running / paused /
 *  waiting). Wraps ProjectCanvas for the agent pipeline view and
 *  SprintHistoryPanel for past sprints. */
import React, { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import type { Project, AgentRun, DBProject, SprintIntent } from "@/lib/types";
import { supabase } from "@/lib/supabase";
import ProjectCanvas from "@/components/ProjectCanvas";
import SprintHistoryPanel from "@/components/SprintHistoryPanel";
import QueueRow from "@/components/QueueRow";

interface SprintInfo {
  sprint_num: number;
  status: string;
  created_at: string;
  trigger_run_id: string | null;
  briefing: string | null;
  intent: SprintIntent | null;
  steps: { step: number; agent: string; gate: string | null }[] | null;
}

/** Latest-sprint flags surfaced on the project card. Mirrors the host. */
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

type ActionState = { loading: boolean; msg?: { type: "error" | "cli"; text: string } };

function RunningProjectCard({ project, db, sprintInfoMap, latestSprintFlags, actions, runsMap, onPause, onRemove, session, onPlay, onSprintModal, onAutoDrainPauseToggle, onAutoDrainHardStop, onAutoDrainApprove }: {
  project: Project;
  db: DBProject;
  sprintInfoMap: Map<string, SprintInfo>;
  latestSprintFlags?: LatestSprintFlags;
  actions: Record<string, ActionState>;
  runsMap: Map<string, AgentRun[]>;
  onPause: () => void;
  onRemove: () => void;
  session: Session;
  onPlay?: () => void;
  onSprintModal?: () => void;
  onAutoDrainPauseToggle?: () => void;
  onAutoDrainHardStop?: () => void;
  onAutoDrainApprove?: () => void;
}) {
  const sprintStatus = sprintInfoMap.get(project.id)?.status;
  const isPaused = sprintStatus === "paused" || sprintStatus === "waiting";
  const [canvasOpen, setCanvasOpen] = useState(!isPaused);
  const sprintInfo = sprintInfoMap.get(project.id);

  // Only show runs that belong to the current sprint (created after the sprint started).
  // This prevents stale runs from a previous sprint polluting the Agent Pipeline view.
  const allRuns = runsMap.get(project.id) ?? [];
  const runs = sprintInfo?.created_at
    ? allRuns.filter((r) => r.created_at >= sprintInfo.created_at)
    : allRuns;

  return (
    <div>
      <QueueRow
        project={project}
        sprintCount={db.sprint_count}
        activeSprintNum={sprintInfo?.sprint_num}
        brief={db.intake_brief}
        lastError={db.last_error}
        state={actions[project.id]}
        // Office row collapses project + sprint state. Sprint flags
        // (paused/waiting/pending_save) take precedence so the row
        // renders the right Continue/Save affordances; otherwise we
        // fall back to project.status.
        status={sprintStatus ?? (project.status as string)}
        canStart={isPaused}
        runs={runs}
        onPause={onPause}
        onRemove={onRemove}
        {...(onPlay ? { onPlay } : {})}
        {...(onSprintModal ? { onSprintModal } : {})}
        {...(onAutoDrainPauseToggle ? { onAutoDrainPauseToggle } : {})}
        {...(onAutoDrainHardStop ? { onAutoDrainHardStop } : {})}
        {...(onAutoDrainApprove ? { onAutoDrainApprove } : {})}
        {...(latestSprintFlags ? { latestSprintFlags } : {})}
      />

      {/* Agent Pipeline — collapsible, scoped to current sprint */}
      <div style={{ marginTop: 8, borderRadius: 10, border: "1px solid rgba(20,99,255,0.15)", overflow: "hidden" }}>
        <button
          onClick={() => setCanvasOpen((o) => !o)}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            width: "100%", padding: "8px 14px",
            background: "var(--surface0)", border: "none", cursor: "pointer",
            color: "var(--subtext0)", fontSize: 11, fontFamily: "var(--font-sans)",
            borderBottom: canvasOpen ? "1px solid rgba(20,99,255,0.12)" : "none",
          }}
        >
          {canvasOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Agent Pipeline
          {sprintInfo && (
            <span style={{ fontSize: 10, color: "var(--overlay0)", marginLeft: 4 }}>
              · sprint {sprintInfo.sprint_num}
            </span>
          )}
          {sprintInfo?.briefing && (
            <span style={{ fontSize: 10, color: "var(--overlay0)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 2 }}>
              — {sprintInfo.briefing.slice(0, 60)}{sprintInfo.briefing.length > 60 ? "…" : ""}
            </span>
          )}
        </button>

        {canvasOpen && (
          <div style={{ background: "var(--surface0)" }}>
            {/* Initializing banner — shown when no agent_runs exist yet for this sprint */}
            {runs.length === 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 20px", borderBottom: "1px solid rgba(20,99,255,0.1)",
                background: "rgba(20,99,255,0.04)",
              }}>
                <Loader2 size={14} color="#1463ff" style={{ animation: "spin 1s linear infinite", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                    Initializing pipeline…
                  </div>
                  {sprintInfo?.briefing && (
                    <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {sprintInfo.briefing}
                    </div>
                  )}
                </div>
                {sprintInfo?.trigger_run_id && (
                  <a
                    href={`https://cloud.trigger.dev/runs/${sprintInfo.trigger_run_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 10, color: "var(--blue)", textDecoration: "none", flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}
                  >
                    Trigger.dev run ↗
                  </a>
                )}
              </div>
            )}
            <div style={{ padding: "16px 20px" }}>
              <ProjectCanvas
                projectId={project.id}
                projectName={project.name}
                projectSlug={(project as DBProject).slug}
                projectStatus={project.status as string}
                projectPhase={(project as { phase?: string }).phase ?? "validate"}
                projectRepoUrl={(project as { repo_url?: string | null }).repo_url}
                projectBaseRef={(project as { base_ref?: string }).base_ref}
                pipeline={
                  // Effective pipeline: prefer the running sprint's resolved
                  // steps (so a discovery sprint shows its own agent list);
                  // fall back to project.pipeline when no sprint is active.
                  // Same precedence the worker uses — UI + runtime stay in sync.
                  (sprintInfo?.steps && sprintInfo.steps.length > 0
                    ? sprintInfo.steps
                    : (project.pipeline ?? [])) as { step: number; agent: string; gate: string | null }[]
                }
                sprintIntent={sprintInfo?.intent ?? null}
                externalRuns={runs}
                sprintNum={sprintInfo?.sprint_num}
                sprintBriefing={sprintInfo?.briefing ?? undefined}
                triggerRunId={sprintInfo?.trigger_run_id ?? undefined}
                executionBackend={((project as DBProject).settings?.cli_agents as { execution_backend?: "supabase" | "local" } | undefined)?.execution_backend}
              />
            </div>
          </div>
        )}
      </div>

      {/* Sprint History — collapsed by default */}
      <SprintHistoryPanel projectId={project.id} session={session} runsMap={runsMap} currentSprintInfo={sprintInfo} sprintCount={db.sprint_count} />
    </div>
  );
}

export default RunningProjectCard;
