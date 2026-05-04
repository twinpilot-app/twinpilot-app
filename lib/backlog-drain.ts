/**
 * Backlog auto-drain — single-project attempt helper, shared between the
 * cron endpoint (POST /api/cron/backlog-auto-drain) and the per-project
 * "Run next" endpoint (POST /api/projects/[id]/auto-drain/run-next).
 *
 * Both consumers do the SAME eligibility checks for a given project and
 * dispatch the next backlog item; the only difference is the outer auth
 * gate (cron secret vs tenant member) and the scan loop (cron iterates
 * over all projects, the per-project endpoint runs against one).
 *
 * Keeping this single source of truth ensures the two paths can never
 * disagree about, e.g., what counts as "halted" or how the cooldown
 * timer is enforced.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchSprint } from "@/lib/sprint-dispatcher";
import { resolveLocalBasePath } from "@/lib/storage-defaults";
import type { SprintIntent } from "@/lib/types";

export interface DrainAttemptResult {
  projectId:     string;
  status:        "dispatched" | "skipped" | "error";
  reason?:       string;
  sprintNum?:    number;
  triggerRunId?: string | null;
  backlogItemId?: string;
  /** For dispatched: intent of the new sprint. For skipped: intent of the last sprint
   *  the gate inspected (helps explain why we skipped). */
  intent?:       SprintIntent;
}

/**
 * Run one drain attempt for a single project. The caller passes the
 * already-loaded project row (from the projects table; must include
 * `id, name, slug, factory_id, pipeline, intake_brief, pipeline_id,
 * sprint_count, settings`).
 *
 * Returns one of three statuses: `dispatched` (sprint created + sent
 * to Trigger.dev), `skipped` (eligibility rule kicked in — see reason),
 * `error` (something failed mid-flow).
 */
