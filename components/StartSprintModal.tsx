"use client";

/** Operator-facing dispatch dialog for a single sprint. */
import React, { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { brand } from "@/lib/brand";
import type {
  Project,
  AgentRun,
  DBProject,
  SprintRunOverrides,
  SprintIntent,
  PlanningSubmode,
} from "@/lib/types";
import { CLI_OPTIONS } from "@/lib/types";
import type { Session } from "@supabase/supabase-js";
import {
  X, Cloud, RefreshCw, Trash2, SlidersHorizontal, RotateCcw, Play,
  Pencil, Layers, HelpCircle, ChevronRight, AlertTriangle,
} from "lucide-react";

/* ─── Provider catalogue ────────────────────────────────── */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google",
  mistral: "Mistral", perplexity: "Perplexity", xai: "xAI",
  deepseek: "DeepSeek", qwen: "Qwen",
};
interface LiveProvider { id: string; models: { id: string; name: string }[] }

/* ─── Step routing type ────────────────────────────────── */
type StepRoutingMode = "api" | "cli-api" | "cli-subs";
interface StepRoutingEntry {
  mode: StepRoutingMode;
  cli?: string;
  /** Per-step model override. Empty / undefined falls back to the project
   *  cascade (planning/dev/governance category models, then default). */
  model?:     string;
  /** Claude Code reasoning effort — only meaningful when cli === "claude-code". */
  effort?:    "low" | "medium" | "high" | "max";
  /** Plan mode — agent proposes only, no writes. claude-code only. */
  planMode?:  boolean;
  /** Per-step budget cap in USD. claude-code only. */
  budgetUsd?: number;
}

const MODEL_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "claude-opus-4-7",            label: "Opus 4.7",   hint: "best reasoning · expensive" },
  { value: "claude-sonnet-4-6",          label: "Sonnet 4.6", hint: "balanced · default for dev" },
  { value: "claude-haiku-4-5-20251001",  label: "Haiku 4.5",  hint: "fast · cheap · local work" },
];

/* ─── Modal-local styles ───────────────────────────────── */
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 13, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  // Section title color matches ReviewSprintModal's SectionTitle (subtext0)
  // for higher contrast against --mantle. --overlay0 was too dim against
  // the modal background.
  display: "block", fontSize: 11, fontWeight: 700, color: "var(--subtext0)",
  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6,
};

/* ─── Tooltip (hover help icons in the orchestration-mode picker) ─ */
function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
          background: "var(--crust)", border: "1px solid var(--surface1)", borderRadius: 8,
          padding: "8px 12px", fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5,
          width: 260, zIndex: 400, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          pointerEvents: "none", whiteSpace: "normal",
        }}>
          {text}
        </div>
      )}
    </div>
  );
}

