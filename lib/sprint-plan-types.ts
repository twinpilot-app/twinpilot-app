/**
 * Sprint Plan — the frozen, reviewable snapshot of what the sprint will send
 * to every API/CLI when it runs. Built before dispatch so the operator can
 * inspect it on /projects/[id]/sprint-plan, then persisted to `sprint_plans`
 * and referenced by id when the run is actually kicked off — making the run
 * deterministic with respect to the reviewed plan.
 *
 * Bulky data (KB chunks, full previous-sprint artifact content) is referenced,
 * not inlined — refs are resolved at runtime when the agent calls
 * `read_artifact` / `search_knowledge`.
 */

export type SprintPlanVersion = "1";

export type CliRoutingMode = "api" | "cli-api" | "cli-subs";

export type AuthMode = "oauth" | "api-key";

/**
 * Snapshot of relevant fields from `projects.settings` (ProjectSettings JSONB).
 * Stored in the plan so the review screen can show every project-level knob
 * that will shape the run — focus, providers/models, agent_configs, cli_agents,
 * budget, guidelines, etc. — without joining anything else at render time.
 */
export interface SprintPlanProjectSettings {
  focus?:                string;
  defaultProvider?:      string;
  defaultModel?:         string;
  categoryProviders?:    { planning?: string; development?: string; governance?: string };
  categoryModels?:       { planning?: string; development?: string; governance?: string };
  budgetUsd?:            number;
  timeoutAgentMs?:       number;
  guidelines?:           string;
  /** True when projects.settings.protocol_override is set — the text itself
   *  is also surfaced so the operator can audit it. */
  protocolOverride?:     string;
  onRejection?:          string;
  detailedMonitoring?:   boolean;
  useDna?:               boolean;
  /** Per-agent overrides keyed by agent slug. Only includes agents that
   *  actually have non-default config in projects.settings.agent_configs. */
  agentConfigs?:         Record<string, {
    disabled?:        boolean;
    provider?:        string;
    model?:           string;
    maxToolRounds?:   number;
    timeoutMs?:       number;
    maxTokens?:       number;
    guidelines?:      string;
  }>;
  cliAgents?: {
    enabled?:          boolean;
    defaultCli?:       string;
    executionBackend?: "supabase" | "local";
    localBasePath?:    string;
    defaultMaxTurns?:  number;
    mcpEnabled?:       boolean;
    hooksEnabled?:     boolean;
    /** Per-agent CLI overrides (full CliAgentOverride snapshot). */
    agentOverrides?:   Record<string, {
      enabled:        boolean;
      cli:            string;
      model?:         string;
      authMode?:      AuthMode;
      max_turns?:     number;
      timeout_secs?:  number;
      effort?:        "low" | "medium" | "high" | "max";
      branch_prefix?: string;
      open_pr?:       boolean;
    }>;
  };
}

export interface SprintPlan {
  version: SprintPlanVersion;
  composedAt: string;      // ISO timestamp — when this plan was composed

  project: {
    id:           string;
    slug:         string;
    name:         string;
    domain?:      string;
    repoUrl?:     string;
    intakeBrief?: string;
    pipeline:     { slug: string; name: string; stepCount: number };
    factory:      { id: string; slug: string };
    tenant:       { id: string; slug: string };
  };

  /**
   * Snapshot of `projects.settings` at compose time. Mirrors ProjectSettings
   * one-to-one — the operator can audit every project-level knob that will
   * influence the run without leaving the review screen. No secrets here:
   * provider keys live in tenant_integrations and never enter the JSONB.
   */
  projectSettings: SprintPlanProjectSettings;

  /**
   * Status snapshot of tenant integrations the run will rely on (key names
   * only — never values). Helps the operator notice "no GitHub token
   * configured but auto-push is enabled" before the run wastes turns.
   */
  tenantIntegrations: {
    providerKeys:    string[];   // names only, sorted: ["ANTHROPIC_API_KEY", ...]
    githubConfigured: boolean;
    triggerConfigured: boolean;
    storageType?:    "local" | "supabase";
  };

  sprint: {
    num:              number;
    baseRef:          string;    // git base (branch/commit) or "unversioned"
    originalBriefing: string;
    runNote?:         string;    // operator note for this specific run
  };

  /** Global execution settings that apply to all steps. */
  execution: {
    /** Tri-modal: cloud / local / local-git. Authoritative for the run. */
    mode:                  "cloud" | "local" | "local-git";
    /** Physical storage backend (binary; local-git maps to local). */
    backend:               "supabase" | "local";
    localBasePath?:        string;
    /**
     * Where the localBasePath came from. Surfaced in the Review modal so the
     * operator notices when the homedir fallback is in play.
     *   "sprint"          — sprint config override (per-sprint UI)
     *   "project"         — cli_agents.local_base_path
     *   "tenant"          — tenant `local` storage backend basePath
     *   "homedir-default" — ~/TwinPilotProjects fallback (no configuration)
     */
    localBasePathSource?:  "sprint" | "project" | "tenant" | "homedir-default";
    /** Only meaningful when mode === "local-git". */
    gitAutoCommit?:        boolean;
    /**
     * Whether auto-push to a remote runs at sprint end. Today always false
     * (Phase 5 lands the actual auto-push logic). Surfaced in the Review
     * modal so the operator knows the commit stays local.
     */
    gitAutoPush?:          boolean;
    defaultMaxTurns:       number;
    budgetUsd?:            number;
    detailedMonitoring:    boolean;
    bypassGates:           boolean;
    startFromStep?:        number;
    endAtStep?:            number;
    pushViaTrigger:        boolean;   // whether auto-push goes through the trigger task
  };

