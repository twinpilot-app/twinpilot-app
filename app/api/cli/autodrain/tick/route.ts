/**
 * POST /api/cli/autodrain/tick
 *
 * One iteration of the CLI-driven auto-drain loop. The `twin-pilot
 * autodrain` daemon hits this endpoint every N seconds to advance the
 * backlog of every eligible local-mode project in the operator's tenant.
 *
 * Why this endpoint vs the platform-side cron (/api/cron/backlog-auto-drain):
 *   - The cron endpoint authenticates via CRON_SECRET (system shared
 *     secret) and scans ALL tenants. The Vercel deploy can't run it on
 *     Hobby (cron schedule limit), and we don't want a global secret in
 *     the CLI's hands.
 *   - This endpoint authenticates via the CLI's tenant API key. It only
 *     touches projects of THAT tenant, and only those in local /
 *     local-git mode (cloud-mode projects must remain on the platform-
 *     side scheduler so we never race with it).
 *
 * Per-project work is the same `attemptDrainOne` helper the global cron
 * uses, so eligibility rules (pause flag, cooldown, daily cap, active
 * window, unproductive guard, pending-save proceed) stay consistent.
 *
 * Response mirrors the global cron's shape so a CLI dashboard / script
 * can read it the same way:
 *   {
 *     scanned:    N,                       ← projects in tenant + local-mode + drain-on
 *     eligible:   N,                       ← survived status pre-filter (= scanned today)
 *     dispatched: N,                       ← attemptDrainOne returned "dispatched"
 *     skipped:    N,
 *     errors:     N,
 *     results:    [{projectId, status, reason?, sprintNum?, ...}],
 *   }
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli } from "@/lib/cli-api-auth";
import { attemptDrainOne, type DrainAttemptResult } from "@/lib/backlog-drain";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;

  // Find the factory ids in this tenant scope. A factory-scoped key
  // narrows to one; an unscoped key fans out to every factory the
  // tenant owns.
  let factoryIds: string[] = [];
  if (auth.factoryId) {
    factoryIds = [auth.factoryId];
  } else {
    const { data: factories } = await auth.sb
      .from("factories")
      .select("id")
      .eq("tenant_id", auth.tenantId);
    factoryIds = (factories ?? []).map((f) => f.id as string);
  }

  if (factoryIds.length === 0) {
    return NextResponse.json({ scanned: 0, eligible: 0, dispatched: 0, skipped: 0, errors: 0, results: [] });
  }

  // ── Watchdog sweep ──────────────────────────────────────────
  // Detect zombie sprints: status running/executing but heartbeat older
  // than 5 minutes (or NULL + sprint older than 5 min — covers worker
  // pre-heartbeat-rollout). Mark them failed so the project can be
  // dispatched again. Without this sweep, killing a worker mid-pipeline
  // leaves the project invisible to every subsequent tick (status filter
  // below excludes 'executing'/'running').
  //
  // Scoped to the operator's factories so two tenants' watchdogs don't
  // race to recover each other's projects (cross-tenant interference is
  // already prevented by RLS, but explicit scoping keeps the query
  // predictable).
  const HEARTBEAT_TIMEOUT_MIN = 5;
  const watchdogThreshold = new Date(Date.now() - HEARTBEAT_TIMEOUT_MIN * 60_000).toISOString();
  try {
    // Resolve projects in scope first — sprints don't have a factory_id
    // column, so we narrow via projects.factory_id, then look up zombie
    // sprints under those projects.
    const { data: scopedProjects } = await auth.sb
      .from("projects")
      .select("id")
      .in("factory_id", factoryIds);
    const scopedProjectIds = (scopedProjects ?? []).map((p) => p.id as string);

    if (scopedProjectIds.length > 0) {
      const { data: zombies } = await auth.sb
        .from("sprints")
        .select("id, project_id")
        .in("project_id", scopedProjectIds)
        .eq("status", "running")
        .or(`heartbeat_at.is.null,heartbeat_at.lt.${watchdogThreshold}`)
        .lt("created_at", watchdogThreshold);
      const zombieIds = (zombies ?? []).map((s) => s.id as string);

      if (zombieIds.length > 0) {
        const zombieProjectIds = [...new Set((zombies ?? []).map((s) => s.project_id as string))];
        const failureMsg = `worker died — no heartbeat for >${HEARTBEAT_TIMEOUT_MIN} minutes`;
        const nowIso = new Date().toISOString();

        await auth.sb.from("sprints")
          .update({ status: "failed", completed_at: nowIso, failure_reason: failureMsg })
          .in("id", zombieIds);

        // Free the projects so the next eligibility check can dispatch.
        await auth.sb.from("projects")
          .update({ status: "idle" })
          .in("id", zombieProjectIds)
          .eq("status", "running");

        // Release backlog items locked to these zombie sprints.
        await auth.sb.from("project_backlog_items")
          .update({ status: "todo", sprint_id: null })
          .in("sprint_id", zombieIds)
          .eq("status", "doing");
      }
    }
  } catch (e) {
    // Non-fatal — a tick failing the sweep shouldn't block dispatch for
    // healthy projects. Next tick retries.
    console.warn("[autodrain/tick] watchdog sweep failed:", (e as Error).message);
  }

  // Same scan exclusion as the platform cron — the inner attemptDrainOne
  // does the fine-grained eligibility, this just narrows to projects
  // that could possibly accept a dispatch right now.
  const { data: candidates, error: candErr } = await auth.sb
    .from("projects")
    .select("id, name, slug, status, factory_id, pipeline, intake_brief, pipeline_id, discovery_pipeline_id, execution_pipeline_id, execution_mode, sprint_count, settings, archived_at")
    .eq("execution_mode", "kanban_auto")
    .in("factory_id", factoryIds)
    .eq("status", "idle")
    .is("archived_at", null);

  if (candErr) {
    return NextResponse.json({ error: candErr.message }, { status: 500 });
  }

  // Filter to local-mode only — avoids racing with the platform-side cron
  // when it eventually re-enables for cloud-mode projects. Belt-and-
  // suspenders against accidentally double-firing a cloud project.
  // (execution_mode='kanban_auto' is enforced DB-side above.)
  //
  // Resolution mirrors the Project Settings page: orchestration_mode wins
  // when explicitly set, otherwise we infer from execution_backend (legacy
  // projects pre-tri-modal) or the cli_agents.enabled flag (even older
  // projects). Without this fallback, projects saved before the field was
  // introduced get silently excluded from the daemon — visible as
  // "autonomous" in the UI but invisible to ticks.
  const eligible = (candidates ?? []).filter((p) => {
    const cli = (p.settings as { cli_agents?: {
      orchestration_mode?: string;
      execution_backend?: string;
      enabled?: boolean;
    } } | null | undefined)?.cli_agents;
    const explicit = cli?.orchestration_mode;
    if (explicit === "local" || explicit === "local-git") return true;
    if (explicit === "cloud") return false;
    // No explicit mode — infer like the UI does:
    //   execution_backend === "local"  → local
    //   cli_agents.enabled === true   → local (legacy)
    //   else                          → cloud (excluded)
    return cli?.execution_backend === "local" || cli?.enabled === true;
  });

  if (eligible.length === 0) {
    return NextResponse.json({
      scanned: candidates?.length ?? 0, eligible: 0,
      dispatched: 0, skipped: 0, errors: 0,
      results: [],
    });
  }

  // Run drain attempts in parallel — one slow project shouldn't hold
  // up the others. allSettled isolates per-project failures.
  const settled = await Promise.allSettled(
    eligible.map((p) => attemptDrainOne(auth.sb, p)),
  );

  const flat: DrainAttemptResult[] = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { projectId: eligible[i]!.id as string, status: "error", reason: (r.reason as Error)?.message ?? "unknown" },
  );

  return NextResponse.json({
    scanned:    candidates?.length ?? 0,
    eligible:   eligible.length,
    dispatched: flat.filter((r) => r.status === "dispatched").length,
    skipped:    flat.filter((r) => r.status === "skipped").length,
    errors:     flat.filter((r) => r.status === "error").length,
    results:    flat,
  });
}
