/**
 * GET    /api/cli/projects/[slug]          — project detail + agent_runs
 * DELETE /api/cli/projects/[slug]          — delete project + cascading rows
 *                                             (agent_events, agent_runs,
 *                                             project itself). Equivalent
 *                                             to the legacy `clean` command.
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli, requireFactoryId } from "@/lib/cli-api-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;
  const factory = await requireFactoryId(auth);
  if (factory instanceof NextResponse) return factory;

  const { slug } = await ctx.params;

  const { data: project } = await auth.sb
    .from("projects")
    .select("id, name, slug, domain, status, current_phase, current_phase_name, created_at, bom")
    .eq("slug", slug)
    .eq("factory_id", factory.factoryId)
    .maybeSingle();

  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const { data: runs } = await auth.sb
    .from("agent_runs")
    .select("id, agent, step, phase, phase_name, status, cost_usd, started_at, finished_at")
    .eq("project_id", project.id)
    .order("step", { ascending: true });

  return NextResponse.json({ project, runs: runs ?? [] });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;
  const factory = await requireFactoryId(auth);
  if (factory instanceof NextResponse) return factory;

  const { slug } = await ctx.params;

  const { data: project } = await auth.sb
    .from("projects")
    .select("id")
    .eq("slug", slug)
    .eq("factory_id", factory.factoryId)
    .maybeSingle();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const projectId = project.id as string;

  // Delete events first (FK), then runs, then project
  const { data: runRows } = await auth.sb.from("agent_runs").select("id").eq("project_id", projectId);
  const runIds = (runRows ?? []).map((r) => r.id as string);
  if (runIds.length > 0) {
    await auth.sb.from("agent_events").delete().in("run_id", runIds);
  }
  await auth.sb.from("agent_runs").delete().eq("project_id", projectId);
  await auth.sb.from("projects").delete().eq("id", projectId);

  return NextResponse.json({ ok: true, deletedRuns: runIds.length });
}
