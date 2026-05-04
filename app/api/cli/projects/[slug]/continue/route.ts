/**
 * POST /api/cli/projects/[slug]/continue
 * Body: { fromStep?: number }
 *
 * Resume a paused project from the given step (or auto-detect the next
 * step after the last `done` run). Equivalent to `twin-pilot continue`.
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli, requireFactoryId } from "@/lib/cli-api-auth";
import { dispatchSprint } from "@/lib/sprint-dispatcher";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const body = (await req.json().catch(() => ({}))) as { fromStep?: number };
  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;
  const factory = await requireFactoryId(auth);
  if (factory instanceof NextResponse) return factory;

  const { slug } = await ctx.params;

  const { data: project } = await auth.sb
    .from("projects")
    .select("id, name, status, archived_at, bom")
    .eq("slug", slug)
    .eq("factory_id", factory.factoryId)
    .maybeSingle();

  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  // Project is archived — operator must unarchive in Studio first.
  if (project.archived_at) {
    return NextResponse.json({ error: "Project is archived. Unarchive it in Studio to resume." }, { status: 409 });
  }

  // Sprint owns waiting now. Detect a sprint waiting on a human gate
  // and refuse — the operator must resolve via approve/reject first.
  const { data: waitingSprint } = await auth.sb
    .from("sprints")
    .select("id")
    .eq("project_id", project.id)
    .eq("status", "waiting")
    .limit(1)
    .maybeSingle();
  if (waitingSprint) {
    return NextResponse.json({
      error: "A sprint is waiting for human gate approval — resolve it first via `pending` / `approve` / `reject`",
    }, { status: 409 });
  }

  // Detect "ghost running" — stuck in running with no activity for >5 min
  if (project.status === "running") {
    const { data: activeRuns } = await auth.sb
      .from("agent_runs")
      .select("id")
      .eq("project_id", project.id)
      .in("status", ["running", "waiting"])
      .limit(1);

    const { data: recentRun } = await auth.sb
      .from("agent_runs")
      .select("finished_at")
      .eq("project_id", project.id)
      .eq("status", "done")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const lastActivityMs = recentRun?.finished_at
      ? Date.now() - new Date(recentRun.finished_at).getTime()
      : Infinity;
    const isGhost = !activeRuns?.length && lastActivityMs > 5 * 60 * 1000;

    if (!isGhost) {
      return NextResponse.json({ error: "Project is already running" }, { status: 409 });
    }
    // Ghost branch — project says running but no live agent. Settle to
    // idle so dispatchSprint can re-acquire the slot.
    await auth.sb.from("projects").update({ status: "idle" }).eq("id", project.id);
  }

  // Compute resume step if not given
  let resumeStep = body.fromStep;
  if (!resumeStep) {
    const { data: lastRun } = await auth.sb
      .from("agent_runs")
      .select("step")
      .eq("project_id", project.id)
      .eq("status", "done")
      .order("step", { ascending: false })
      .limit(1)
      .maybeSingle();
    resumeStep = lastRun ? ((lastRun.step ?? 0) + 1) : 1;
  }

  const originalSignal =
    (project.bom as { signal?: string } | null)?.signal ??
    `Resuming project "${project.name}"`;

  const dispatch = await dispatchSprint({
    sb: auth.sb,
    projectId: project.id as string,
    factoryId: factory.factoryId,
    tenantId: auth.tenantId,
    projectSlug: slug,
    payload: { signal: originalSignal, startFromStep: resumeStep },
  });

  if (!dispatch.ok) {
    return NextResponse.json(
      { error: `Dispatch failed: ${dispatch.reason}${dispatch.detail ? ` — ${dispatch.detail}` : ""}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, resumeStep, triggerRunId: dispatch.triggerRunId });
}
