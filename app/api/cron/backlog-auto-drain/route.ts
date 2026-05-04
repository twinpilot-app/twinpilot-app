/**
 * POST /api/cron/backlog-auto-drain
 *
 * Scheduled task that auto-dispatches the next sprint for projects with
 * `execution_mode = 'kanban_auto'`. Per-project work lives in
 * `lib/backlog-drain.ts → attemptDrainOne` so the cron and the per-
 * project Run Next button share the same logic.
 *
 * Eligibility per project:
 *   1. execution_mode === 'kanban_auto' (DB-side filter via index)
 *   2. project.status === 'idle' AND archived_at IS NULL
 *   3. Not paused, last sprint completed/pending_save, cooldown elapsed,
 *      under daily cap, inside active window, productive — see
 *      attemptDrainOne for the full eligibility flow.
 *   4. ≥1 backlog item in 'todo'
 *
 * Auth: Bearer CRON_SECRET (Vercel Cron sends this; same secret protects
 * ad-hoc curls and the GitHub Actions workflow). Without the env var, the
 * endpoint refuses every call — there is no "open" mode, since this can
 * dispatch billable LLM work.
 *
 * Concurrency: at most one sprint per project per tick. Across projects,
 * runs are independent; we Promise.allSettled them so a single failing
 * project doesn't block the others.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { attemptDrainOne, type DrainAttemptResult } from "@/lib/backlog-drain";

export const dynamic = "force-dynamic";

function serviceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function POST(req: NextRequest) {
  // ── Auth: shared secret in Authorization header ──────────────────────
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured on the server. Auto-drain is disabled." },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (provided !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = serviceClient();

  // ── Watchdog sweep (global) ─────────────────────────────────────────
  // Mirror of the per-tenant watchdog in /api/cli/autodrain/tick. Sprints
  // running with no heartbeat for >5 minutes are declared dead so the
  // next candidate query can pick the project up again.
  const HEARTBEAT_TIMEOUT_MIN = 5;
  const watchdogThreshold = new Date(Date.now() - HEARTBEAT_TIMEOUT_MIN * 60_000).toISOString();
  try {
    const { data: zombies } = await sb
      .from("sprints")
      .select("id, project_id")
      .eq("status", "running")
      .or(`heartbeat_at.is.null,heartbeat_at.lt.${watchdogThreshold}`)
      .lt("created_at", watchdogThreshold);
    const zombieIds = (zombies ?? []).map((s) => s.id as string);

    if (zombieIds.length > 0) {
      const zombieProjectIds = [...new Set((zombies ?? []).map((s) => s.project_id as string))];
      const failureMsg = `worker died — no heartbeat for >${HEARTBEAT_TIMEOUT_MIN} minutes`;
      const nowIso = new Date().toISOString();

      await sb.from("sprints")
        .update({ status: "failed", completed_at: nowIso, failure_reason: failureMsg })
        .in("id", zombieIds);
      await sb.from("projects")
        .update({ status: "idle" })
        .in("id", zombieProjectIds)
        .eq("status", "running");
      await sb.from("project_backlog_items")
        .update({ status: "todo", sprint_id: null })
        .in("sprint_id", zombieIds)
        .eq("status", "doing");
    }
  } catch (e) {
    console.warn("[cron/backlog-auto-drain] watchdog sweep failed:", (e as Error).message);
  }

  // ── Find candidate projects ─────────────────────────────────────────
  // Only idle, non-archived projects can be picked. Sprint-side gates
  // (paused/pending_save) on the latest sprint are filtered downstream
  // by attemptDrainOne.
  const { data: candidates, error: candErr } = await sb
    .from("projects")
    .select("id, name, slug, status, factory_id, pipeline, intake_brief, pipeline_id, discovery_pipeline_id, execution_pipeline_id, execution_mode, sprint_count, settings, archived_at")
    .eq("execution_mode", "kanban_auto")
    .eq("status", "idle")
    .is("archived_at", null);

  if (candErr) {
    return NextResponse.json({ error: `Failed to query projects: ${candErr.message}` }, { status: 500 });
  }

  // execution_mode filter happens in the query; the DB-side filter is
  // backed by a partial index so this stays cheap as the project count grows.
  const eligible = candidates ?? [];

  if (eligible.length === 0) {
    return NextResponse.json({ scanned: candidates?.length ?? 0, eligible: 0, results: [] });
  }

  // ── Drain each eligible project ─────────────────────────────────────
  const results = await Promise.allSettled(
    eligible.map((p) => attemptDrainOne(sb, p)),
  );

  const flat: DrainAttemptResult[] = results.map((r, i) =>
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