  /** Knobs set in the Start Sprint modal that deviate from project defaults. */
  sprintOverrides: {
    contextSprintIds?:  string[];
    contextCategories?: string[];
    stepRoutingOverrides?: Record<string, {
      mode: CliRoutingMode;
      cli?: string;
      model?: string;
    }>;
    /**
     * Per-step instruction text from the sprint modal. Key is the step
     * number as string; value is the instruction plus an `override` flag
     * that decides whether it REPLACES the agent's default contract for
     * this run (true) or SUPPLEMENTS it (false). Surfaced per step via
     * steps[n].operatorInstruction in the plan UI.
     */
    agentInstructions?: Record<string, { text: string; override: boolean }>;
    provider?:          string;
    model?:             string;
    maxTurnsOverride?:  number;
  };

  /** Destinations the project SELECTED for this sprint (subset of the
   * factory's full list). Each carries its own auto_push so the Review
   * modal can label "automatic" vs "manual export only". */
  outputDestinations: Array<{
    id:        string;
    label:     string;
    type:      string;              // "github" | ...
    sublabel:  string;              // e.g. "owner/repo#branch" — sanitized, no secrets
    auto_push: boolean;
  }>;

  /**
   * How destinations are resolved. The Review modal uses this to show "no
   * destinations" warnings when applicable, or note that the sprint will
   * fall back to the tenant-level legacy GITHUB_TOKEN/OWNER pair.
   *   "factory"        — at least one factory_output_destinations row exists
   *   "tenant-legacy"  — no factory destinations, but tenant has GITHUB_TOKEN+OWNER
   *   "none"           — neither — auto-push would fail today
   */
  destinationsResolution: "factory" | "tenant-legacy" | "none";

  /**
   * Backlog items the operator selected for this sprint. Empty array
   * when the sprint isn't backlog-driven. The Review modal renders this
   * as a dedicated section so the operator confirms the items + their
   * order before dispatching.
   */
  backlogItems: Array<{
    id:           string;
    title:        string;
    description?: string | null;
    order_index:  number;
  }>;

  /** Knowledge Base — listed by name/source count only. Content not inlined. */
  knowledgeBase: {
    enabled:   boolean;
    instances: Array<{
      id:          string;
      name:        string;
      sourceCount: number;
    }>;
  };

  /** Cross-sprint artifacts selected as context — references only. */
  crossSprintArtifacts: Array<{
    sprintNum: number;
    agent:     string;
    category:  string;
    ref:       string;
  }>;

  steps: SprintPlanStep[];

  /** Non-fatal issues the operator should see before confirming the run. */
  warnings: string[];
}

export interface SprintPlanStep {
  step:        number;
  phase:       number;
  phaseName:   string;
  gate:        "human" | null;
  gateInstructions?: string;

  agent: {
    slug:       string;
    name:       string;
    icon?:      string;
    level?:     string;
    squad?:     string;
    persona:    string;                 // full persona as stored in agent_definitions.spec.description
    tools:      string[];
    guidelines?: string;
    version?:   string;
  };

  routing: {
    mode:     CliRoutingMode;
    cli?:     string;                   // "claude-code" | "aider" | ...
    authMode?: AuthMode;
  };

  model: {
    provider?:  string;
    requested?: string;                 // what the project/operator configured
    effective?: string;                 // what will actually be used after compatibility filter (cli-executor)
    source:     "project" | "cli-override" | "cli-default" | "session-default";
    note?:      string;                 // e.g. "project model dropped — not compatible with claude-code"
  };

  limits: {
    maxTurns:   number;
    effort?:    "low" | "medium" | "high" | "max";
    budgetUsd?: number;
    timeoutSecs?: number;
  };

  /** Full task text that will be passed (or its direct-input equivalent). */
  task: {
    composed: string;                   // concatenated full task as each section below, joined by `---`
    sections: Array<{
      title:     string;                // e.g. "Original Briefing", "Required Inputs", "Agent Protocol"
      content:   string;
      collapsed?: boolean;              // UI hint — defaults to true for the big sections
    }>;
  };

  inputs: {
    /** Required by the agent's SIPOC contract. */
    required: SprintPlanInputRef[];
    /** Available but not mandatory. */
    additional: SprintPlanInputRef[];
    /** Siblings in the same phase — references from peers that ran in parallel. */
    siblings: SprintPlanInputRef[];
  };

  /**
   * Per-step instruction from the sprint modal. When `override` is true
   * the instruction REPLACES the agent's contract for this run; when
   * false it SUPPLEMENTS it. Rendered as its own section in `task`.
   */
  operatorInstruction?: { text: string; override: boolean };
}

export interface SprintPlanInputRef {
  agent:       string;
  step:        number;
  ref:         string;
  /** True when the ref is a placeholder (upstream step hasn't run yet). */
  placeholder: boolean;
}