export default function StartSprintModal({
  project, activeSprintStatus, session, runsMap, onClose, onStarted, onReview, initialOverrides,
}: {
  project: DBProject;
  /** Status of the project's active sprint (paused/waiting/pending_save/running)
   *  resolved by the parent from sprintInfoMap. Null when there's no active sprint. */
  activeSprintStatus: string | null;
  session: Session;
  runsMap: Map<string, AgentRun[]>;
  onClose: () => void;
  onStarted: (p: Project) => void;
  /** Open the Review modal with the current overrides. */
  onReview: (overrides: SprintRunOverrides) => void;
  /** Pre-seed the modal — used when returning from Review with Back. */
  initialOverrides?: SprintRunOverrides;
}) {
  // If there's an active sprint in progress (running) or one paused
  // mid-flight (paused/waiting/pending_save), sprint_count = current
  // sprint number. Otherwise (idle, no sprint started yet) the next
  // sprint number = sprint_count + 1.
  const hasActiveSprint =
    project.status === "running" ||
    activeSprintStatus === "paused" ||
    activeSprintStatus === "waiting" ||
    activeSprintStatus === "pending_save";
  const sprintNum = hasActiveSprint ? (project.sprint_count ?? 1) : (project.sprint_count ?? 0) + 1;

  // Determine if project has a configured default LLM
  const projProvider = project.settings?.default_provider ?? "";
  const projModel    = project.settings?.default_model ?? "";
  const hasProjectLLM = Boolean(projProvider);

  const cliCfg      = project.settings?.cli_agents as { enabled?: boolean; execution_mode?: "cloud" | "local"; default_cli?: string; agent_overrides?: Record<string, { enabled?: boolean; cli?: string }> } | undefined;
  const cliEnabled  = cliCfg?.enabled === true;
  // apiSteps/cliSteps moved below stepRouting declaration

  // (Resume-step picker was removed with Context & Resume — the
  // availableSteps / autoResumeStep computation went with it.)

  // ── Defaults from project settings ──────────────────────
  const projectDefaults = React.useMemo(() => {
    const cliCfg = project.settings?.cli_agents as {
      execution_backend?: string;
      orchestration_mode?: "cloud" | "local" | "local-git";
    } | undefined;
    // Tri-modal: prefer orchestration_mode (set when local-git is chosen);
    // fall back to deriving from execution_backend for legacy rows.
    const mode: "cloud" | "local" | "local-git" =
      cliCfg?.orchestration_mode
      ?? (cliCfg?.execution_backend === "supabase" ? "cloud" : "local");
    return {
      mode,
      bypassGates: true,
      llmSource:   (hasProjectLLM ? "project" : "global") as "project" | "global",
      provider:    projProvider,
      model:       projModel,
    };
  }, [project.settings, hasProjectLLM, projProvider, projModel]);

  // Mode lock — when off (default), the orchestration mode picker is
  // disabled and the project's stored mode is forced. The dispatcher does
  // the same enforcement server-side; this is the visual cue.
  const allowModeSwitch =
    (project.settings as { allow_mode_switch?: boolean } | undefined | null)?.allow_mode_switch === true;

  // ── Load last sprint config for inheritance ────────────
  const [lastSprintConfig, setLastSprintConfig] = useState<{
    mode?: string; provider?: string; model?: string;
    bypassGates?: boolean; stepRouting?: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    supabase
      .from("sprints")
      .select("config")
      .eq("project_id", project.id)
      .not("config", "is", null)
      .order("sprint_num", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.config && typeof data.config === "object") {
          setLastSprintConfig(data.config as typeof lastSprintConfig);
        }
      });
  }, [project.id]);

  // ── Initialize from last sprint or project defaults ────
  const initMode = (lastSprintConfig?.mode as "cloud" | "local" | "local-git" | undefined) ?? projectDefaults.mode;
  const initBypass = lastSprintConfig?.bypassGates ?? projectDefaults.bypassGates;
  const initLlmSource = lastSprintConfig?.provider ? "global" as const : projectDefaults.llmSource;
  const initProvider = lastSprintConfig?.provider ?? projectDefaults.provider;
  const initModel = lastSprintConfig?.model ?? projectDefaults.model;

  const [briefing,         setBriefing]         = useState("");
  const [bypassGates,      setBypassGates]      = useState(initBypass);
  // Auto-close defaults to true: keeps the operator out of the
  // save/discard loop unless they explicitly opt in. Per-sprint —
  // overrides project setting via sprint.config.auto_close.
  const [autoClose,        setAutoClose]        = useState<boolean>(true);
  // "project" = use project settings (send undefined to API, let pipeline resolve)
  // "global"  = user picks explicitly from the live provider list
  const [llmSource,        setLlmSource]        = useState<"project" | "global">(initLlmSource);
  const [provider,         setProvider]         = useState(initProvider);
  const [model,            setModel]            = useState(initModel);
  // CLI execution mode — sprint-level override
  const [cliMode,          setCliMode]          = useState<"project" | "cloud" | "local" | "local-git">(initMode);

  // Update state when lastSprintConfig loads (async).
  // We DO NOT inherit `mode` from the previous sprint — always honour the
  // project's orchestration mode default. Inheriting mode was causing a
  // race where the user picked "Cloud" in the dialog, then the async fetch
  // of the previous sprint resolved and silently flipped them back to
  // "local" (or vice versa), so the sprint badge didn't match the toggle.
  useEffect(() => {
    if (!lastSprintConfig) return;
    if (lastSprintConfig.bypassGates !== undefined) setBypassGates(lastSprintConfig.bypassGates);
    if (lastSprintConfig.provider) { setLlmSource("global"); setProvider(lastSprintConfig.provider); }
    if (lastSprintConfig.model) setModel(lastSprintConfig.model);
  }, [lastSprintConfig]);

  // Reset to project defaults
  function resetToDefaults() {
    setCliMode(projectDefaults.mode);
    setBypassGates(projectDefaults.bypassGates);
    setLlmSource(projectDefaults.llmSource);
    setProvider(projectDefaults.provider);
    setModel(projectDefaults.model);
    setBriefing("");
    // stepRouting will reset via cliMode useEffect
  }
  const [running,          setRunning]          = useState(false);
  const [error,            setError]            = useState<string | null>(null);
  const [cliCmd,           setCliCmd]           = useState<string | null>(null);
  const [liveProviders,    setLiveProviders]    = useState<LiveProvider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);

  // Mode availability — fetched from /api/projects/[id]/mode-availability so
  // the buttons reflect the same matrix the /run route enforces. Pre-loaded
  // with all-enabled defaults so the modal renders before the fetch resolves.
  type ModeEvalUI = { enabled: boolean; reason?: string; severity?: "error" | "warning" };
  const [modeAvailability, setModeAvailability] = useState<{
    cloud: ModeEvalUI; local: ModeEvalUI; "local-git": ModeEvalUI;
  }>({ cloud: { enabled: true }, local: { enabled: true }, "local-git": { enabled: true } });
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${project.id}/mode-availability`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (r) => {
        if (!r.ok) return;
        const body = await r.json() as { cloud: ModeEvalUI; local: ModeEvalUI; "local-git": ModeEvalUI };
        if (!cancelled) setModeAvailability({ cloud: body.cloud, local: body.local, "local-git": body["local-git"] });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [project.id, session.access_token]);
  // (Cross-sprint context + resume-step state were removed with the
  // "Context & Resume" section. Direct API callers can still pass
  // `contextSprintIds` / `contextCategories` / `startFromStep` to /run.)
  // Backlog selection — TODOs for this project. Default-select the next
  // one (lowest order_index). The orchestrator flips selected items
  // todo → doing on dispatch and doing → done at sprint success.
  interface BacklogTodo { id: string; title: string; description: string | null; order_index: number }
  const [backlogTodos,    setBacklogTodos]    = useState<BacklogTodo[]>([]);
  const [backlogSelected, setBacklogSelected] = useState<Set<string>>(new Set());
  /** Active kanban items count — items whose status is NOT in (done,
   *  cancelled). Feeds the planning(grooming) heuristic: a kanban with
   *  only done/cancelled items is effectively empty (nothing to groom).
   *  Counting all-statuses would mislabel a project that finished all
   *  its items as "needs grooming" forever. */
  const [backlogActiveCount, setBacklogActiveCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data: { session: sess } } = await supabase.auth.getSession();
      if (!sess) return;
      const res = await fetch(`/api/projects/${project.id}/backlog`, {
        headers: { Authorization: `Bearer ${sess.access_token}` },
      });
      if (!res.ok || cancelled) return;
      const body = await res.json() as { items: { id: string; title: string; description: string | null; status: string; order_index: number }[] };
      const items = body.items ?? [];
      const todos = items
        .filter((it) => it.status === "todo")
        .sort((a, b) => a.order_index - b.order_index)
        .map((it) => ({ id: it.id, title: it.title, description: it.description, order_index: it.order_index }));
      setBacklogTodos(todos);
      setBacklogActiveCount(items.filter((it) => it.status !== "done" && it.status !== "cancelled").length);
      if (todos[0]) setBacklogSelected(new Set([todos[0].id]));
    })();
    return () => { cancelled = true; };
  }, [project.id]);

  // ── Intent + intent-specific pipeline steps ─────────────────────────
  // Sprint intent mirrors the server's smart fallback in
  // /api/projects/[id]/run/route.ts:
  //   1. operator selected items   → execution (explicit)
  //   2. backlog has pending todos → execution (server picks first)
  //   3. backlog empty             → discovery
  // Without step 2 the modal badge said "discovery" but the server
  // would silently promote to execution on dispatch — confusing the
  // operator and tripping the discover_once gate.
  // Intent derivation mirrors /api/projects/[id]/run logic. Critical: when
  // the backlog is empty, we don't blindly fall to discovery — discovery
  // only makes sense if the project has a discovery pipeline AND the
  // operator isn't providing a task source. When briefing/intake/PRD
  // exists, the operator already has a task in mind; promote to execution
  // so the verdict labels match what's actually happening.
  const hasDiscoveryPipeline = Boolean((project as { discovery_pipeline_id?: string | null }).discovery_pipeline_id);
  const hasOperatorTask = Boolean(
    (briefing?.trim()) ||
    ((project as { intake_brief?: string | null }).intake_brief ?? "").trim() ||
    ((project as { prd_md?: string | null }).prd_md ?? "").trim(),
  );
  // Heuristic suggestion — mirrors the server's 4-intent logic in
  // /api/projects/[id]/run/route.ts:246-289. UI and server must agree
  // because the modal sends `intent: sprintIntent` explicitly in the
  // request body, overriding the server-side heuristic. Drift = the
  // badge says X but the dispatch says Y.
  //
  // Order of checks (mirror server exactly):
  //   1. operator selected items → execution
  //   2. backlog has todo items → execution (next item drains)
  //   3. backlog has any items but no todo → planning(grooming)
  //   4. PRD ready (>=80 chars), kanban empty → planning(initiation)
  //   5. briefing present, no PRD, has discovery pipeline → discovery
  //   6. fallback → execution (briefing-per-sprint)
  // Modal briefing field defaults to "" and stays "" unless the operator
  // types something. `??` only falls through on null/undefined, so the old
  // form ignored project.intake_brief whenever the modal field was blank
  // — and the heuristic saw "no briefing" → execution fallback. Use `||`
  // so empty-string falls through to the persisted briefing.
  const briefingLen = (briefing.trim() || ((project as { intake_brief?: string | null }).intake_brief ?? "").trim()).length;
  const prdLen      = ((project as { prd_md?: string | null }).prd_md ?? "").trim().length;
  const heuristicSuggestion: { intent: SprintIntent; submode?: PlanningSubmode; reason: string } = (() => {
    if (backlogSelected.size > 0)                        return { intent: "execution", reason: "operator selected items" };
    if (backlogTodos.length > 0)                         return { intent: "execution", reason: "kanban has a ready item" };
    // Grooming requires ACTIVE non-todo items (e.g. doing). Done /
    // cancelled don't trigger — those mean "kanban is post-work", not
    // "kanban needs grooming".
    if (backlogActiveCount > 0)                          return { intent: "planning", submode: "grooming",  reason: "kanban has active items but none ready" };
    if (prdLen >= 80)                                    return { intent: "planning", submode: "initiation", reason: "PRD ready, kanban empty" };
    if (briefingLen >= 80 && hasDiscoveryPipeline)       return { intent: "discovery", reason: "briefing present, no PRD yet" };
    return { intent: "execution", reason: "fallback — operator briefing as task source" };
  })();
  const heuristicSprintIntent: SprintIntent = heuristicSuggestion.intent;

  // Operator can override the heuristic at any time via the picker. null =
  // follow heuristic. Picker is visible regardless of project.heuristic_intent
  // (mig 169 + 2026-05-05 cleanup): when on, the heuristic suggestion is
  // pre-selected; when off, operator must pick explicitly.
  const projectHeuristicIntent =
    Boolean(((project as { heuristic_intent?: boolean }).heuristic_intent) ?? false);
  const [pickedIntent, setPickedIntent] = useState<SprintIntent | null>(null);
  const sprintIntent: SprintIntent = pickedIntent ?? heuristicSprintIntent;
  const intentAutoPromoted =
    pickedIntent === null
    && backlogSelected.size === 0
    && backlogTodos.length === 0
    && !hasDiscoveryPipeline
    && hasOperatorTask;
  const projectAny = project as {
    discovery_pipeline_id?: string | null;
    planning_pipeline_id?:  string | null;
    execution_pipeline_id?: string | null;
    review_pipeline_id?:    string | null;
  };
  const intentPipelineId =
    sprintIntent === "discovery" ? (projectAny.discovery_pipeline_id ?? null)
    : sprintIntent === "planning" ? (projectAny.planning_pipeline_id  ?? null)
    : sprintIntent === "review"   ? (projectAny.review_pipeline_id    ?? null)
    :                                (projectAny.execution_pipeline_id ?? null);

  // Planning sub-mode picker — only meaningful when intent=planning.
  // Default = the heuristic's recommendation when available, else the
  // most common path (grooming). Operator can override; when sprintIntent
  // isn't planning, we don't send the submode at all.
  const heuristicPlanningSubmode: PlanningSubmode = heuristicSuggestion.submode ?? "grooming";
  const [pickedPlanningSubmode, setPickedPlanningSubmode] = useState<PlanningSubmode | null>(null);
  const planningSubmode: PlanningSubmode | undefined =
    sprintIntent === "planning"
      ? (pickedPlanningSubmode ?? heuristicPlanningSubmode)
      : undefined;

  const projectDefaultPipelineId = (project as { pipeline_id?: string | null }).pipeline_id ?? null;
  const [intentPipelineSteps, setIntentPipelineSteps] = useState<{ step: number; agent: string; phaseName?: string }[] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    if (!intentPipelineId || intentPipelineId === projectDefaultPipelineId) {
      setIntentPipelineSteps(null);
      return () => { cancelled = true; };
    }
    void supabase
      .from("pipelines")
      .select("steps")
      .eq("id", intentPipelineId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data?.steps && Array.isArray(data.steps)) {
          setIntentPipelineSteps(data.steps as { step: number; agent: string; phaseName?: string }[]);
        } else {
          setIntentPipelineSteps(null);
        }
      });
    return () => { cancelled = true; };
  }, [intentPipelineId, projectDefaultPipelineId]);

  // Effective pipeline steps for the chosen intent. Default pipeline
  // (project.pipeline JSONB) is the fallback when no intent-specific
  // pipeline is configured OR when its steps haven't loaded yet.
  const pipelineSteps = (intentPipelineSteps ?? (project.pipeline ?? [])) as { step: number; agent: string; phaseName?: string }[];
  const stepModes = pipelineSteps.map((s) => {
    const override = cliEnabled ? (cliCfg?.agent_overrides?.[s.agent] ?? null) : null;
    const usesCli  = override?.enabled === true;
    return { ...s, usesCli, cli: usesCli ? (override?.cli ?? "cli") : null };
  });

  // Which pipeline these steps came from — drives the inline source label.
  // intentPipelineSteps loaded => intent-specific. Otherwise project default.
  const pipelineSource: SprintIntent | "default" =
    intentPipelineSteps !== null
      ? sprintIntent
      : "default";

  // Per-step sprint instructions: stepNum → { text, override }
  const [stepInstructions, setStepInstructions] = useState<Map<number, { text: string; override: boolean }>>(new Map());
  // Which step's instruction modal is open (null = none)
  const [editingStep,      setEditingStep]      = useState<number | null>(null);
  // Draft state for the open instruction editor
  const [draftText,        setDraftText]        = useState("");
  const [draftOverride,    setDraftOverride]    = useState(false);
  // Which step has the per-step CLI tuning row expanded (null = none)
  const [tunedStep,        setTunedStep]        = useState<number | null>(null);
  // Per-step routing overrides (sprint-level)
  const [stepRouting,      setStepRouting]      = useState<Map<number, StepRoutingEntry>>(() => {
    const m = new Map<number, StepRoutingEntry>();
    // Both local execution modes default to CLI SUBS — they run on the
    // operator's machine and lean on the CLI's subscription session.
    // Cloud falls back to API so each agent calls the provider directly.
    const defaultToCli = cliMode === "local" || cliMode === "local-git";
    stepModes.forEach((s) => {
      if (s.usesCli || defaultToCli) {
        m.set(s.step, { mode: "cli-subs", cli: s.cli ?? "claude-code" });
      } else {
        m.set(s.step, { mode: "api" });
      }
    });
    return m;
  });

  // Skip the next cliMode reset — used during hydration so the routing
  // pulled from initialOverrides isn't immediately clobbered by the default
  // reset that fires when we set cliMode.
  const skipNextCliModeReset = useRef(false);

  // When cliMode changes, reset all steps to match the mode
  useEffect(() => {
    if (skipNextCliModeReset.current) { skipNextCliModeReset.current = false; return; }
    setStepRouting(() => {
      const m = new Map<number, StepRoutingEntry>();
      // Both local execution modes default to CLI SUBS — they run on the
      // operator's machine and lean on the CLI's subscription session.
      const defaultToCli = cliMode === "local" || cliMode === "local-git";
      stepModes.forEach((s) => {
        if (defaultToCli) {
          m.set(s.step, { mode: "cli-subs", cli: s.cli ?? "claude-code" });
        } else {
          m.set(s.step, { mode: "api" });
        }
      });
      return m;
    });
  }, [cliMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the active pipeline changes (any sprintIntent flip — discovery /
  // planning / execution / review each can load a different pipeline async),
  // fully rebuild stepRouting from the cliMode default — same shape the
  // cliMode-change effect produces. Why not preserve operator overrides:
  // the agents themselves may have changed (per-intent pipelines often have
  // disjoint squads), so an entry keyed by step number can't be reliably
  // re-applied to a different agent. Resetting is predictable; the operator
  // re-picks per-step routing on intent flip.
  const pipelineSignature = stepModes.map((s) => `${s.step}:${s.agent}`).join("|");
  useEffect(() => {
    if (skipNextCliModeReset.current) return; // hydration already populated
    setStepRouting(() => {
      const m = new Map<number, StepRoutingEntry>();
      const defaultToCli = cliMode === "local" || cliMode === "local-git";
      stepModes.forEach((s) => {
        if (s.usesCli || defaultToCli) {
          m.set(s.step, { mode: "cli-subs", cli: s.cli ?? "claude-code" });
        } else {
          m.set(s.step, { mode: "api" });
        }
      });
      return m;
    });
  }, [pipelineSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate state from initialOverrides on mount. Used when reopening from
  // the Review modal's "Back" so the operator returns to exactly the same
  // configuration they sent over for review.
  useEffect(() => {
    if (!initialOverrides) return;
    if (initialOverrides.briefing !== undefined)            setBriefing(initialOverrides.briefing);
    if (initialOverrides.bypassGates !== undefined)         setBypassGates(initialOverrides.bypassGates);
    // contextSprintIds / contextCategories / startFromStep used to hydrate the
    // Context & Resume picker — that picker was removed; the keys are still
    // accepted by /run for direct API callers but the modal no longer round-trips them.
    if (initialOverrides.provider) {
      setLlmSource("global");
      setProvider(initialOverrides.provider);
    }
    if (initialOverrides.model) {
      setLlmSource("global");
      setModel(initialOverrides.model);
    }
    if (initialOverrides.agentInstructions) {
      const m = new Map<number, { text: string; override: boolean }>();
      for (const [k, v] of Object.entries(initialOverrides.agentInstructions)) m.set(Number(k), v);
      setStepInstructions(m);
    }
    if (initialOverrides.cliExecutionMode || initialOverrides.stepRoutingOverrides) {
      skipNextCliModeReset.current = true;
      if (initialOverrides.cliExecutionMode) setCliMode(initialOverrides.cliExecutionMode);
      if (initialOverrides.stepRoutingOverrides) {
        const m = new Map<number, StepRoutingEntry>();
        for (const [k, v] of Object.entries(initialOverrides.stepRoutingOverrides)) {
          if (!v.cliOverride.enabled) {
            m.set(Number(k), { mode: "api" });
          } else {
            m.set(Number(k), {
              mode: v.cliOverride.authMode === "api-key" ? "cli-api" : "cli-subs",
              cli:  (v.cliOverride.cli as StepRoutingEntry["cli"]) ?? "claude-code",
              ...(v.cliOverride.model                ? { model:     v.cliOverride.model     } : {}),
              ...(v.cliOverride.effort               ? { effort:    v.cliOverride.effort    } : {}),
              ...(v.cliOverride.planMode             ? { planMode:  v.cliOverride.planMode  } : {}),
              ...(v.cliOverride.budgetUsd !== undefined ? { budgetUsd: v.cliOverride.budgetUsd } : {}),
            });
          }
        }
        setStepRouting(m);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive apiSteps/cliSteps from stepRouting (reflects modal changes)
  const apiSteps = stepModes.filter((s) => (stepRouting.get(s.step)?.mode ?? "api") === "api");
  const cliSteps = stepModes.filter((s) => (stepRouting.get(s.step)?.mode ?? "api") !== "api");

  // (pastSprints fetch effect removed with Context & Resume picker.)

  useEffect(() => {
    setLoadingProviders(true);
    fetch("/api/llm/models", { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then(async (res) => {
        if (res.ok) {
          const body = await res.json() as { providers: LiveProvider[] };
          const providers = body.providers ?? [];
          setLiveProviders(providers);
          if (providers[0]) { setProvider(providers[0].id); setModel(providers[0].models[0]?.id ?? ""); }
        }
      })
      .finally(() => setLoadingProviders(false));
  }, [session]);

  /**
   * Build the override payload from the current modal state. Used by both
   * `handleStart` (direct dispatch) and `handleReview` (open the Review
   * modal). The Review modal composes a SprintPlan from this same shape
   * and dispatches via plan id once the operator confirms.
   */
  function buildOverrides(): SprintRunOverrides {
    const useProjectSettings = llmSource === "project";
    // Sprint task (briefing) only forwarded when the field was actually
    // visible: execution intent + no selected backlog items. Stops stale
    // state from earlier intent picks leaking into a non-execution dispatch.
    const sprintTaskApplies = sprintIntent === "execution" && backlogSelected.size === 0;
    return {
      briefing:            sprintTaskApplies ? (briefing || undefined) : undefined,
      bypassGates:         bypassGates || undefined,
      provider:            useProjectSettings ? undefined : provider,
      model:               useProjectSettings ? undefined : model,
      cliExecutionMode:    cliMode === "project" ? undefined : cliMode,
      ...(stepInstructions.size > 0 ? {
        agentInstructions: Object.fromEntries(
          [...stepInstructions.entries()].map(([step, v]) => [String(step), v])
        ),
      } : {}),
      ...(stepRouting.size > 0 ? {
        stepRoutingOverrides: Object.fromEntries(
          [...stepRouting.entries()].map(([step, r]) => [
            String(step),
            r.mode === "api"
              ? { cliOverride: { enabled: false } }
              : { cliOverride: {
                  enabled: true,
                  cli:     r.cli ?? "claude-code",
                  authMode: r.mode === "cli-api" ? "api-key" as const : "oauth" as const,
                  ...(r.model                ? { model:     r.model     } : {}),
                  ...(r.effort               ? { effort:    r.effort    } : {}),
                  ...(r.planMode             ? { planMode:  r.planMode  } : {}),
                  ...(r.budgetUsd !== undefined ? { budgetUsd: r.budgetUsd } : {}),
                } },
          ])
        ),
      } : {}),
      ...(backlogSelected.size > 0 ? { backlogItemIds: [...backlogSelected] } : {}),
      // Always forward the auto-close decision so the worker doesn't need
      // to fall back to project setting + global default.
      autoClose,
      // Send intent explicitly — the UI already shows the intent as a
      // colored badge, so the server gets the same answer the operator saw.
      // Avoids the foot-gun where the server defaulted to discovery whenever
      // no items were picked.
      intent: sprintIntent,
      ...(planningSubmode ? { planningSubmode } : {}),
    };
  }

  /** Direct dispatch — unchanged behaviour from before the Review flow. */
  async function handleStart() {
    setRunning(true); setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildOverrides()),
      });
      let body: { triggered?: boolean; cli_command?: string | null; error?: string } = {};
      try { body = await res.json(); } catch { /* non-JSON response (e.g. 504) */ }
      if (res.status === 429) { setError("Factory is at its concurrent project limit. Wait for a running sprint to finish, or raise Max concurrent projects in Factory Settings."); return; }
      if (!res.ok) { setError(body.error ?? `Start failed (${res.status}).`); return; }
      if (body.cli_command) { setCliCmd(body.cli_command); return; }
      if (!body.triggered) { setError("Trigger.dev not configured. Check Integrations → Platforms."); return; }
      onStarted({ ...project, status: "running" as Project["status"] });
    } catch (e) {
      setError((e as Error).message ?? "Network error — could not reach server.");
    } finally {
      setRunning(false);
    }
  }

  /** Hand the current overrides up to the parent, which closes us and opens Review. */
  function handleReview() {
    setError(null);
    onReview(buildOverrides());
  }

  // ── Workspace Pack — Install / Remove ───────────────────────────────
  // Install dispatches a "pack-only" sprint: the worker materialises the
  // full scaffold (CLAUDE.md, .claude/agents/*, .mcp.json, skills,
  // commands, hooks, output-styles, permissions, .tp/* and the pack
  // manifest) at the project's local workdir without spawning a CLI.
  // Operator runs claude-code (or another MCP-capable CLI) themselves.
  // Remove reads .tp/pack-manifest.json and deletes everything the
  // platform wrote — operator-authored files stay untouched.
  const [packBusy, setPackBusy] = useState<"install" | "remove" | null>(null);
  async function handleInstallPack() {
    if (packBusy) return;
    setPackBusy("install"); setError(null);
    try {
      // Forward the operator's modal choices so the server respects
      // intent / planningSubmode / backlog selection. Without intent
      // the server falls back to the heuristic and the worker
      // materialises the wrong pipeline's agents.
      const overrides = buildOverrides();
      const res = await fetch(`/api/projects/${project.id}/run`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({
          ...overrides,
          runMode: "pack-only",
          intent:  sprintIntent,
          ...(planningSubmode ? { planningSubmode } : {}),
          ...(backlogSelected.size > 0 ? { backlogItemIds: [...backlogSelected] } : {}),
        }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setError(body.error ?? `Install pack failed (${res.status}).`); return; }
      onClose();
    } catch (e) {
      setError((e as Error).message ?? "Network error.");
    } finally {
      setPackBusy(null);
    }
  }
  async function handleRemovePack() {
    if (packBusy) return;
    if (!confirm(`Remove the AI pack from your local workspace? Only files ${brand.shortName} wrote will be deleted; your other files stay.`)) return;
    setPackBusy("remove"); setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/pack/remove`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) { setError(body.error ?? `Remove pack failed (${res.status}).`); return; }
      onClose();
    } catch (e) {
      setError((e as Error).message ?? "Network error.");
    } finally {
      setPackBusy(null);
    }
  }
  // Pack actions only make sense for local / local-git mode. Cloud has
  // no operator-visible workdir, so we hide the buttons there.
  const packAvailable = cliMode === "local" || cliMode === "local-git";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div style={{
        background: "var(--mantle)",
        border: "1px solid var(--surface0)",
        borderRadius: 18,
        // Wider canvas (was 520) so per-step routing rows fit without
        // wrapping awkwardly. Cap at 95vw on small screens.
        width: "min(760px, 95vw)",
        // Cap height to viewport with scroll when content overflows —
        // operators on shorter screens couldn't reach the Start button
        // because pipeline + tuning sections pushed it offscreen.
        maxHeight: "92vh",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
      }}>
        {/* Sticky header — Reset / Close stay reachable while scrolling. */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "20px 24px 12px", borderBottom: "1px solid var(--surface0)",
          background: "var(--mantle)", borderTopLeftRadius: 18, borderTopRightRadius: 18,
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Start Sprint {sprintNum}</div>
            <div style={{ fontSize: 11, color: "var(--overlay0)" }}>{project.name}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={resetToDefaults} title="Reset to project defaults" style={{
              display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6,
              border: "1px solid var(--surface1)", background: "transparent",
              color: "var(--overlay0)", fontSize: 10, cursor: "pointer", fontFamily: "var(--font-sans)",
            }}>
              <RotateCcw size={10} /> Reset
            </button>
            <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)" }}><X size={16} /></button>
          </div>
        </div>

        {/* Scrollable body — pipeline + tuning + briefing sections grow
         *  past the viewport on small screens; this region absorbs the
         *  overflow while header (Reset/Close) and footer (Start/Review)
         *  stay reachable. */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 20px" }}>

        {cliCmd ? (
          <>
            <div style={{ background: "var(--crust)", border: "1px solid var(--surface0)", borderRadius: 10, padding: "12px 16px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--green)", marginBottom: 12 }}>{cliCmd}</div>
            <button onClick={onClose} style={{ width: "100%", padding: "9px", borderRadius: 9, border: "none", background: "#1463ff", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Close</button>
          </>
        ) : (
          <>
            {/* ── Backlog items ── (only when there are TODOs) */}
            {backlogTodos.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>
                  Backlog items
                  <span style={{ fontWeight: 400, marginLeft: 6, color: "var(--overlay0)" }}>
                    ({backlogSelected.size}/{backlogTodos.length})
                  </span>
                  <a href={`/projects/${project.id}/backlog`} target="_blank" rel="noreferrer"
                    style={{ fontSize: 10, color: "var(--blue)", textDecoration: "none", marginLeft: 8, fontWeight: 500 }}>
                    Manage backlog →
                  </a>
                </label>
                <div style={{
                  display: "flex", flexDirection: "column", gap: 4,
                  maxHeight: 160, overflowY: "auto",
                  background: "var(--crust)", borderRadius: 8, padding: "6px 8px",
                  border: "1px solid var(--surface0)",
                }}>
                  {backlogTodos.map((it) => {
                    const checked = backlogSelected.has(it.id);
                    return (
                      <label key={it.id} style={{
                        display: "flex", alignItems: "flex-start", gap: 8,
                        padding: "4px 6px", borderRadius: 5, cursor: "pointer",
                        background: checked ? "rgba(20,99,255,0.06)" : "transparent",
                      }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setBacklogSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(it.id); else next.delete(it.id);
                            return next;
                          })}
                          style={{ width: 13, height: 13, accentColor: "var(--blue)", flexShrink: 0, marginTop: 2 }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: checked ? 600 : 500, color: checked ? "var(--text)" : "var(--subtext0)", lineHeight: 1.4 }}>
                            {it.title}
                          </div>
                          {it.description && (
                            <div style={{
                              fontSize: 10, color: "var(--overlay0)", lineHeight: 1.4, marginTop: 1,
                              display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden",
                            }}>
                              {it.description}
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4, lineHeight: 1.5 }}>
                  Selected items flip to <strong>Doing</strong> when the sprint starts and <strong>Done</strong> on success. Failed sprints leave them in <strong>Doing</strong> for the operator to decide.
                </div>
              </div>
            )}

            <div style={{ borderTop: "1px solid var(--surface0)", margin: "14px 0" }} />

            {/* ── Sprint intent — picker, optional task, planning sub-mode, steps ── */}
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Sprint intent</label>

              {/* Intent picker — always visible.
                  When project.heuristic_intent=true, the heuristic's
                  suggestion is pre-selected and the picker shows an
                  "auto" hint badge so the operator can see what the
                  heuristic chose; clicking another button overrides.
                  When heuristic_intent=false, picker is the only source —
                  no auto badge.
                  sprintIntent drives which pipeline loads + which intent
                  is sent to /run (always sent — UI is the source of truth). */}
              <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Intent</span>
                {([
                  { id: "discovery", label: "Discovery", color: "var(--blue)"   },
                  { id: "planning",  label: "Planning",  color: "var(--mauve)"  },
                  { id: "execution", label: "Execution", color: "var(--green)"  },
                  { id: "review",    label: "Review",    color: "var(--peach)"  },
                ] as const).map((opt) => {
                  const active        = sprintIntent === opt.id;
                  const isHeuristic   = projectHeuristicIntent && pickedIntent === null && heuristicSprintIntent === opt.id;
                  const tooltip       = isHeuristic
                    ? `Heuristic chose ${opt.label} (${heuristicSuggestion.reason}). Click another to override.`
                    : `Run as ${opt.label}`;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setPickedIntent(opt.id)}
                      title={tooltip}
                      style={{
                        padding: "3px 9px", borderRadius: 4,
                        border: `1px solid ${active ? opt.color : "var(--surface1)"}`,
                        background: active ? `${opt.color}18` : "transparent",
                        color:      active ? opt.color : "var(--subtext0)",
                        fontSize: 10, fontWeight: 700, cursor: "pointer",
                        fontFamily: "var(--font-sans)",
                        display: "inline-flex", alignItems: "center", gap: 4,
                      }}
                    >
                      {opt.label}
                      {isHeuristic && (
                        <span style={{ fontSize: 8, padding: "0 4px", borderRadius: 2, background: `${opt.color}30`, color: opt.color, fontWeight: 700, letterSpacing: "0.04em" }}>auto</span>
                      )}
                    </button>
                  );
                })}
                {(pickedIntent !== null || pickedPlanningSubmode !== null) && projectHeuristicIntent && (
                  <button
                    type="button"
                    onClick={() => {
                      setPickedIntent(null);
                      setPickedPlanningSubmode(null);
                    }}
                    title={`Revert to heuristic (${heuristicSprintIntent}${heuristicSuggestion.submode ? `:${heuristicSuggestion.submode}` : ""}: ${heuristicSuggestion.reason})`}
                    style={{
                      padding: "3px 7px", borderRadius: 4, border: "1px dashed var(--surface1)",
                      background: "transparent", color: "var(--overlay0)",
                      fontSize: 10, cursor: "pointer", fontFamily: "var(--font-sans)",
                    }}
                  >
                    Reset to auto
                  </button>
                )}
              </div>

              {/* Sprint task — per-sprint task source, only meaningful for
               *  execution sprints without selected backlog items. Discovery
               *  uses project.intake_brief; planning/review derive from
               *  project state. When kanban items are selected, the items
               *  ARE the task — extra free text would be ambiguous. */}
              {sprintIntent === "execution" && backlogSelected.size === 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                    Sprint task <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional)</span>
                  </div>
                  <textarea value={briefing} onChange={(e) => setBriefing(e.target.value)}
                    placeholder={project.intake_brief ?? "Describe the task for this execution sprint."}
                    rows={3} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} />
                  <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4, lineHeight: 1.5 }}>
                    Per-sprint task description. Empty falls back to the project briefing.
                  </div>
                </div>
              )}

              {/* Planning sub-mode — only meaningful when intent=planning.
                  Mirrors sprints.planning_submode constraint
                  (initiation|grooming|sprint-backlog). Surfaced to the
                  worker as an MCP signal — no separate pipeline.
                  Same auto-pre-select pattern as the intent picker. */}
              {sprintIntent === "planning" && (
                <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Sub-mode</span>
                  {([
                    { id: "initiation",     label: "Initiation",     hint: "First kanban population from PRD" },
                    { id: "grooming",       label: "Grooming",       hint: "Refine / re-rank existing items" },
                    { id: "sprint-backlog", label: "Sprint backlog", hint: "Pick the next items into a sprint" },
                  ] as const).map((opt) => {
                    const effective   = pickedPlanningSubmode ?? heuristicPlanningSubmode;
                    const active      = effective === opt.id;
                    const isHeuristic = projectHeuristicIntent && pickedPlanningSubmode === null && heuristicPlanningSubmode === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setPickedPlanningSubmode(opt.id)}
                        title={opt.hint}
                        style={{
                          padding: "3px 9px", borderRadius: 4,
                          border: `1px solid ${active ? "var(--mauve)" : "var(--surface1)"}`,
                          background: active ? "rgba(203,166,247,0.12)" : "transparent",
                          color:      active ? "var(--mauve)" : "var(--subtext0)",
                          fontSize: 10, fontWeight: 700, cursor: "pointer",
                          fontFamily: "var(--font-sans)",
                          display: "inline-flex", alignItems: "center", gap: 4,
                        }}
                      >
                        {opt.label}
                        {isHeuristic && (
                          <span style={{ fontSize: 8, padding: "0 4px", borderRadius: 2, background: "rgba(203,166,247,0.30)", color: "var(--mauve)", fontWeight: 700, letterSpacing: "0.04em" }}>auto</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Pipeline source line — makes it obvious which of the
                  project's pipelines is loaded right now. Sprint intent
                  is derived from backlog selection, so the operator
                  can see WHY this set of steps appeared. */}
              {stepModes.length > 0 && (
                <div style={{
                  fontSize: 11, color: "var(--subtext0)", marginBottom: 8, lineHeight: 1.5,
                  padding: "6px 10px", borderRadius: 6, background: "var(--mantle)",
                  border: "1px solid var(--surface0)",
                }}>
                  Steps loaded from your{" "}
                  <strong style={{ color:
                    pipelineSource === "execution" ? "var(--green)"
                    : pipelineSource === "discovery" ? "var(--blue)"
                    : pipelineSource === "planning"  ? "var(--mauve)"
                    : pipelineSource === "review"    ? "var(--peach)"
                    : "var(--subtext0)" }}>
                    {pipelineSource === "default" ? "default" : pipelineSource}
                  </strong>{" "}
                  pipeline ({sprintIntent} intent
                  {planningSubmode ? <> · <em>{planningSubmode}</em></> : null}
                  ).{" "}
                  {sprintIntent === "execution" && backlogSelected.size === 0 && backlogTodos.length > 0 && (
                    <span style={{ color: "var(--overlay0)" }}>
                      No items selected — the dispatcher will pick the first todo (<em>{backlogTodos[0]?.title}</em>). Tick items below to override.
                    </span>
                  )}
                  {sprintIntent === "execution" && backlogSelected.size > 0 && (
                    <span style={{ color: "var(--overlay0)" }}>
                      {backlogSelected.size} item{backlogSelected.size === 1 ? "" : "s"} selected.
                    </span>
                  )}
                  {sprintIntent === "discovery" && (
                    <span style={{ color: "var(--overlay0)" }}>Discovery agents read the briefing/PRD and decide what's next — outputs land as new backlog items, specs and decisions for future sprints.</span>
                  )}
                  {sprintIntent === "planning" && (
                    <span style={{ color: "var(--overlay0)" }}>
                      Product-owner-led planning. {pickedPlanningSubmode === "initiation"
                        ? "Populate the kanban from the PRD."
                        : pickedPlanningSubmode === "grooming"
                          ? "Refine existing items + re-prioritise."
                          : "Pick the next items into a sprint backlog."}
                    </span>
                  )}
                  {sprintIntent === "review" && (
                    <span style={{ color: "var(--overlay0)" }}>Post-sprint quality gate — qa / eval / reviewer agents inspect recent work and emit review markers.</span>
                  )}
                  {sprintIntent === "execution" && intentAutoPromoted && (
                    <span style={{ color: "var(--mauve)" }}>
                      Backlog empty AND no discovery pipeline configured — running this as <strong>execution</strong> with your briefing/PRD as the task. To run discovery instead, configure a Discovery pipeline in Project Settings.
                    </span>
                  )}
                </div>
              )}

              {/* Empty state — project has no pipeline. Block visibly and
                  hint the operator at the fix instead of letting them hit
                  Start and get a generic 422 from the backend. */}
              {stepModes.length === 0 && (
                <div style={{
                  padding: "12px 14px", borderRadius: 8,
                  background: "rgba(245,159,0,0.06)",
                  border: "1px dashed rgba(245,159,0,0.3)",
                  color: "var(--peach)", fontSize: 12, lineHeight: 1.5,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>No pipeline assigned</div>
                  <div style={{ color: "var(--subtext0)" }}>
                    Open <strong>Project Settings → Pipeline</strong> and pick one before starting a sprint. The sprint can&apos;t run without steps.
                  </div>
                </div>
              )}

              {/* Step breakdown — always visible so the user knows what will run */}
              {stepModes.length > 0 && (
                <div style={{
                  background: "var(--crust)", borderRadius: 8, padding: "8px 10px",
                  marginBottom: 10, display: "flex", flexDirection: "column", gap: 4,
                }}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 2, gap: 6 }}>
                    <span style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>Steps</span>
                    <span
                      title={
                        sprintIntent === "execution" ? "Execution sprint — backlog-driven. Steps come from the project's execution pipeline (or default)."
                        : sprintIntent === "discovery" ? "Discovery sprint — agents decide what to work on. Steps come from the project's discovery pipeline (or default)."
                        : sprintIntent === "planning" ? "Planning sprint — product owner grooms the backlog. Steps come from the project's planning pipeline (or default)."
                        : "Review sprint — qa / eval / reviewer agents check recent work. Steps come from the project's review pipeline (or default)."}
                      style={(() => {
                        const palette =
                          sprintIntent === "execution" ? { bg: "rgba(28,191,107,0.15)",  fg: "var(--green, #40a02b)" }
                          : sprintIntent === "discovery" ? { bg: "rgba(20,99,255,0.15)",   fg: "var(--blue, #1463ff)" }
                          : sprintIntent === "planning"  ? { bg: "rgba(203,166,247,0.15)", fg: "var(--mauve, #cba6f7)" }
                          :                                { bg: "rgba(245,159,0,0.15)",   fg: "var(--peach, #fe640b)" };
                        return {
                          fontSize: 9, padding: "1px 6px", borderRadius: 4, fontWeight: 700,
                          background: palette.bg, color: palette.fg,
                          textTransform: "uppercase" as const, letterSpacing: "0.04em",
                        };
                      })()}
                    >
                      {sprintIntent}
                      {planningSubmode ? `:${planningSubmode}` : ""}
                    </span>
                    <a href="/projects" style={{ fontSize: 10, color: "var(--blue)", textDecoration: "none" }}>Configure routing →</a>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700, width: 72, textAlign: "center" }}>Instruction</span>
                  </div>
                  {stepModes.map((s) => {
                    const instr = stepInstructions.get(s.step);
                    const hasInstr = Boolean(instr?.text);
                    const routing = stepRouting.get(s.step) ?? { mode: s.usesCli ? "cli-subs" as StepRoutingMode : "api" as StepRoutingMode, cli: s.cli ?? undefined };
                    const ROUTING_OPTIONS: { id: StepRoutingMode; label: string; bg: string; fg: string }[] = [
                      { id: "api",      label: "API",      bg: "rgba(20,99,255,0.10)",   fg: "#1463ff" },
                      { id: "cli-api",  label: "CLI API",  bg: "rgba(166,227,161,0.12)", fg: "var(--green)" },
                      { id: "cli-subs", label: "CLI SUBS", bg: "rgba(249,226,175,0.12)", fg: "var(--yellow)" },
                    ];
                    const activeOpt = ROUTING_OPTIONS.find((o) => o.id === routing.mode) ?? ROUTING_OPTIONS[0];
                    const tuneApplicable = routing.mode !== "api" && (routing.cli ?? "claude-code") === "claude-code";
                    const hasTuning = Boolean(routing.model || routing.effort || routing.planMode || routing.budgetUsd !== undefined);
                    const isTuneOpen = tunedStep === s.step;
                    return (
                      <React.Fragment key={s.step}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                        <span style={{ color: "var(--overlay0)", width: 18, flexShrink: 0, textAlign: "right" }}>{s.step}</span>
                        <span style={{ flex: 1, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.agent}</span>
                        {/* Routing mode selector */}
                        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                          {ROUTING_OPTIONS.map((opt) => {
                            const isActive = routing.mode === opt.id;
                            return (
                              <button
                                key={opt.id}
                                onClick={() => {
                                  setStepRouting((prev) => {
                                    const m = new Map(prev);
                                    const cur = m.get(s.step) ?? { mode: "api" as StepRoutingMode };
                                    m.set(s.step, { ...cur, mode: opt.id, cli: opt.id !== "api" ? (cur.cli ?? s.cli ?? "claude-code") : undefined });
                                    return m;
                                  });
                                }}
                                style={{
                                  padding: "1px 5px", borderRadius: 4, fontSize: 9, fontWeight: isActive ? 700 : 500,
                                  background: isActive ? opt.bg : "transparent",
                                  color: isActive ? opt.fg : "var(--overlay0)",
                                  border: isActive ? `1px solid ${opt.fg}33` : "1px solid transparent",
                                  cursor: "pointer", fontFamily: "var(--font-sans)",
                                  lineHeight: "16px", whiteSpace: "nowrap",
                                }}
                                title={
                                  opt.id === "api" ? "Uses provider API directly (no CLI)"
                                  : opt.id === "cli-api" ? "Uses CLI headless with API key"
                                  : "Uses CLI with subscription/OAuth"
                                }
                              >{opt.label}</button>
                            );
                          })}
                        </div>
                        {/* CLI selector — shown when cli-api or cli-subs */}
                        {routing.mode !== "api" && (
                          <select
                            value={routing.cli ?? "claude-code"}
                            onChange={(e) => {
                              setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                m.set(s.step, { ...cur, cli: e.target.value });
                                return m;
                              });
                            }}
                            style={{
                              padding: "1px 4px", borderRadius: 4, fontSize: 9, fontWeight: 600,
                              background: "var(--surface0)", border: "1px solid var(--surface1)",
                              color: "var(--text)", cursor: "pointer", fontFamily: "var(--font-sans)",
                              height: 20, flexShrink: 0,
                            }}
                          >
                            {CLI_OPTIONS.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}{opt.status === "experimental" ? " (experimental)" : ""}
                              </option>
                            ))}
                          </select>
                        )}
                        {/* Per-step tune toggle — only meaningful when running claude-code via CLI. */}
                        {tuneApplicable && (
                          <button
                            onClick={() => setTunedStep(isTuneOpen ? null : s.step)}
                            title={hasTuning ? "Edit Claude Code tuning (effort / plan-mode / budget)" : "Tune Claude Code (effort / plan-mode / budget)"}
                            style={{
                              background: hasTuning ? "rgba(245,194,231,0.10)" : (isTuneOpen ? "var(--surface0)" : "none"),
                              border: hasTuning ? "1px solid rgba(245,194,231,0.30)" : "1px solid transparent",
                              cursor: "pointer", padding: "2px 4px",
                              borderRadius: 4, display: "flex", alignItems: "center",
                              color: hasTuning ? "var(--pink)" : "var(--overlay0)",
                              flexShrink: 0,
                            }}
                          >
                            <SlidersHorizontal size={10} />
                          </button>
                        )}
                        <div style={{ width: 72, flexShrink: 0, display: "flex", justifyContent: "center" }}>
                          <button
                            onClick={() => {
                              setDraftText(instr?.text ?? "");
                              setDraftOverride(instr?.override ?? false);
                              setEditingStep(s.step);
                            }}
                            title={hasInstr ? `Edit instruction (${instr!.override ? "override" : "append"})` : "Add sprint instruction"}
                            style={{
                              background: hasInstr ? "rgba(20,99,255,0.08)" : "none",
                              border: hasInstr ? "1px solid rgba(20,99,255,0.25)" : "1px solid transparent",
                              cursor: "pointer", padding: "2px 6px",
                              borderRadius: 4, display: "flex", alignItems: "center", gap: 4,
                              color: hasInstr ? "var(--blue)" : "var(--overlay0)",
                            }}
                          >
                            <Pencil size={10} />
                            {hasInstr && <span style={{ fontSize: 9, fontWeight: 700 }}>{instr!.override ? "OVR" : "ADD"}</span>}
                          </button>
                        </div>
                      </div>
                      {/* Expanded tuning row — claude-code knobs (effort, plan-mode, budget). */}
                      {isTuneOpen && tuneApplicable && (
                        <div style={{
                          display: "flex", alignItems: "center", gap: 10, fontSize: 10,
                          padding: "6px 8px 6px 26px", marginBottom: 2,
                          background: "var(--mantle)", borderRadius: 4,
                          border: "1px solid var(--surface0)",
                        }}>
                          {/* Effort */}
                          {/* Model — overrides the project cascade (planning/dev/governance
                             category model → project default → factory default) for this
                             step only. Empty = inherit. */}
                          <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--overlay1)" }}>
                            <span style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>Model</span>
                            <select
                              value={routing.model ?? ""}
                              onChange={(e) => setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                if (e.target.value === "") { const { model: _drop, ...rest } = cur; m.set(s.step, rest); }
                                else                       { m.set(s.step, { ...cur, model: e.target.value }); }
                                return m;
                              })}
                              style={{
                                padding: "1px 4px", borderRadius: 3, fontSize: 10, fontWeight: 600,
                                background: "var(--surface0)", border: "1px solid var(--surface1)",
                                color: "var(--text)", cursor: "pointer", fontFamily: "var(--font-sans)",
                                height: 18,
                              }}
                              title="Per-step model override. Empty = inherit project cascade (planning/dev/governance category model → project default)."
                            >
                              <option value="">inherit</option>
                              {MODEL_OPTIONS.map((m) => (
                                <option key={m.value} value={m.value} title={m.hint}>{m.label}</option>
                              ))}
                            </select>
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--overlay1)" }}>
                            <span style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>Effort</span>
                            <select
                              value={routing.effort ?? ""}
                              onChange={(e) => setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                const v = e.target.value as "" | "low" | "medium" | "high" | "max";
                                if (v === "") { const { effort: _drop, ...rest } = cur; m.set(s.step, rest); }
                                else          { m.set(s.step, { ...cur, effort: v }); }
                                return m;
                              })}
                              style={{
                                padding: "1px 4px", borderRadius: 3, fontSize: 10, fontWeight: 600,
                                background: "var(--surface0)", border: "1px solid var(--surface1)",
                                color: "var(--text)", cursor: "pointer", fontFamily: "var(--font-sans)",
                                height: 18,
                              }}
                            >
                              <option value="">default</option>
                              <option value="low">low</option>
                              <option value="medium">medium</option>
                              <option value="high">high</option>
                              <option value="max">max</option>
                            </select>
                          </label>
                          {/* Plan mode */}
                          <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--overlay1)", cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={routing.planMode ?? false}
                              onChange={(e) => setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                if (e.target.checked) m.set(s.step, { ...cur, planMode: true });
                                else { const { planMode: _drop, ...rest } = cur; m.set(s.step, rest); }
                                return m;
                              })}
                              style={{ margin: 0 }}
                            />
                            <span style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>Plan mode</span>
                            <span style={{ color: "var(--overlay0)", fontSize: 9 }}>(no writes)</span>
                          </label>
                          {/* Budget */}
                          <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--overlay1)" }}>
                            <span style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>Budget $</span>
                            <input
                              type="number"
                              min={0}
                              step={0.5}
                              placeholder="—"
                              value={routing.budgetUsd ?? ""}
                              onChange={(e) => setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                if (e.target.value === "") { const { budgetUsd: _drop, ...rest } = cur; m.set(s.step, rest); }
                                else                       { m.set(s.step, { ...cur, budgetUsd: parseFloat(e.target.value) }); }
                                return m;
                              })}
                              style={{
                                padding: "1px 4px", borderRadius: 3, fontSize: 10, fontWeight: 600,
                                background: "var(--surface0)", border: "1px solid var(--surface1)",
                                color: "var(--text)", fontFamily: "var(--font-sans)",
                                height: 18, width: 56,
                              }}
                            />
                          </label>
                          <span style={{ flex: 1 }} />
                          {hasTuning && (
                            <button
                              onClick={() => setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                const { model: _m, effort: _e, planMode: _p, budgetUsd: _b, ...rest } = cur;
                                m.set(s.step, rest);
                                return m;
                              })}
                              style={{
                                fontSize: 9, fontWeight: 600, color: "var(--overlay0)",
                                background: "none", border: "none", cursor: "pointer", padding: 0,
                              }}
                              title="Clear all tuning for this step"
                            >reset</button>
                          )}
                        </div>
                      )}
                      </React.Fragment>
                    );
                  })}
                </div>
              )}

              {/* Per-step agent instruction editor modal */}
              {editingStep !== null && (() => {
                const stepInfo = stepModes.find((s) => s.step === editingStep);
                return (
                  <div style={{
                    position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
                    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300,
                  }}>
                    <div style={{
                      background: "var(--mantle)", border: "1px solid var(--surface1)",
                      borderRadius: 14, width: "min(420px, 92vw)", padding: 20,
                      boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>Sprint Instruction</div>
                          <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
                            Step {editingStep} · <span style={{ color: "var(--text)" }}>{stepInfo?.agent}</span>
                          </div>
                        </div>
                        <button onClick={() => setEditingStep(null)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)" }}>
                          <X size={15} />
                        </button>
                      </div>

                      <textarea
                        autoFocus
                        value={draftText}
                        onChange={(e) => setDraftText(e.target.value)}
                        placeholder="Enter specific instructions for this agent in this sprint…"
                        rows={5}
                        style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, marginBottom: 12 }}
                      />

                      <label style={{
                        display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                        padding: "8px 10px", borderRadius: 8, marginBottom: 14,
                        border: `1px solid ${draftOverride ? "rgba(249,226,175,0.4)" : "var(--surface1)"}`,
                        background: draftOverride ? "rgba(249,226,175,0.06)" : "transparent",
                      }}>
                        <input
                          type="checkbox"
                          checked={draftOverride}
                          onChange={(e) => setDraftOverride(e.target.checked)}
                          style={{ marginTop: 2, accentColor: "#f9e2af" }}
                        />
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: draftOverride ? "var(--yellow)" : "var(--text)" }}>Override</div>
                          <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
                            {draftOverride
                              ? "This instruction replaces the agent's original instructions."
                              : "This instruction is appended to the agent's original instructions."}
                          </div>
                        </div>
                      </label>

                      <div style={{ display: "flex", gap: 8 }}>
                        {stepInstructions.has(editingStep) && (
                          <button
                            onClick={() => {
                              setStepInstructions((prev) => { const m = new Map(prev); m.delete(editingStep); return m; });
                              setEditingStep(null);
                            }}
                            style={{
                              padding: "8px 14px", borderRadius: 8, border: "1px solid var(--surface1)",
                              background: "transparent", color: "var(--red)", fontSize: 12,
                              cursor: "pointer", fontFamily: "var(--font-sans)",
                            }}
                          >Remove</button>
                        )}
                        <button
                          onClick={() => setEditingStep(null)}
                          style={{
                            padding: "8px 14px", borderRadius: 8, border: "1px solid var(--surface1)",
                            background: "transparent", color: "var(--subtext0)", fontSize: 12,
                            cursor: "pointer", fontFamily: "var(--font-sans)", marginLeft: "auto",
                          }}
                        >Cancel</button>
                        <button
                          onClick={() => {
                            if (draftText.trim()) {
                              setStepInstructions((prev) => new Map(prev).set(editingStep, { text: draftText.trim(), override: draftOverride }));
                            } else {
                              setStepInstructions((prev) => { const m = new Map(prev); m.delete(editingStep); return m; });
                            }
                            setEditingStep(null);
                          }}
                          style={{
                            padding: "8px 16px", borderRadius: 8, border: "none",
                            background: "#1463ff", color: "#fff", fontSize: 12, fontWeight: 700,
                            cursor: "pointer", fontFamily: "var(--font-sans)",
                          }}
                        >Save</button>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* API steps config — only shown when there are API steps */}
              {apiSteps.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 6 }}>
                    LLM for <strong style={{ color: "var(--text)" }}>{apiSteps.length} API step{apiSteps.length !== 1 ? "s" : ""}</strong>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                    {(["project", "global"] as const).map((src) => {
                      const active = llmSource === src;
                      const label = src === "project"
                        ? `Project${hasProjectLLM ? ` (${projProvider}${projModel ? ` / ${projModel.split("-").slice(0,2).join("-")}` : ""})` : " — not set"}`
                        : "Global";
                      const disabled = src === "project" && !hasProjectLLM;
                      return (
                        <button
                          key={src}
                          disabled={disabled}
                          onClick={() => !disabled && setLlmSource(src)}
                          style={{
                            display: "flex", alignItems: "center", gap: 7,
                            padding: "5px 11px", borderRadius: 8, cursor: disabled ? "default" : "pointer",
                            border: `1.5px solid ${active ? "rgba(20,99,255,0.5)" : "var(--surface1)"}`,
                            background: active ? "rgba(20,99,255,0.08)" : "var(--surface0)",
                            color: disabled ? "var(--overlay0)" : active ? "#1463ff" : "var(--subtext0)",
                            fontSize: 12, fontWeight: active ? 700 : 400, fontFamily: "var(--font-sans)",
                            opacity: disabled ? 0.5 : 1,
                          }}
                        >
                          <span style={{ fontSize: 14, lineHeight: 1 }}>{active ? "●" : "○"}</span>
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  {llmSource === "global" && (
                    loadingProviders ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--overlay0)", padding: "4px 0" }}>
                        <RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> Loading…
                      </div>
                    ) : liveProviders.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--yellow)", padding: "4px 0" }}>
                        No providers configured. <a href="/providers" style={{ color: "var(--blue)" }}>Add an API key.</a>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8 }}>
                        <select value={provider} onChange={(e) => { setProvider(e.target.value); setModel(liveProviders.find((p) => p.id === e.target.value)?.models[0]?.id ?? ""); }}
                          style={{ ...inputStyle, padding: "6px 10px", height: 34, width: 140 }}>
                          {liveProviders.map((p) => <option key={p.id} value={p.id}>{PROVIDER_NAMES[p.id] ?? p.id}</option>)}
                        </select>
                        <select value={model} onChange={(e) => setModel(e.target.value)}
                          style={{ ...inputStyle, padding: "6px 10px", height: 34, flex: 1 }}>
                          {(liveProviders.find((p) => p.id === provider)?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                        </select>
                      </div>
                    )
                  )}
                </div>
              )}

            </div>

            {/* ── Flags ── Bypass + Auto-close grouped together. */}
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Flags</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "10px 12px", borderRadius: 10, border: `1px solid ${bypassGates ? "var(--yellow)" : "var(--surface1)"}`, background: bypassGates ? "rgba(249,226,175,0.06)" : "transparent" }}>
                  <input type="checkbox" checked={bypassGates} onChange={(e) => setBypassGates(e.target.checked)} style={{ marginTop: 2, accentColor: "#f9e2af" }} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: bypassGates ? "var(--yellow)" : "var(--text)" }}>Bypass human gates</div>
                    <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>Auto-approve all gate pauses — pipeline runs fully unattended.</div>
                  </div>
                </label>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--surface1)", background: "var(--crust)" }}>
                  <input type="checkbox" checked={autoClose} onChange={(e) => setAutoClose(e.target.checked)} style={{ marginTop: 2, accentColor: "var(--blue)" }} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Auto-close on completion</div>
                    <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2, lineHeight: 1.4 }}>
                      {autoClose
                        ? "Sprint promotes itself: success → completed, failure → acknowledged (no manual action)."
                        : "Sprint stops at pending_save or failed. You decide save/discard or finalize manually."}
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {/* ── Orchestration Mode ── (relocated from earlier in the form) */}
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>
                Orchestration Mode
                {!allowModeSwitch && (
                  <span style={{
                    marginLeft: 8, fontSize: 10, fontWeight: 600,
                    padding: "2px 7px", borderRadius: 99,
                    background: "rgba(245,159,0,0.12)", color: "var(--peach)",
                    textTransform: "uppercase", letterSpacing: "0.04em",
                  }}>
                    Locked
                  </span>
                )}
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                {([
                  { id: "cloud"     as const, label: "Cloud",       tooltip: "Tasks run entirely on Trigger.dev cloud workers. Artifacts are stored in Supabase and can be downloaded or pushed to Git." },
                  { id: "local"     as const, label: "Local",       tooltip: "Tasks orchestrated by Trigger.dev but executed on your machine via `trigger dev`. Use CLIs with subscription. Each sprint writes to its own staging/sprint-N/ folder." },
                  { id: "local-git" as const, label: "Local + Git", tooltip: "Local execution where artifacts are versioned at the project root via git. Each sprint mutates the live tree and (by default) auto-commits + tags at sprint end." },
                ] as const).map((opt) => {
                  const active        = cliMode === opt.id;
                  const lockedOut     = !allowModeSwitch && cliMode !== opt.id;
                  const evalForMode   = modeAvailability[opt.id];
                  const unavailable   = !evalForMode.enabled;
                  const disabled      = lockedOut || unavailable;
                  const tooltipReason =
                    lockedOut    ? "Project is mode-locked. Toggle 'Allow per-sprint mode switching' in Project Settings to unlock."
                  : unavailable  ? evalForMode.reason ?? "This mode is unavailable for this project."
                  : evalForMode.severity === "warning" ? evalForMode.reason
                  : undefined;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => { if (!disabled) setCliMode(opt.id); }}
                      disabled={disabled}
                      title={tooltipReason}
                      style={{
                        display: "flex", alignItems: "center", gap: 7,
                        padding: "7px 14px", borderRadius: 8,
                        cursor: disabled ? "not-allowed" : "pointer",
                        opacity: disabled ? 0.4 : 1,
                        border: `1.5px solid ${active ? "rgba(20,99,255,0.5)" : "var(--surface1)"}`,
                        background: active ? "rgba(20,99,255,0.08)" : "var(--surface0)",
                        color: active ? "#1463ff" : "var(--subtext0)",
                        fontSize: 13, fontWeight: active ? 700 : 400, fontFamily: "var(--font-sans)",
                      }}
                    >
                      <span style={{ fontSize: 15, lineHeight: 1 }}>{active ? "●" : "○"}</span>
                      {opt.label}
                      <Tooltip text={opt.tooltip}>
                        <HelpCircle size={13} style={{ color: "var(--overlay0)", cursor: "help" }} />
                      </Tooltip>
                    </button>
                  );
                })}
              </div>
              {!allowModeSwitch && (
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 6, lineHeight: 1.5 }}>
                  Mode is fixed by the project. Open <strong>Project Settings &rarr; Orchestration Mode</strong> and turn on <em>Allow per-sprint mode switching</em> to override per sprint.
                </div>
              )}
            </div>

            {error && <div style={{ fontSize: 12, color: "var(--red)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><AlertTriangle size={12} />{error}</div>}
            {/* Footer order: Cancel | Review | Install Pack | Remove Pack | Start Sprint
             *  Install / Remove only render for local / local-git modes (cloud has no
             *  operator workdir to install into). */}
            <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              <button onClick={onClose} style={{ padding: "9px 16px", borderRadius: 9, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Cancel</button>
              <button onClick={handleReview} disabled={running || packBusy !== null} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 14px", borderRadius: 9, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext1)", fontSize: 13, fontWeight: 600, cursor: (running || packBusy !== null) ? "not-allowed" : "pointer", opacity: (running || packBusy !== null) ? 0.5 : 1, fontFamily: "var(--font-sans)" }}>
                Review <ChevronRight size={13} />
              </button>
              {packAvailable && (
                <>
                  <button
                    onClick={handleInstallPack}
                    disabled={running || packBusy !== null}
                    title="Materialise CLAUDE.md, .claude/agents/, .mcp.json, skills, commands, hooks, output-styles, permissions and .tp/* at the project's local workdir. No CLI is spawned."
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "9px 14px", borderRadius: 9,
                      border: "1px solid var(--surface1)",
                      background: packBusy === "install" ? "var(--surface0)" : "rgba(166,209,137,0.10)",
                      color: "var(--green)", fontSize: 13, fontWeight: 600,
                      cursor: (running || packBusy !== null) ? "not-allowed" : "pointer",
                      opacity: (running || packBusy !== null) ? 0.6 : 1,
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    {packBusy === "install"
                      ? <RefreshCw size={13} style={{ animation: "spin 1s linear infinite" }} />
                      : <Layers size={13} />}
                    Install Pack
                  </button>
                  <button
                    onClick={handleRemovePack}
                    disabled={running || packBusy !== null}
                    title={`Read .tp/pack-manifest.json and delete every file ${brand.shortName} wrote. Operator-authored files stay.`}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "9px 14px", borderRadius: 9,
                      border: "1px solid rgba(228,75,95,0.3)",
                      background: packBusy === "remove" ? "var(--surface0)" : "rgba(228,75,95,0.06)",
                      color: "var(--red)", fontSize: 13, fontWeight: 600,
                      cursor: (running || packBusy !== null) ? "not-allowed" : "pointer",
                      opacity: (running || packBusy !== null) ? 0.6 : 1,
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    {packBusy === "remove"
                      ? <RefreshCw size={13} style={{ animation: "spin 1s linear infinite" }} />
                      : <Trash2 size={13} />}
                    Remove Pack
                  </button>
                </>
              )}
              <button
                onClick={handleStart}
                disabled={running || packBusy !== null || stepModes.length === 0}
                title={stepModes.length === 0 ? "Project has no pipeline assigned — configure one in Project Settings → Pipeline." : undefined}
                style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                  padding: "9px", borderRadius: 9, border: "none",
                  background: stepModes.length === 0 ? "var(--surface1)" : "#1463ff",
                  color: stepModes.length === 0 ? "var(--overlay0)" : "#fff",
                  fontSize: 13, fontWeight: 700,
                  cursor: (running || packBusy !== null || stepModes.length === 0) ? "not-allowed" : "pointer",
                  opacity: running ? 0.7 : 1, fontFamily: "var(--font-sans)",
                }}
              >
                {running ? <><RefreshCw size={13} style={{ animation: "spin 1s linear infinite" }} /> Starting…</> : <><Play size={12} /> Start Sprint {sprintNum}</>}
              </button>
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
}