export async function attemptDrainOne(
  sb: SupabaseClient,
  project: Record<string, unknown>,
): Promise<DrainAttemptResult> {
  const projectId = project.id as string;

  // ── Graceful pause check ──────────────────────────────────────────
  const pauseRequested = (project.settings as { auto_drain_pause_requested?: boolean } | null | undefined)
    ?.auto_drain_pause_requested === true;
  if (pauseRequested) {
    return { projectId, status: "skipped", reason: "paused by operator" };
  }

  // ── Per-sprint approval gate ─────────────────────────────────────
  // When auto_drain_approval_required is on, the worker flags the
  // project as awaiting approval after every sprint completion. The
  // dispatcher skips until the operator approves, which clears the
  // flag. Independent from auto_drain_pause_requested so the operator
  // can tell "I paused this" from "the system is waiting for me".
  const awaitingApproval = (project.settings as { auto_drain_awaiting_approval?: boolean } | null | undefined)
    ?.auto_drain_awaiting_approval === true;
  if (awaitingApproval) {
    return { projectId, status: "skipped", reason: "awaiting human approval of last sprint" };
  }

  // ── Pre-flight: last sprint must be 'completed' or 'pending_save' ─
  const { data: lastSprint } = await sb
    .from("sprints")
    .select("status, sprint_num, completed_at, intent")
    .eq("project_id", projectId)
    .order("sprint_num", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastSprint) {
    const lastStatus = lastSprint.status as string;
    const proceedable = lastStatus === "completed" || lastStatus === "pending_save";
    if (!proceedable) {
      if (lastStatus === "failed" || lastStatus === "cancelled") {
        await emitAutoDrainHaltedNotification(sb, project, lastSprint);
      }
      return {
        projectId,
        status: "skipped",
        reason: `last sprint #${lastSprint.sprint_num} is "${lastStatus}" — auto-drain halts on non-completed sprints`,
      };
    }

    // Cooldown: minimum minutes since last sprint's completed_at.
    const projSettingsForCooldown = (project.settings ?? {}) as { backlog_auto_drain_cooldown_minutes?: number };
    const cooldownMin = projSettingsForCooldown.backlog_auto_drain_cooldown_minutes;
    const completedAt = lastSprint.completed_at as string | null;
    if (typeof cooldownMin === "number" && cooldownMin > 0 && completedAt) {
      const elapsedMs = Date.now() - new Date(completedAt).getTime();
      const cooldownMs = cooldownMin * 60_000;
      if (elapsedMs < cooldownMs) {
        const remainingMin = Math.ceil((cooldownMs - elapsedMs) / 60_000);
        return {
          projectId,
          status: "skipped",
          reason: `cooldown — ${remainingMin}min remaining of ${cooldownMin}min between sprints`,
        };
      }
    }
  }

  // ── Daily sprint cap ─────────────────────────────────────────────
  const projSettingsForCap = (project.settings ?? {}) as { auto_drain_daily_sprint_cap?: number };
  const dailyCap = projSettingsForCap.auto_drain_daily_sprint_cap;
  if (typeof dailyCap === "number" && dailyCap > 0) {
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: dailyCount } = await sb
      .from("sprints")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .gte("created_at", windowStart);
    if ((dailyCount ?? 0) >= dailyCap) {
      return {
        projectId,
        status: "skipped",
        reason: `daily cap reached — ${dailyCount}/${dailyCap} sprints in last 24h`,
      };
    }
  }

  // ── Budget brake (opt-in soft circuit-breaker) ───────────────────
  // Disabled by default. When enabled with action='halt', the dispatcher
  // skips until the next billing window. Operator-side hard limits still
  // belong at the provider's console — this is just a safety net.
  const budgetCfg = (project.budget ?? null) as import("./budget").BudgetConfig | null;
  if (budgetCfg?.enabled === true) {
    const { computeBudgetStatus } = await import("./budget");
    const budgetStatus = await computeBudgetStatus(sb, projectId, budgetCfg);
    if (budgetStatus.status === "halt") {
      return {
        projectId,
        status: "skipped",
        reason: `budget brake — ${budgetStatus.reason ?? "cap exceeded"}`,
      };
    }
  }

  // ── Active window check ──────────────────────────────────────────
  const projSettingsForWindow = (project.settings ?? {}) as {
    auto_drain_active_window?: { start_hour?: number; end_hour?: number; timezone?: string };
  };
  const win = projSettingsForWindow.auto_drain_active_window;
  if (win && typeof win.start_hour === "number" && typeof win.end_hour === "number") {
    const tz = win.timezone || "UTC";
    let currentHour: number;
    try {
      const fmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: tz });
      currentHour = parseInt(fmt.format(new Date()), 10);
    } catch {
      console.warn(`[auto-drain] invalid timezone "${tz}" for project ${projectId}, ignoring window`);
      currentHour = -1;
    }
    if (currentHour >= 0) {
      const inWindow = win.start_hour <= win.end_hour
        ? currentHour >= win.start_hour && currentHour < win.end_hour
        : currentHour >= win.start_hour || currentHour < win.end_hour;
      if (!inWindow) {
        return {
          projectId,
          status: "skipped",
          reason: `outside active window (${win.start_hour}-${win.end_hour} ${tz}) — current hour ${currentHour}`,
        };
      }
    }
  }

  // ── Unproductive-loop guard (local-git only) ─────────────────────
  const projSettingsForHealth = (project.settings ?? {}) as {
    auto_drain_unproductive_threshold?: number;
    cli_agents?: { orchestration_mode?: string };
  };
  const unproductiveThreshold = projSettingsForHealth.auto_drain_unproductive_threshold;
  const isLocalGit = projSettingsForHealth.cli_agents?.orchestration_mode === "local-git";
  if (isLocalGit && typeof unproductiveThreshold === "number" && unproductiveThreshold > 0) {
    const { data: recent } = await sb
      .from("sprints")
      .select("repo_tag, sprint_num")
      .eq("project_id", projectId)
      .order("sprint_num", { ascending: false })
      .limit(unproductiveThreshold);
    const recentRows = recent ?? [];
    const allUnproductive = recentRows.length >= unproductiveThreshold &&
      recentRows.every((s) => !s.repo_tag);
    if (allUnproductive) {
      await emitAutoDrainUnproductiveNotification(sb, project, recentRows.length);
      return {
        projectId,
        status: "skipped",
        reason: `unproductive — last ${unproductiveThreshold} sprints produced no commit`,
      };
    }
  }

  // ── Pull next todo item (decides intent path below) ──────────────
  const { data: nextItem } = await sb
    .from("project_backlog_items")
    .select("id, title")
    .eq("project_id", projectId)
    .eq("status", "todo")
    .order("order_index", { ascending: true })
    .limit(1)
    .maybeSingle();

  // ── Decide intent based on backlog state + on-empty policy ──────
  // Three modes (settings.auto_drain_on_empty):
  //   halt                — never auto-discover. Drained → notify + skip.
  //   discover_once       — when backlog empties, dispatch 1 discovery
  //                          sprint. If that produces no items, next
  //                          tick halts (so the loop doesn't burn LLM
  //                          on repeatedly empty discoveries).
  //   discover_continuous — always discover when backlog is empty. Pace
  //                          is controlled by cooldown + daily cap.
  // Default when unset:
  //   - has discovery_pipeline_id → discover_once
  //   - no discovery pipeline      → halt
  const hasTodoItem = !!nextItem;
  const projAny = project as { discovery_pipeline_id?: string | null };
  const lastWasDiscovery = (lastSprint?.intent as string | null | undefined) === "discovery";
  const hasDiscoveryPipeline = !!projAny.discovery_pipeline_id;

  const onEmptyRaw = (project.settings as { auto_drain_on_empty?: string } | null | undefined)?.auto_drain_on_empty;
  const onEmpty: "halt" | "discover_once" | "discover_continuous" =
    onEmptyRaw === "discover_once" || onEmptyRaw === "discover_continuous" || onEmptyRaw === "halt"
      ? onEmptyRaw
      : (hasDiscoveryPipeline ? "discover_once" : "halt");

  // Decide whether to dispatch a discovery sprint when there's no todo.
  let canDiscover = false;
  let haltReason: string | null = null;
  if (!hasTodoItem) {
    if (onEmpty === "halt") {
      haltReason = "backlog empty";
    } else if (!hasDiscoveryPipeline) {
      // Configured for discovery but no pipeline to run it — fail open
      // with a clear reason, don't pretend it's working.
      haltReason = "backlog empty — discovery requested but no discovery pipeline configured";
    } else if (onEmpty === "discover_once" && lastWasDiscovery) {
      haltReason = "backlog empty after discovery — operator review needed";
    } else {
      canDiscover = true;
    }
  }

  // Periodic discovery cadence (cli_agents.discovery_interval_sprints):
  // even when the backlog has todos, force a discovery every N execution
  // sprints since the last discovery. Lets the PO refresh the kanban
  // without operators having to drain it. Default null = never periodic.
  const cliCfg = (project.settings as { cli_agents?: { discovery_interval_sprints?: number } } | null | undefined)?.cli_agents;
  const discoveryInterval = cliCfg?.discovery_interval_sprints;
  let forceDiscoveryByCadence = false;
  if (hasTodoItem && hasDiscoveryPipeline && typeof discoveryInterval === "number" && discoveryInterval > 0) {
    // Count execution sprints since the most recent discovery (or all sprints
    // if there hasn't been one). When >= interval, fire discovery.
    const { data: recentSprints } = await sb
      .from("sprints")
      .select("intent, sprint_num")
      .eq("project_id", projectId)
      .order("sprint_num", { ascending: false })
      .limit(Math.max(discoveryInterval + 5, 10));
    let executionStreak = 0;
    for (const s of recentSprints ?? []) {
      if (s.intent === "discovery") break;
      if (s.intent === "execution") executionStreak++;
    }
    if (executionStreak >= discoveryInterval) {
      forceDiscoveryByCadence = true;
    }
  }

  const sprintIntent: SprintIntent =
    forceDiscoveryByCadence ? "discovery"
    : hasTodoItem ? "execution"
    : "discovery";

  if (!hasTodoItem && !canDiscover) {
    await emitAutoDrainDrainedNotification(sb, project);
    return {
      projectId,
      status: "skipped",
      reason: haltReason ?? "backlog empty",
      ...(lastSprint?.intent ? { intent: lastSprint.intent as SprintIntent } : {}),
    };
  }

  // ── Resolve the pipeline for this intent ─────────────────────────
  // Symmetric resolution per intent:
  //   discovery → discovery_pipeline_id's steps
  //   execution → execution_pipeline_id's steps
  //   either   → fall back to project.pipeline_id, then project.pipeline JSONB
  // The fallback chain keeps existing single-pipeline projects working
  // without forcing a migration; new projects with both intent pipelines
  // configured get the right one each time.
  const projWithExec = project as { execution_pipeline_id?: string | null };
  const intentPipelineId = sprintIntent === "discovery"
    ? (projAny.discovery_pipeline_id ?? null)
    : (projWithExec.execution_pipeline_id ?? null);
  let steps: unknown[] = [];
  let resolvedPipelineId: string | null = (project.pipeline_id as string | null) ?? null;
  if (intentPipelineId) {
    const { data: pl } = await sb
      .from("pipelines")
      .select("id, steps")
      .eq("id", intentPipelineId)
      .maybeSingle();
    if (pl?.steps) {
      steps = pl.steps as unknown[];
      resolvedPipelineId = pl.id as string;
    } else {
      steps = (project.pipeline as unknown[]) ?? [];
    }
  } else {
    steps = (project.pipeline as unknown[]) ?? [];
  }
  if (steps.length === 0) {
    return { projectId, status: "skipped", reason: "no pipeline steps configured" };
  }

  // ── Resolve factory + tenant context ──────────────────────────────
  const factoryId = project.factory_id as string;
  const { data: factory } = await sb
    .from("factories")
    .select("tenant_id, slug")
    .eq("id", factoryId)
    .single();
  if (!factory) {
    return { projectId, status: "error", reason: "factory not found" };
  }
  const tenantId = factory.tenant_id as string;
  const { data: tenantRow } = await sb.from("tenants").select("slug").eq("id", tenantId).single();

  // ── Resolve locked mode ──────────────────────────────────────────
  const projSettings = (project.settings ?? {}) as Record<string, unknown>;
  const projCli      = (projSettings.cli_agents ?? {}) as Record<string, unknown>;
  const lockedMode: "cloud" | "local" | "local-git" =
    (projCli.orchestration_mode as "cloud" | "local" | "local-git" | undefined)
    ?? (projCli.execution_backend === "local" ? "local"
      : projCli.execution_backend === "supabase" ? "cloud"
      : (projCli.execution_mode as "cloud" | "local" | undefined))
    ?? "cloud";
  const dispatchMode: "cloud" | "local" = lockedMode === "local-git" ? "local" : lockedMode;

  // ── Resolve localBasePath ────────────────────────────────────────
  let tenantBackendLocalPath: string | undefined;
  {
    const { data: storageInts } = await sb
      .from("tenant_integrations")
      .select("secret_value")
      .eq("tenant_id", tenantId)
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

  // ── Create sprint row ─────────────────────────────────────────────
  const sprintNum = (project.sprint_count as number ?? 0) + 1;
  const baseRef = sprintNum === 1 ? "unversioned" : `sprint-${sprintNum - 1}`;
  const briefing = (project.intake_brief as string | null) ?? "";

  // Auto-drain dispatches both execution sprints (drains a pre-defined
  // backlog) AND discovery sprints (fall-through when backlog is empty
  // and the project has a discovery pipeline configured). The sprint's
  // intent is stamped here so the worker + summary know which mode the
  // agents are running in.
  const { data: sprint, error: sprintErr } = await sb
    .from("sprints")
    .insert({
      project_id:     projectId,
      sprint_num:     sprintNum,
      pipeline_id:    resolvedPipelineId,
      steps,
      status:         "queued",
      briefing,
      base_ref:       baseRef,
      trigger_source: "auto_drain",
      intent:         sprintIntent,
    })
    .select("id, sprint_num")
    .single();

  if (sprintErr || !sprint) {
    return { projectId, status: "error", reason: `sprint insert failed: ${sprintErr?.message ?? "no row returned"}` };
  }

  // ── Lock the backlog item (execution sprints only) ───────────────
  // Discovery sprints don't lock anything — there's no pre-defined
  // task; agents will produce backlog items / specs as their output.
  let itemId: string | null = null;
  let lockedIds: string[] = [];
  if (sprintIntent === "execution" && nextItem) {
    itemId = nextItem.id as string;
    const { data: locked } = await sb
      .from("project_backlog_items")
      .update({ status: "doing", sprint_id: sprint.id })
      .eq("id", itemId)
      .eq("status", "todo")
      .select("id");

    lockedIds = (locked ?? []).map((r) => r.id as string);
    if (lockedIds.length === 0) {
      await sb.from("sprints").delete().eq("id", sprint.id);
      return { projectId, status: "skipped", reason: "backlog item raced — picked up by another dispatch" };
    }
  }

  // ── Derive default CLI routing per step ──────────────────────────
  const cliEnabled = projCli.enabled === true;
  type RoutingEntry = { cliOverride: { enabled: boolean; cli?: string; authMode?: "api-key" | "oauth" } };
  const stepRoutingOverrides: Record<string, RoutingEntry> = {};
  if (cliEnabled) {
    const defaultCli  = (projCli.default_cli as string | undefined) ?? "claude-code";
    const defaultAuth: "api-key" | "oauth" = lockedMode === "cloud" ? "api-key" : "oauth";
    const perAgentMap = (projCli.agent_overrides ?? {}) as Record<
      string,
      { enabled?: boolean; cli?: string; authMode?: "api-key" | "oauth" }
    >;
    for (const s of steps as Array<{ step: number; agent: string }>) {
      const perAgent = perAgentMap[s.agent];
      stepRoutingOverrides[String(s.step)] = {
        cliOverride: {
          enabled:  perAgent?.enabled !== false,
          cli:      perAgent?.cli ?? defaultCli,
          authMode: perAgent?.authMode ?? defaultAuth,
        },
      };
    }
  }

  // ── Save sprint config ────────────────────────────────────────────
  const sprintConfig = {
    mode:           lockedMode,
    bypassGates:    false,
    localBasePath:  localBasePath ?? undefined,
    stepRouting:    stepRoutingOverrides,
    agentInstructions: {},
    backlogItemIds: lockedIds,
  };
  await sb.from("sprints").update({ config: sprintConfig }).eq("id", sprint.id);

  // ── Dispatch ──────────────────────────────────────────────────────
  const tenantSlug   = tenantRow?.slug as string | undefined;
  const factorySlug  = factory.slug as string | undefined;

  const dispatch = await dispatchSprint({
    sb,
    projectId,
    factoryId,
    tenantId,
    projectSlug: project.slug as string,
    cliExecutionMode: dispatchMode,
    payload: {
      signal:   briefing,
      sprintId: sprint.id,
      sprintNum: sprint.sprint_num,
      intent:   sprintIntent,
      ...(tenantSlug ? { tenantSlug } : {}),
      ...(factorySlug ? { factorySlug } : {}),
      cliExecutionMode: lockedMode,
      ...(Object.keys(stepRoutingOverrides).length > 0 ? { stepRoutingOverrides } : {}),
    },
  });

  if (!dispatch.ok) {
    // Rollback. Discovery sprints don't lock backlog items so there's
    // nothing to revert there — only undo the lock when an itemId was
    // actually claimed (execution path).
    if (itemId) {
      await sb.from("project_backlog_items")
        .update({ status: "todo", sprint_id: null })
        .eq("id", itemId);
    }
    await sb.from("sprints").delete().eq("id", sprint.id);
    await sb.from("projects")
      .update({ sprint_count: project.sprint_count as number ?? 0 })
      .eq("id", projectId);
    return { projectId, status: "error", reason: `dispatch failed: ${dispatch.reason}${dispatch.detail ? ` — ${dispatch.detail.slice(0, 120)}` : ""}` };
  }

  if (dispatch.triggerRunId) {
    await sb.from("sprints")
      .update({ trigger_run_id: dispatch.triggerRunId, status: "running" })
      .eq("id", sprint.id);
  }

  return {
    projectId,
    status:        "dispatched",
    sprintNum:     sprint.sprint_num,
    triggerRunId:  dispatch.triggerRunId,
    intent:        sprintIntent,
    ...(itemId ? { backlogItemId: itemId } : {}),
  };
}

