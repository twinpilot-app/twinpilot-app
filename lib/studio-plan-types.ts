/**
 * Studio Wizard plan — the shape of `studio_sessions.plan` JSONB.
 *
 * The Wizard chat's tool calls (create_agent / create_pipeline /
 * create_project / assign_pipeline) APPEND entries to this structure
 * instead of writing to the live tables. Nothing is persisted to
 * agent_definitions / pipelines / projects until the operator confirms —
 * at which point the confirm endpoint runs all inserts transactionally,
 * mapping synthetic ids to real UUIDs.
 *
 * Squads
 * ------
 * Squad is a string TAG on agents (free-form, used to group agents in the
 * Studio UI). It is NOT a separate entity. There is no create_squad tool
 * and no StagedSquad type — the chat passes a squad name string when
 * creating an agent and the value lands on `agent_definitions.squad`.
 *
 * Synthetic ids
 * -------------
 * Staged entries get an id of the form `staged:<entity>-<uuid>`. The LLM
 * sees these in tool results and can reference them in subsequent tool
 * calls. At confirm time, every synthetic id is rewritten to the real
 * UUID returned by the corresponding INSERT.
 *
 * Real ids
 * --------
 * Cross-entity fields (pipelineId on a project, projectId/pipelineId on
 * an operation) accept BOTH synthetic ids and real DB UUIDs. The confirm
 * endpoint resolves them in FK-safe order: pipelines → agents → projects
 * → operations.
 */

/** Format: `staged:<entity>-<uuid>`. Helper guard below. */
export type StagedId = `staged:${string}`;

export function isStagedId(id: string): id is StagedId {
  return id.startsWith("staged:");
}

/**
 * Agent contract — mirrors the YAML schema used in the live agent
 * definitions (see `factories/.../agents/contracts/*.yaml`). This is what
 * lands on `agent_definitions.spec` at confirm time.
 */
export interface StagedAgent {
  id:        StagedId;
  /** Authoritative machine id; goes on agent_definitions.slug. */
  slug:      string;
  name:      string;
  /** Semver string. Defaults to "1.0.0" when the chat doesn't pin one. */
  version:   string;
  /**
   * Free-form squad tag (e.g. "software-engineering", "design"). Empty
   * string is allowed — the agent just shows ungrouped in the Studio.
   */
  squad:     string;
  /** Optional level (specialist | strategist | …). Free-form text. */
  level?:    string;
  /** Optional emoji or short icon glyph. */
  icon?:     string;
  /** Free-form tags surfaced in the agent card. */
  tags?:     string[];
  /** Multi-line persona — the system prompt used at runtime. */
  persona:   string;
  /**
   * MCP tools the agent is allowed to call. Defaults to the full canonical
   * set (read_project_file / list_project_files / read_artifact /
   * list_artifacts / write_sprint_workspace / write_sprint_docs /
   * write_sprint_audit / escalate_to_human). The operator refines later
   * in the live Agent editor.
   */
  tools:     string[];
  createdAt: string;
}

export interface StagedPipelineStep {
  step:       number;
  agent:      string;       // agent slug — resolves at runtime
  phase?:     number;
  phaseName?: string;
  gate?:      "human" | null;
}

export interface StagedPipeline {
  id:         StagedId;
  name:       string;
  slug:       string;
  description?: string;
  steps:      StagedPipelineStep[];
  mode?:      "sequential" | "sipoc";
  createdAt:  string;
}

export interface StagedProject {
  id:         StagedId;
  name:       string;
  slug:       string;
  brief:      string;       // becomes intake_brief on insert
  /** Real pipeline UUID OR a synthetic id from this plan's pipelines[]. */
  pipelineId?: string;
  createdAt:  string;
}

/**
 * Backlog items staged via the Wizard. Persisted into project_backlog_items
 * at confirm time with source="wizard-gen". Linked to the staged or live
 * project via projectId.
 */
export interface StagedBacklogItem {
  id:          StagedId;
  /** Real project UUID OR a staged id from this plan's projects[]. */
  projectId:   string;
  title:       string;
  description?: string;
  createdAt:   string;
}

/** Cross-entity ops resolved at confirm time after everything has a real id. */
export type StagedOperation =
  | {
      kind:        "assign_pipeline";
      projectId:   string;
      pipelineId:  string;
      stagedAt:    string;
    };

/**
 * Per-item discard — keeps the original entry as audit instead of removing
 * it from the array. The confirm flow filters these out.
 */
export interface DiscardedEntry {
  type:      "agent" | "pipeline" | "project" | "backlog" | "operation";
  id:        string;
  reason?:   string;
  at:        string;
}

export interface StudioPlan {
  agents:        StagedAgent[];
  pipelines:     StagedPipeline[];
  projects:      StagedProject[];
  backlogItems:  StagedBacklogItem[];
  operations:    StagedOperation[];
  discarded?:    DiscardedEntry[];

  /**
   * Populated by the confirm endpoint after a successful commit. Maps
   * every synthetic id to the real UUID that landed in the live table.
   */
  committed?: {
    agents:        Record<StagedId, string>;
    pipelines:     Record<StagedId, string>;
    projects:      Record<StagedId, string>;
    backlogItems?: Record<StagedId, string>;
    at:            string;
  };
}

export function emptyStudioPlan(): StudioPlan {
  return {
    agents:       [],
    pipelines:    [],
    projects:     [],
    backlogItems: [],
    operations:   [],
  };
}

/** Total count of pending items across the plan (for the "Confirm (N)" badge). */
export function studioPlanPendingCount(plan: StudioPlan): number {
  return (
    plan.agents.length +
    plan.pipelines.length +
    plan.projects.length +
    plan.backlogItems.length +
    plan.operations.length
  );
}

/**
 * Canonical default tool list for newly-staged agents. Mirrors the common
 * subset across `factories/.../agents/contracts/*.yaml` plus the doc-write
 * and audit-write tools so the agent isn't artificially constrained on
 * day one. The operator can refine later in the live Agent editor.
 */
export const DEFAULT_AGENT_TOOLS: readonly string[] = [
  "read_project_file",
  "list_project_files",
  "read_artifact",
  "list_artifacts",
  "write_sprint_workspace",
  "write_sprint_docs",
  "write_sprint_audit",
  "escalate_to_human",
];
