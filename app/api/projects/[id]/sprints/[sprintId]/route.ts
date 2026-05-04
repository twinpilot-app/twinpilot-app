/**
 * DELETE /api/projects/[id]/sprints/[sprintId]
 *
 * Deletes a single sprint: removes artifacts from local filesystem and/or bucket,
 * then deletes agent_events, agent_runs, and the sprint record.
 *
 * Guards: sprint must not be actively running.
 * Auth: Bearer {supabase access_token}, must be tenant member.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { existsSync, rmSync } from "fs";
import { spawn } from "child_process";
import { TP_BUCKET, sprintPath, localSprintPath, localProjectRoot } from "@/lib/paths";

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

const ACTIVE_STATUSES = ["executing", "running", "provisioning"];

/**
 * PATCH /api/projects/[id]/sprints/[sprintId]
 *
 * Manually transition a paused or pending_save sprint to a terminal state.
 * Sprints that fail mid-run (claude-code is_error, agent failures, etc.)
 * land in `paused` and the project also gets `paused`. Without an explicit
 * finalize action the operator was stuck — couldn't dispatch a new sprint
 * because the project's status blocks new dispatches.
 *
 * Allowed transitions (operator-driven):
 *   paused        → cancelled | failed | completed
 *   pending_save  → cancelled | completed | failed
 *   waiting       → cancelled
 *   awaiting_approval → cancelled
 *
 * Side effect: if the sprint becomes terminal AND the project status is
 * also `paused` (set by the worker on failure), the project moves back
 * to `ready` so the operator can run another sprint.
 *
 * Body: { status: "cancelled" | "failed" | "completed", note?: string }
 */
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
// Sprints in any of these (terminal or transient) can be operator-finalized.
// Including "failed" lets the operator acknowledge a worker-marked failure
// (audit log keeps the original verdict; manual_finalization records the
// override). Project status never changes via this path — projects are
// permanent assets, only locked/cancelled by explicit operator action.
const FINALIZABLE_FROM = ["paused", "pending_save", "waiting", "awaiting_approval", "failed"];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sprintId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId, sprintId } = await params;
    const body = await req.json() as { status?: string; note?: string };

    const targetStatus = body.status;
    if (!targetStatus || !TERMINAL_STATUSES.includes(targetStatus)) {
      return NextResponse.json({ error: `status must be one of ${TERMINAL_STATUSES.join(" | ")}` }, { status: 400 });
    }

    const { data: project } = await sb
      .from("projects").select("status, factory_id").eq("id", projectId).single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb.from("factories").select("tenant_id").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).maybeSingle();
    if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: sprint } = await sb
      .from("sprints")
      .select("id, sprint_num, status, outcome")
      .eq("id", sprintId).eq("project_id", projectId).single();
    if (!sprint) return NextResponse.json({ error: "Sprint not found" }, { status: 404 });

    const currentStatus = sprint.status as string;
    if (!FINALIZABLE_FROM.includes(currentStatus)) {
      return NextResponse.json({
        error: `Cannot finalize a sprint in '${currentStatus}'. Only ${FINALIZABLE_FROM.join(", ")} are finalizable.`,
      }, { status: 409 });
    }

    // Stamp a manual-finalization note on the outcome so the audit trail
    // shows the operator decided this. Preserves the worker's outcome and
    // appends a manual_finalization sub-record.
    const existingOutcome = (sprint.outcome ?? null) as Record<string, unknown> | null;
    const finalizedOutcome = {
      ...(existingOutcome ?? {}),
      manual_finalization: {
        from_status: currentStatus,
        to_status:   targetStatus,
        finalized_by: user.id,
        finalized_at: new Date().toISOString(),
        ...(body.note && body.note.trim() ? { note: body.note.trim().slice(0, 500) } : {}),
      },
    };

    const { error: sprintErr } = await sb
      .from("sprints")
      .update({
        status: targetStatus,
        completed_at: new Date().toISOString(),
        outcome: finalizedOutcome,
      })
      .eq("id", sprintId);
    if (sprintErr) return NextResponse.json({ error: sprintErr.message }, { status: 500 });

    // Mark any orphan agent_runs for this sprint as failed too — the
    // worker may have left runs stuck in 'running' when it crashed.
    await sb.from("agent_runs")
      .update({ status: "failed", error: `Sprint manually finalized (${currentStatus} → ${targetStatus})`, finished_at: new Date().toISOString() })
      .eq("sprint_id", sprintId)
      .in("status", ["running", "waiting", "queued"]);

    // Whenever a sprint is manually finalized, ensure the project is
    // released back to idle so the next dispatch can acquire the slot.
    // After migration 160 'paused'/'pending_save' aren't valid project
    // states, so the only thing to clear here is a stuck 'running'.
    const projectUnblocked = project.status === "running";
    if (projectUnblocked) {
      await sb.from("projects").update({ status: "idle" }).eq("id", projectId);
    }

    return NextResponse.json({
      ok:        true,
      sprint_id: sprintId,
      transitioned: { from: currentStatus, to: targetStatus },
      project_unblocked: projectUnblocked,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Best-effort delete of a git tag in the project's local-git working tree.
 * Local-git mode tags each sprint as `sprint-N`. Deleting a sprint without
 * removing the tag would leave an orphan pointing at a commit no longer
 * tracked by the system. We never recreate `sprint-N` (sprint_count is
 * monotonic), so the tag deletion here is purely cleanup of stale state.
 *
 * Failures are logged and ignored — the tag may not exist (sprint never
 * reached commit), the working tree may be elsewhere, or git may be
 * unavailable. None of those should block the DB delete.
 */
async function tryDeleteGitTag(workdir: string, sprintNum: number): Promise<void> {
  if (!existsSync(`${workdir}/.git`)) return;
  await new Promise<void>((resolve) => {
    const proc = spawn("git", ["tag", "-d", `sprint-${sprintNum}`], { cwd: workdir, stdio: "pipe" });
    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sprintId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId, sprintId } = await params;

    // Load project + verify membership
    const { data: project } = await sb.from("projects").select("slug, factory_id").eq("id", projectId).single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb.from("factories").select("tenant_id, slug").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb.from("tenant_members").select("role").eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Load sprint
    const { data: sprint } = await sb.from("sprints").select("id, sprint_num, status, config").eq("id", sprintId).eq("project_id", projectId).single();
    if (!sprint) return NextResponse.json({ error: "Sprint not found" }, { status: 404 });

    if (ACTIVE_STATUSES.includes(sprint.status as string)) {
      return NextResponse.json({ error: `Cannot delete a sprint that is ${sprint.status}.` }, { status: 409 });
    }

    const projectSlug = project.slug as string;
    const factorySlug = factory.slug as string;
    const { data: tenant } = await sb.from("tenants").select("slug").eq("id", factory.tenant_id).single();
    const tenantSlug = tenant?.slug as string ?? "";
    const sprintNum = sprint.sprint_num as number;
    const config = (sprint.config ?? {}) as Record<string, unknown>;
    const localBase = config.localBasePath as string | undefined;

    // ── Clean local filesystem ─────────────────────────────────
    // Resolve the project's local base path from sprint config first, then
    // tenant storage integrations as fallback. We use it for both the
    // staging cleanup (rm -rf staging/sprint-N) AND the local-git tag
    // deletion (git tag -d sprint-N in the project root). A sprint that
    // ran in local-git mode commits artifacts at the project root and
    // tags them — leaving an orphan tag would point at a commit the
    // system no longer tracks.
    let resolvedLocalBase: string | undefined = localBase;
    if (!resolvedLocalBase) {
      const { data: storageInts } = await sb.from("tenant_integrations").select("secret_value").eq("tenant_id", factory.tenant_id).eq("service_id", "storage");
      for (const row of storageInts ?? []) {
        try {
          const cfg = JSON.parse(row.secret_value as string) as { type?: string; basePath?: string };
          if (cfg.type === "local" && cfg.basePath) { resolvedLocalBase = cfg.basePath; break; }
        } catch { /* ignore */ }
      }
    }

    if (resolvedLocalBase && tenantSlug && factorySlug) {
      try {
        const stagingDir = localSprintPath(resolvedLocalBase, tenantSlug, factorySlug, projectSlug, sprintNum);
        if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[sprint/delete] staging cleanup failed:`, (e as Error).message);
      }
      try {
        const projRoot = localProjectRoot(resolvedLocalBase, tenantSlug, factorySlug, projectSlug);
        await tryDeleteGitTag(projRoot, sprintNum);
      } catch (e) {
        console.warn(`[sprint/delete] git tag cleanup failed:`, (e as Error).message);
      }
    }

    // ── Clean bucket ───────────────────────────────────────────
    try {
      const prefix = sprintPath(tenantSlug, factorySlug, projectSlug, sprintNum);
      const paths: string[] = [];
      const collect = async (pfx: string) => {
        const { data: items } = await sb.storage.from(TP_BUCKET).list(pfx, { limit: 1000 });
        for (const item of items ?? []) {
          const full = `${pfx}/${item.name}`;
          if (!item.id) await collect(full);
          else paths.push(full);
        }
      };
      await collect(prefix);
      if (paths.length > 0) {
        const BATCH = 100;
        for (let i = 0; i < paths.length; i += BATCH) {
          await sb.storage.from(TP_BUCKET).remove(paths.slice(i, i + BATCH));
        }
      }
    } catch (e) {
      console.warn(`[sprint/delete] bucket cleanup failed:`, (e as Error).message);
    }

    // ── Cascade delete: events → runs → sprint ─────────────────
    const { data: runs } = await sb.from("agent_runs").select("id").eq("sprint_id", sprintId);
    if (runs && runs.length > 0) {
      await sb.from("agent_events").delete().in("run_id", runs.map((r) => r.id));
      await sb.from("agent_runs").delete().eq("sprint_id", sprintId);
    }
    await sb.from("sprints").delete().eq("id", sprintId);

    return NextResponse.json({ ok: true, deleted: sprintId });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