// ─── Notification helpers ─────────────────────────────────────────────
// Each emits with a 1h dedupe window per (tenant, project, event_type)
// so the operator gets one ping per state change, not one per cron tick.

async function emitAutoDrainHaltedNotification(
  sb: SupabaseClient,
  project: Record<string, unknown>,
  lastSprint: { status: string | null; sprint_num: number | null },
): Promise<void> {
  try {
    const factoryId = project.factory_id as string;
    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", factoryId).maybeSingle();
    if (!factory) return;
    const tenantId = factory.tenant_id as string;

    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await sb
      .from("notifications")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("event_type", "auto_drain_halted")
      .eq("metadata->>project_id", project.id as string)
      .gte("created_at", windowStart)
      .limit(1);
    if (recent && recent.length > 0) return;

    const projectName = (project.name as string) ?? (project.slug as string) ?? "project";
    const { data: notif } = await sb
      .from("notifications")
      .insert({
        tenant_id:  tenantId,
        event_type: "auto_drain_halted",
        severity:   "warning",
        title:      `Auto-drain halted — ${projectName}`,
        body:       `Sprint #${lastSprint.sprint_num} ended in "${lastSprint.status}". ` +
                    `Auto-drain is paused on this project to avoid looping. Resolve the failure ` +
                    `and re-enable from Project Settings, or restart the sprint manually.`,
        metadata:   {
          project_id: project.id,
          sprint_num: lastSprint.sprint_num,
          sprint_status: lastSprint.status,
        },
        scope:      "tenant",
      })
      .select("id")
      .single();

    if (notif) {
      await sb.from("notification_deliveries").insert({
        notification_id: notif.id,
        channel:         "in_app",
        status:          "sent",
        attempted_at:    new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn("[backlog-drain] halted notification failed:", (e as Error).message);
  }
}

async function emitAutoDrainDrainedNotification(
  sb: SupabaseClient,
  project: Record<string, unknown>,
): Promise<void> {
  try {
    const factoryId = project.factory_id as string;
    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", factoryId).maybeSingle();
    if (!factory) return;
    const tenantId = factory.tenant_id as string;

    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await sb
      .from("notifications")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("event_type", "auto_drain_drained")
      .eq("metadata->>project_id", project.id as string)
      .gte("created_at", windowStart)
      .limit(1);
    if (recent && recent.length > 0) return;

    const projectName = (project.name as string) ?? (project.slug as string) ?? "project";
    const { data: notif } = await sb
      .from("notifications")
      .insert({
        tenant_id:  tenantId,
        event_type: "auto_drain_drained",
        severity:   "info",
        title:      `Auto-drain finished — ${projectName}`,
        body:       `The backlog is empty and every queued item ran to completion. ` +
                    `Add more items from the kanban to continue, or leave auto-drain on standby.`,
        metadata:   { project_id: project.id },
        scope:      "tenant",
      })
      .select("id")
      .single();

    if (notif) {
      await sb.from("notification_deliveries").insert({
        notification_id: notif.id,
        channel:         "in_app",
        status:          "sent",
        attempted_at:    new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn("[backlog-drain] drained notification failed:", (e as Error).message);
  }
}

async function emitAutoDrainUnproductiveNotification(
  sb: SupabaseClient,
  project: Record<string, unknown>,
  consecutiveCount: number,
): Promise<void> {
  try {
    const factoryId = project.factory_id as string;
    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", factoryId).maybeSingle();
    if (!factory) return;
    const tenantId = factory.tenant_id as string;

    const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recent } = await sb
      .from("notifications")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("event_type", "auto_drain_unproductive")
      .eq("metadata->>project_id", project.id as string)
      .gte("created_at", windowStart)
      .limit(1);
    if (recent && recent.length > 0) return;

    const projectName = (project.name as string) ?? (project.slug as string) ?? "project";
    const { data: notif } = await sb
      .from("notifications")
      .insert({
        tenant_id:  tenantId,
        event_type: "auto_drain_unproductive",
        severity:   "warning",
        title:      `Auto-drain unproductive — ${projectName}`,
        body:       `The last ${consecutiveCount} sprints produced no commit — the agent appears stuck. ` +
                    `Auto-drain is halted to avoid burning the backlog without progress. Review the agent's ` +
                    `output, adjust the briefing or backlog items, and resume.`,
        metadata:   {
          project_id: project.id,
          consecutive_count: consecutiveCount,
        },
        scope:      "tenant",
      })
      .select("id")
      .single();

    if (notif) {
      await sb.from("notification_deliveries").insert({
        notification_id: notif.id,
        channel:         "in_app",
        status:          "sent",
        attempted_at:    new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn("[backlog-drain] unproductive notification failed:", (e as Error).message);
  }
}
