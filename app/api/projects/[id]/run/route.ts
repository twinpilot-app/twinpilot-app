/**
 * POST /api/projects/[id]/run
 *
 * Creates a new sprint for the project and optionally triggers it via Trigger.dev.
 *
 * Body: { briefing?: string }
 *   briefing — optional override for this sprint (defaults to project.intake_brief)
 *
 * Trigger.dev integration:
 *   Set TRIGGER_DEV_SECRET_KEY / TRIGGER_PROD_SECRET_KEY (or legacy
 *   TRIGGER_SECRET_KEY) in .env to enable automatic run trigger.
 *   Without it, sprint is created in "queued" status and you can start via CLI:
 *     factory from-scratch "..." --slug <project-slug>
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { dispatchSprint } from "@/lib/sprint-dispatcher";
import { resolveLocalBasePath } from "@/lib/storage-defaults";
import { evaluateModeAvailability } from "@/lib/mode-availability";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function getUser(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { user, sb };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId } = await params;
    let body = await req.json() as {
      planId?: string;
      briefing?: string;
      bypassGates?: boolean;
      provider?: string;
      model?: string;
      cliExecutionMode?: "cloud" | "local" | "local-git";
      contextSprintIds?: string[];
      contextCategories?: ("specs" | "docs")[];
      startFromStep?: number;
      agentInstructions?: Record<string, { text: string; override: boolean }>;
      stepRoutingOverrides?: Record<string, unknown>;
      runNote?: string;
      backlogItemIds?: string[];
      /** Optional dispatch attribution. Defaults to 'manual'. CLI clients
       * pass 'cli'; programmatic API integrations pass 'api'. UI omits. */
      triggerSource?: "manual" | "cli" | "api" | "webhook";
      /** Optional intent override. When omitted: derived by the heuristic
       * (when project.heuristic_intent is true) or defaults to execution.
       * Operators can force a specific intent regardless of items. */
      intent?: "discovery" | "planning" | "execution" | "review";
      /** When intent='planning', narrows what PO does. */
      planningSubmode?: "initiation" | "grooming" | "sprint-backlog";
      /** Per-sprint auto-close override. When omitted falls back to project
       * settings.auto_close_sprints, then defaults to true. true: sprint
       * auto-promotes to completed on success and stamps auto_acknowledged
       * on failure (no operator action needed). false: pending_save / failed
       * stay open for the operator's save/discard or finalize decision. */
      autoClose?: boolean;
    };

    // ── Plan-driven dispatch ─────────────────────────────────────────────────
    // If a planId is supplied, the reviewed plan is authoritative — it was
    // composed, persisted, and confirmed by the operator on the preview page.
    // Hydrate the body from the plan's stored overrides so the run matches
    // what was reviewed. We reject plans that were already dispatched
    // (dispatched_at IS NOT NULL) to avoid an accidental re-run on the same
    // reviewed snapshot.
    let activePlanId: string | null = null;
    if (body.planId) {
      const { data: planRow, error: planErr } = await sb
        .from("sprint_plans")
        .select("id, plan, dispatched_at, project_id")
        .eq("id", body.planId)
        .maybeSingle();
      if (planErr || !planRow)                    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      if (planRow.project_id !== projectId)       return NextResponse.json({ error: "Plan belongs to a different project" }, { status: 400 });
      if (planRow.dispatched_at)                  return NextResponse.json({ error: "This plan was already dispatched. Compose a new plan to run again." }, { status: 409 });

      const plan = planRow.plan as Record<string, unknown>;
      const planSprint       = (plan.sprint      as Record<string, unknown>) ?? {};
      const planExec         = (plan.execution   as Record<string, unknown>) ?? {};
      const planOverrides    = (plan.sprintOverrides as Record<string, unknown>) ?? {};
      const planStepRouting  = (planOverrides.stepRoutingOverrides as Record<string, {
        cli?:       string;
        model?:     string;
        mode?:      string;
        effort?:    "low" | "medium" | "high" | "max";
        planMode?:  boolean;
        budgetUsd?: number;
      }>) ?? {};

      // Reconstruct the { stepRoutingOverrides: { "N": { cliOverride: {...} } } }
      // shape the dispatcher expects from the flattened plan representation.
      const rehydratedRouting: Record<string, { cliOverride: {
        enabled:    boolean;
        cli?:       string;
        model?:     string;
        authMode?:  "api-key" | "oauth";
        effort?:    "low" | "medium" | "high" | "max";
        planMode?:  boolean;
        budgetUsd?: number;
      } }> = {};
      for (const [stepKey, r] of Object.entries(planStepRouting)) {
        if (!r.cli) continue;
        rehydratedRouting[stepKey] = {
          cliOverride: {
            enabled: true,
            cli:     r.cli,
            ...(r.model ? { model: r.model } : {}),
            ...(r.mode === "cli-subs" ? { authMode: "oauth" as const }
              : r.mode === "cli-api"  ? { authMode: "api-key" as const }
              : {}),
            ...(r.effort               ? { effort:    r.effort    } : {}),
            ...(r.planMode             ? { planMode:  r.planMode  } : {}),
            ...(r.budgetUsd !== undefined ? { budgetUsd: r.budgetUsd } : {}),
          },
        };
      }

      body = {
        planId:              body.planId,
        briefing:            planSprint.originalBriefing as string | undefined,
        runNote:             planSprint.runNote as string | undefined,
        bypassGates:         planExec.bypassGates as boolean | undefined,
        provider:            planOverrides.provider as string | undefined,
        model:               planOverrides.model as string | undefined,
        // Plan stores the resolved orchestration mode (cloud/local/local-git);
        // fall back to deriving from backend for older plans that pre-date
        // the local-git rollout.
        cliExecutionMode:
          (planExec.mode as "cloud" | "local" | "local-git" | undefined)
          ?? (planExec.backend === "local" ? "local" : "cloud"),
        contextSprintIds:    planOverrides.contextSprintIds as string[] | undefined,
        contextCategories:   planOverrides.contextCategories as ("specs" | "docs")[] | undefined,
        startFromStep:       planExec.startFromStep as number | undefined,
        agentInstructions:   planOverrides.agentInstructions as Record<string, { text: string; override: boolean }> | undefined,
        stepRoutingOverrides: Object.keys(rehydratedRouting).length ? rehydratedRouting : undefined,
      };
      activePlanId = planRow.id as string;
    }

    // ── Load project ──────────────────────────────────────────────────────────
    const { data: project, error: projErr } = await sb
      .from("projects")
      .select("id, name, slug, status, archived_at, factory_id, pipeline, intake_brief, prd_md, pipeline_id, discovery_pipeline_id, planning_pipeline_id, execution_pipeline_id, review_pipeline_id, heuristic_intent, sprint_count, mode, repo_url, working_destination_id, use_operator_git_auth, settings")
      .eq("id", projectId)
      .single();

    if (projErr || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    // ── Verify membership ─────────────────────────────────────────────────────
    const { data: factory } = await sb
      .from("factories").select("tenant_id, slug").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    // Resolve tenant slug for unified path convention
    const { data: tenantRow } = await sb.from("tenants").select("slug").eq("id", factory.tenant_id).single();

    const { data: member } = await sb
      .from("tenant_members").select("role").eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Guard: active sprint blocks new sprints ──────────────────────────────
    const projectStatus = project.status as string;
    if (projectStatus === "running") {
      return NextResponse.json({ error: "Project already has an active sprint running. Wait for it to complete or pause first." }, { status: 409 });
    }
    if (projectStatus === "locked") {
      const reason = project.archived_at
        ? "Project is archived — unarchive it from Studio to start a sprint."
        : "Project is locked — assign a pipeline in Project Settings → Pipeline (or unlock) before starting a sprint.";
      return NextResponse.json({ error: reason }, { status: 409 });
    }
    // Pending-save lives on the sprint row now. Refuse if any sprint is
    // still in pending_save so the operator pushes/discards first.
    const { data: pendingSprint } = await sb
      .from("sprints")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "pending_save")
      .limit(1)
      .maybeSingle();
    if (pendingSprint) {
      return NextResponse.json({ error: "Sprint is pending save — push to GitHub, download, or discard before starting a new sprint." }, { status: 409 });
    }

    // ── Mode-specific required fields (per docs/STORAGE-LAYOUT.md) ──────────
    // local-git uses the working repo as the auto-push target — must point
    // to one of the factory's curated destinations (or have legacy repo_url
    // and use_operator_git_auth=true so the operator handles auth their own
    // way). Reject cleanly here so the failure surfaces in the dispatch
    // path, not deep in the worker.
    const projectSettingsForValidation = (project.settings ?? {}) as { cli_agents?: { orchestration_mode?: string } };
    const orchModeForValidation = projectSettingsForValidation.cli_agents?.orchestration_mode;
    const workingDestinationId   = (project.working_destination_id as string | null | undefined) ?? null;
    const useOperatorGitAuth     = (project.use_operator_git_auth as boolean | undefined) === true;
    const legacyRepoUrl          = (project.repo_url as string | null | undefined)?.trim() || null;

    if (orchModeForValidation === "local-git") {
      if (!workingDestinationId && !(useOperatorGitAuth && legacyRepoUrl)) {
        return NextResponse.json(
          { error: "Local + Git mode requires a working repository. In Project Settings → Working location, pick one of the factory's destinations, or check 'Use my own git credentials' and keep the legacy Repository URL." },
          { status: 422 },
        );
      }
    }

    // Resolve the working repo URL + auth metadata. When working_destination_id
    // is set, derive https://github.com/{owner}/{slug} and capture the PAT for
    // ephemeral injection at push time. When use_operator_git_auth is true,
    // skip the PAT — operator's git config does auth.
    let resolvedRepoUrl:        string | null = legacyRepoUrl;
    let workingDestinationToken: string | null = null;
    if (workingDestinationId) {
      const { data: dest } = await sb
        .from("factory_output_destinations")
        .select("id, owner, name, token, branch")
        .eq("id", workingDestinationId)
        .eq("tenant_id", factory.tenant_id)
        .single();
      if (!dest) {
        return NextResponse.json(
          { error: "Working destination no longer exists or belongs to a different factory. Re-pick one in Project Settings → Working location." },
          { status: 422 },
        );
      }
      resolvedRepoUrl = `https://github.com/${dest.owner}/${project.slug}`;
      if (!useOperatorGitAuth) workingDestinationToken = dest.token as string;
    }

    // ── Derive sprint intent + resolve pipeline ─────────────────────────────
    // Intent priority (migration 169 — four-intent rollout):
    //   1. Explicit body.intent              — UI / API caller stated their goal
    //   2. body.backlogItemIds.length>0      — operator picked items: execution
    //   3. project.heuristic_intent === true — infer from project state
    //   4. Default                           — execution (with backlog auto-pick)
    //
    // Heuristic uses, in order: briefing without PRD → discovery; PRD without
    // kanban items → planning(initiation); kanban with todo items →
    // execution; kanban with non-todo items only → planning(grooming).
    let derivedBacklogItemId: string | null = null;
    let requestedIntent: "discovery" | "planning" | "execution" | "review";
    let derivedPlanningSubmode: "initiation" | "grooming" | "sprint-backlog" | undefined;
    let intentPromotedReason: string | null = null;

    if (body.intent) {
      requestedIntent = body.intent;
      derivedPlanningSubmode = body.planningSubmode;
    } else if (Array.isArray(body.backlogItemIds) && body.backlogItemIds.length > 0) {
      requestedIntent = "execution";
    } else {
      // Inspect kanban once — used by both heuristic and the legacy fallback.
      const { data: nextTodo } = await sb
        .from("project_backlog_items")
        .select("id")
        .eq("project_id", projectId)
        .eq("status", "todo")
        .order("order_index", { ascending: true })
        .limit(1)
        .maybeSingle();
      const { count: anyItemCount } = await sb
        .from("project_backlog_items")
        .select("id", { count: "exact", head: true })
        .eq("project_id", projectId);
      const briefingLen = ((project.intake_brief as string | null) ?? "").trim().length;
      const prdLen      = ((project.prd_md       as string | null) ?? "").trim().length;
      const hasDiscoveryPipeline = Boolean(project.discovery_pipeline_id);

      if (project.heuristic_intent === true) {
        // Autonomous-mode heuristic. Picks the most-fitting intent based on
        // what the project has and lacks.
        if (nextTodo?.id) {
          requestedIntent = "execution";
          derivedBacklogItemId = nextTodo.id as string;
          intentPromotedReason = "heuristic: kanban has a ready item";
        } else if ((anyItemCount ?? 0) > 0) {
          // Items exist but none in 'todo' — they need grooming or sprint-pick.
          requestedIntent = "planning";
          derivedPlanningSubmode = "grooming";
          intentPromotedReason = "heuristic: kanban items present but none ready";
        } else if (prdLen >= 80) {
          // PRD exists, kanban empty — populate it.
          requestedIntent = "planning";
          derivedPlanningSubmode = "initiation";
          intentPromotedReason = "heuristic: PRD ready, kanban empty";
        } else if (briefingLen >= 80 && hasDiscoveryPipeline) {
          requestedIntent = "discovery";
          intentPromotedReason = "heuristic: briefing present, no PRD yet";
        } else {
          requestedIntent = "execution";
          intentPromotedReason = "heuristic: nothing to plan, falling through to execution (briefing-per-sprint)";
        }
      } else if (nextTodo?.id) {
        // Heuristic off — replicate the legacy execution-when-kanban-has-todo
        // behaviour so existing manual+kanban projects keep working.
        requestedIntent = "execution";
        derivedBacklogItemId = nextTodo.id as string;
      } else {
        // Empty backlog, no operator-typed item selection, heuristic off.
        // Same legacy fallback: when there's no discovery pipeline AND a
        // briefing/PRD exists, run as execution (briefing-per-sprint).
        const hasOperatorTask = Boolean(
          (body.briefing?.trim()) ||
          (project.intake_brief as string | null)?.trim() ||
          (project.prd_md as string | null)?.trim(),
        );
        if (!hasDiscoveryPipeline && hasOperatorTask) {
          requestedIntent = "execution";
          intentPromotedReason = "no discovery pipeline configured; using briefing/intake/PRD as the execution task";
        } else {
          requestedIntent = "discovery";
        }
      }
    }

    // ── Discovery input gate (Slice 0) ───────────────────────────────────
    // Discovery sprints need at least one signal of operator intent —
    // empty briefing + empty PRD + no repo to adopt = nothing to chew on.
    // Block dispatch with a clear error. Execution sprints always have
    // backlog items as their input, so they don't need this gate.
    if (requestedIntent === "discovery") {
      const briefingLen = (project.intake_brief as string | null ?? "").trim().length;
      const prdLen      = (project.prd_md       as string | null ?? "").trim().length;
      const isAdopt     = project.mode === "adopt";
      const hasRepo     = Boolean((project.repo_url as string | null ?? "").trim() ||
                                 project.working_destination_id);
      // Threshold: 80 chars is "a real sentence". Single word like "test"
      // shouldn't pass — agents would still produce no_change.
      const hasInput =
        briefingLen >= 80 ||
        prdLen      >= 80 ||
        (isAdopt && hasRepo);
      if (!hasInput) {
        return NextResponse.json({
          error: "Discovery cannot run without input. Provide at least one of: " +
                 "(1) a briefing (≥80 chars) in Project Settings → Briefing, " +
                 "(2) a PRD (≥80 chars) in Project Settings → PRD, or " +
                 "(3) a repository URL with mode='adopt'. Use the guided template button to seed a briefing.",
          code: "DISCOVERY_INPUT_REQUIRED",
          hint: {
            briefing_len: briefingLen,
            prd_len:      prdLen,
            mode:         project.mode,
            has_repo:     hasRepo,
          },
        }, { status: 422 });
      }
    }

    // Pipeline resolution per intent. Migration 169 added planning + review
    // pipeline slots; the project may have:
    //   - an explicit per-intent pipeline (discovery/planning/execution/review_pipeline_id), OR
    //   - a single legacy pipeline_id (default) used as fallback,
    //   - or just project.pipeline (denormalised steps array).
    // We pick the intent-specific pipeline when present, else fall back to
    // the project's legacy single pipeline. The fallback keeps every existing
    // project working without forcing the operator to migrate.
    const intentPipelineId: string | null | undefined =
      requestedIntent === "discovery" ? (project.discovery_pipeline_id as string | null | undefined)
      : requestedIntent === "planning" ? (project.planning_pipeline_id  as string | null | undefined)
      : requestedIntent === "review"   ? (project.review_pipeline_id    as string | null | undefined)
      :                                  (project.execution_pipeline_id as string | null | undefined);

    let steps: unknown[];
    let resolvedPipelineId: string | null = (project.pipeline_id as string | null) ?? null;
    if (intentPipelineId && intentPipelineId !== project.pipeline_id) {
      const { data: intentPl } = await sb
        .from("pipelines")
        .select("id, steps, tenant_id")
        .eq("id", intentPipelineId)
        .maybeSingle();
      if (intentPl?.steps) {
        // Migration 171 — when the intent pipeline points at a canonical
        // (tenant_id IS NULL), require the tenant to have an active
        // marketplace_installs ref. UI already prevents picking
        // unadopted canonicals, but defense-in-depth: catches stale
        // saves, direct API callers, and sprint resumes after the ref
        // was uninstalled.
        if (intentPl.tenant_id === null) {
          const { data: ref } = await sb
            .from("marketplace_installs")
            .select("id, listing_id")
            .eq("tenant_id", factory.tenant_id)
            .eq("kind", "pipeline")
            .eq("source_id", intentPl.id as string)
            .maybeSingle();
          if (!ref) {
            return NextResponse.json({
              error: "This canonical pipeline is no longer installed by your tenant. Install it in the marketplace, or pick a different pipeline in Project Settings.",
              code:  "PIPELINE_REF_MISSING",
              hint:  { pipeline_id: intentPl.id, intent: requestedIntent },
            }, { status: 403 });
          }
        }
        steps = intentPl.steps as unknown[];
        resolvedPipelineId = intentPl.id as string;
      } else {
        // Configured intent pipeline disappeared (deleted, RLS hide). Fall
        // back to the project's denormalised pipeline rather than 422'ing —
        // the operator gets a sprint and a warning instead of a wall.
        steps = (project.pipeline as unknown[]) ?? [];
      }
    } else {
      steps = (project.pipeline as unknown[]) ?? [];
    }

    if (steps.length === 0) {
      const intentLabel = requestedIntent.charAt(0).toUpperCase() + requestedIntent.slice(1);
      return NextResponse.json({
        error: `${intentLabel} sprint has no pipeline configured. Assign a ${requestedIntent} pipeline (or a default) in Project Settings → Pipelines.`,
        code:  "INTENT_PIPELINE_MISSING",
        hint:  { intent: requestedIntent, planningSubmode: derivedPlanningSubmode ?? null },
      }, { status: 422 });
    }

    let sprintNum           = (project.sprint_count as number ?? 0) + 1;
    const briefing          = body.briefing?.trim() || (project.intake_brief as string | null) || "";
    const bypassGates       = body.bypassGates ?? false;
    const provider          = body.provider?.trim() || undefined;
    const model             = body.model?.trim() || undefined;

    // ── Mode lock enforcement ────────────────────────────────────────────────
    // When the project's `allow_mode_switch` flag is unset/false the sprint
    // is locked to the project's stored backend — payload overrides are
    // ignored. Stops cross-backend artifact reads from breaking silently.
    const projSettingsForLock = (project.settings ?? {}) as Record<string, unknown>;
    const allowModeSwitch     = projSettingsForLock.allow_mode_switch === true;
    const lockedCliCfg        = (projSettingsForLock.cli_agents ?? {}) as {
      execution_backend?:  string;
      execution_mode?:     string;
      orchestration_mode?: "cloud" | "local" | "local-git";
    };
    // Tri-modal: orchestration_mode is the source of truth; fall back to
    // deriving from execution_backend for legacy rows that predate local-git.
    const projectMode: "cloud" | "local" | "local-git" | undefined =
      lockedCliCfg.orchestration_mode
      ?? (lockedCliCfg.execution_backend === "local" ? "local"
        : lockedCliCfg.execution_backend === "supabase" ? "cloud"
        : (lockedCliCfg.execution_mode as "cloud" | "local" | undefined));
    const cliExecutionMode  = allowModeSwitch
      ? (body.cliExecutionMode ?? undefined)
      : (projectMode ?? body.cliExecutionMode ?? undefined);
    const contextSprintIds   = body.contextSprintIds?.length ? body.contextSprintIds : undefined;
    const contextCategories  = body.contextCategories?.length ? body.contextCategories : undefined;
    const agentInstructions  = body.agentInstructions && Object.keys(body.agentInstructions).length > 0
      ? body.agentInstructions : undefined;
    const bodyStartFromStep = typeof body.startFromStep === "number" && body.startFromStep >= 1
      ? body.startFromStep : undefined;

    // ── Update project pipeline snapshot ──────────────────────────────────────
    await sb.from("projects").update({ pipeline: steps }).eq("id", projectId);

    // ── Reuse or create sprint record ────────────────────────────────────────
    // sprint_count is incremented by a DB trigger on INSERT into sprints.
    // To avoid inflating the count on every "Start" click, we reuse an
    // existing sprint that has not yet been tagged in GitHub (repo_tag IS NULL).
    const { data: activeSprint } = await sb
      .from("sprints")
      .select("id, sprint_num")
      .eq("project_id", projectId)
      .is("repo_tag", null)
      .not("status", "in", '("completed","failed","cancelled","pending_save")')
      .order("sprint_num", { ascending: false })
      .limit(1)
      .maybeSingle();

    let sprint: { id: string; sprint_num: number } | null = null;
    // When reusing an active sprint, resume from the step AFTER the last
    // completed agent run — so the init sprint-push (step 1) doesn't run again.
    let startFromStep: number | undefined;

    if (activeSprint) {
      // Reuse: reset status to "queued" and update briefing/steps
      const { data: updated, error: upErr } = await sb
        .from("sprints")
        .update({ status: "queued", briefing, steps })
        .eq("id", activeSprint.id)
        .select("id, sprint_num")
        .single();
      if (upErr || !updated) throw new Error(upErr?.message ?? "Failed to reset sprint");
      sprint = updated;
      sprintNum = sprint.sprint_num; // use the existing sprint number

      if (bodyStartFromStep !== undefined) {
        // User explicitly selected a resume step — honour it, but cap at pipeline length
        startFromStep = Math.min(bodyStartFromStep, steps.length);
      } else {
        // Auto-compute resume step: last done agent_run step + 1
        // Must filter by sprint_id so prior sprints' completed steps don't skew the result
        const { data: lastDone } = await sb
          .from("agent_runs")
          .select("step")
          .eq("project_id", projectId)
          .eq("sprint_id", activeSprint.id)
          .eq("status", "done")
          .order("step", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastDone?.step) {
          const nextStep = (lastDone.step as number) + 1;
          // Only set if there are still steps remaining. If all steps are done
          // (nextStep > steps.length), let the pipeline start fresh from step 1.
          if (nextStep <= steps.length) {
            startFromStep = nextStep;
          }
        }
      }
    } else {
      // Create new sprint — DB trigger will increment projects.sprint_count
      const base_ref = sprintNum === 1 ? "unversioned" : `sprint-${sprintNum - 1}`;
      const triggerSource = body.triggerSource ?? "manual";
      const { data: inserted, error: sprintErr } = await sb
        .from("sprints")
        .insert({
          project_id:        projectId,
          sprint_num:        sprintNum,
          pipeline_id:       resolvedPipelineId,
          steps,
          status:            "queued",
          briefing,
          base_ref,
          trigger_source:    triggerSource,
          intent:            requestedIntent,
          planning_submode:  derivedPlanningSubmode ?? null,
        })
        .select("id, sprint_num")
        .single();
      if (sprintErr || !inserted) throw new Error(sprintErr?.message ?? "Failed to create sprint");
      sprint = inserted;
    }

    if (!sprint) throw new Error("Sprint record unavailable");

    // ── Resolve localBasePath (project setting → tenant backend → homedir) ───
    // The same resolution lives in run-pipeline (worker side) and surfaces in
    // the Review Modal. resolveLocalBasePath always returns a path because of
    // the homedir fallback; the `source` tells us where it came from so we
    // can flag homedir to the operator.
    const projSettings = (project.settings ?? {}) as Record<string, unknown>;
    const projCli      = (projSettings.cli_agents ?? {}) as Record<string, unknown>;

    let tenantBackendLocalPath: string | undefined;
    {
      const { data: storageInts } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", factory.tenant_id)
        .eq("service_id", "storage");
      for (const row of storageInts ?? []) {
        try {
          const cfg = JSON.parse(row.secret_value as string) as { type?: string; basePath?: string };
          if (cfg.type === "local" && cfg.basePath) { tenantBackendLocalPath = cfg.basePath; break; }
        } catch { /* ignore */ }
      }
    }
    const resolvedPath = resolveLocalBasePath({
      projectPath:       projCli.local_base_path as string | undefined,
      tenantBackendPath: tenantBackendLocalPath,
    });
    const localBasePath = resolvedPath.path;

    // Pre-flight: refuse local / local-git when somehow nothing resolves
    // (homedir fallback should always provide a value; this guards corrupted
    // env where os.homedir() returns "").
    if ((cliExecutionMode === "local" || cliExecutionMode === "local-git") && !localBasePath) {
      return NextResponse.json({
        error:
          "Cannot start a local sprint: no base path could be resolved. " +
          "Configure storage in Settings → Storage, or set the project's CLI Agents base path.",
      }, { status: 422 });
    }

    // Mode-availability defense in depth — same matrix the UI uses to disable
    // unavailable mode buttons. Catches the case where an operator (or stale
    // tab) dispatches a mode that's no longer enabled.
    const effectiveMode = cliExecutionMode ?? projectMode ?? "cloud";
    const availability = await evaluateModeAvailability({
      sb,
      tenantId:    factory.tenant_id,
      factoryId:   project.factory_id as string,
      projectPath: projCli.local_base_path as string | undefined,
    });
    const evaluated = availability[effectiveMode];
    if (!evaluated.enabled) {
      return NextResponse.json({
        error: `Cannot run in "${effectiveMode}" mode: ${evaluated.reason ?? "this mode is unavailable for this project"}.`,
      }, { status: 422 });
    }

    // ── Validate + lock backlog items (todo → doing) ─────────────────────────
    // Operators select backlog items in the Start Sprint modal; we flip them
    // into 'doing' here so a concurrent run can't claim the same items, and
    // record sprint_id so the kanban can show "in this sprint". Any item
    // that's already non-todo (raced) is silently skipped — the operator
    // will see fewer items confirmed than they picked.
    //
    // Smart-fallback derivation (above) may have picked a todo item when
    // the caller didn't pass any — fold it in here so the sprint is properly
    // linked to that item even though the operator didn't explicitly select it.
    const backlogIds = Array.isArray(body.backlogItemIds)
      ? body.backlogItemIds.filter((s) => typeof s === "string")
      : derivedBacklogItemId
        ? [derivedBacklogItemId]
        : [];
    let lockedBacklogIds: string[] = [];
    if (backlogIds.length > 0) {
      const { data: locked } = await sb
        .from("project_backlog_items")
        .update({ status: "doing", sprint_id: sprint.id })
        .in("id", backlogIds)
        .eq("project_id", projectId)
        .eq("status", "todo")
        .select("id");
      lockedBacklogIds = (locked ?? []).map((r) => r.id as string);
    }

    // ── Save sprint runtime config (for next-sprint inheritance) ─────────────
    const sprintConfig = {
      mode:              cliExecutionMode ?? "cloud",
      provider:          provider ?? undefined,
      model:             model ?? undefined,
      bypassGates,
      localBasePath:     localBasePath ?? undefined,
      stepRouting:       body.stepRoutingOverrides ?? {},
      agentInstructions: agentInstructions ?? {},
      backlogItemIds:    lockedBacklogIds,
      // Auto-close gets persisted only when explicitly supplied — absence
      // falls back to projectSettings.auto_close_sprints in the worker.
      ...(typeof body.autoClose === "boolean" ? { auto_close: body.autoClose } : {}),
    };
    await sb.from("sprints").update({ config: sprintConfig }).eq("id", sprint.id);

    // ── Dispatch via shared helper ───────────────────────────────────────────
    const tenantSlug  = tenantRow?.slug as string | undefined;
    const factorySlugVal = factory.slug as string | undefined;

    // Dispatcher's TriggerExecutionMode is binary (cloud / local) — picks the
    // dev vs prod Trigger.dev secret. local-git collapses to local because
    // it runs on the operator's machine via the dev worker.
    const dispatchMode: "cloud" | "local" | undefined =
      cliExecutionMode === "local-git" ? "local"
      : (cliExecutionMode as "cloud" | "local" | undefined);

    const dispatch = await dispatchSprint({
      sb,
      projectId,
      factoryId: project.factory_id as string,
      tenantId: factory.tenant_id as string,
      projectSlug: project.slug as string,
      // The dispatcher uses sprintId to stamp failure_class on the
      // sprint row when the post-dispatch worker check fails. We still
      // delete the sprint below in the failure path, but the dispatcher
      // owns the stamp ordering so a future caller that wants to keep
      // the failed row visible (retry mode, audit trail) just stops
      // doing the delete.
      sprintId: sprint.id,
      cliExecutionMode: dispatchMode,
      payload: {
        signal:   briefing,
        sprintId: sprint.id,
        sprintNum,
        intent:   requestedIntent,
        ...(derivedPlanningSubmode ? { planningSubmode: derivedPlanningSubmode } : {}),
        ...(tenantSlug ? { tenantSlug } : {}),
        ...(factorySlugVal ? { factorySlug: factorySlugVal } : {}),
        ...(startFromStep !== undefined ? { startFromStep } : {}),
        ...(bypassGates ? { bypassGates: true } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(cliExecutionMode ? { cliExecutionMode } : {}),
        ...(contextSprintIds ? { contextSprintIds } : {}),
        ...(contextCategories ? { contextCategories } : {}),
        ...(agentInstructions ? { agentInstructions } : {}),
        ...(body.stepRoutingOverrides && Object.keys(body.stepRoutingOverrides).length > 0
          ? { stepRoutingOverrides: body.stepRoutingOverrides as Record<string, { cliOverride?: {
              enabled:    boolean;
              cli?:       string;
              model?:     string;
              authMode?:  string;
              effort?:    "low" | "medium" | "high" | "max";
              planMode?:  boolean;
              budgetUsd?: number;
            } }> }
          : {}),
        // Working repo wiring — derived above from working_destination_id.
        // Token is only forwarded when use_operator_git_auth is false; the
        // worker injects it ephemerally into the remote URL at push time.
        ...(resolvedRepoUrl ? { workingRepoUrl: resolvedRepoUrl } : {}),
        ...(workingDestinationToken ? { workingRepoToken: workingDestinationToken } : {}),
        ...(useOperatorGitAuth ? { useOperatorGitAuth: true } : {}),
      },
    });

    if (!dispatch.ok) {
      // Roll back the sprint row so sprint_count does not drift.
      await sb.from("sprints").delete().eq("id", sprint.id);
      if (!activeSprint) {
        await sb.from("projects")
          .update({ sprint_count: project.sprint_count as number ?? 0 })
          .eq("id", projectId);
      }

      if (dispatch.reason === "no-key") {
        return NextResponse.json({
          triggered:   false,
          cli_command: `factory from-scratch "${briefing.slice(0, 80)}" --slug ${project.slug as string}`,
        }, { status: 200 });
      }

      if (dispatch.reason === "no-slot") {
        return NextResponse.json(
          { error: "Factory is at its concurrent project limit. Raise max_concurrent_projects or wait for a running sprint to finish." },
          { status: 429, headers: { "Retry-After": "30" } },
        );
      }

      if (dispatch.reason === "project-busy") {
        return NextResponse.json({ error: "Project already has a sprint running. Wait for it to complete or pause first." }, { status: 409 });
      }

      if (dispatch.reason === "trigger-rejected") {
        return NextResponse.json(
          { error: `Trigger.dev rejected the run: ${dispatch.detail ?? ""}` },
          { status: 502 },
        );
      }

      if (dispatch.reason === "no-worker") {
        // Local Trigger.dev worker isn't running. 503 + a clear hint —
        // the operator just needs to start `tp workers dev` and retry.
        return NextResponse.json(
          { error: dispatch.detail ?? "Local Trigger.dev worker is not running. Start it with `tp workers dev` and retry." },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      }

      return NextResponse.json(
        { error: dispatch.detail ?? `Dispatch failed: ${dispatch.reason}` },
        { status: 500 },
      );
    }

    if (dispatch.triggerRunId) {
      await sb.from("sprints")
        .update({ trigger_run_id: dispatch.triggerRunId, status: "running" })
        .eq("id", sprint.id);
    }

    // Bind the reviewed plan to its sprint so `sprint_plans.dispatched_at`
    // reflects the moment of dispatch and `sprint_id` lets the preview page
    // reopen the exact plan a sprint was run from.
    if (activePlanId) {
      await sb
        .from("sprint_plans")
        .update({ dispatched_at: new Date().toISOString(), sprint_id: sprint.id })
        .eq("id", activePlanId);
    }

    return NextResponse.json({
      sprint,
      trigger_run_id: dispatch.triggerRunId,
      triggered:      true,
      intent:         requestedIntent,
      intent_promoted_reason: intentPromotedReason,
    }, { status: 201 });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
