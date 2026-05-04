/**
 * GET /api/cli/pending-gates — list all agent_runs in status=waiting,
 * scoped by the CLI's factory scope. Each entry includes the project
 * name/slug so the CLI can display human-readable output.
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli } from "@/lib/cli-api-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;

  // Scope to tenant's projects; factory scope optional.
  let projectsQuery = auth.sb.from("projects").select("id, name, slug, factory_id");
  if (auth.factoryId) {
    projectsQuery = projectsQuery.eq("factory_id", auth.factoryId);
  } else {
    const { data: factories } = await auth.sb.from("factories").select("id").eq("tenant_id", auth.tenantId);
    const ids = (factories ?? []).map((f) => f.id as string);
    if (ids.length === 0) return NextResponse.json({ gates: [] });
    projectsQuery = projectsQuery.in("factory_id", ids);
  }
  const { data: projects } = await projectsQuery;
  const projectIds = (projects ?? []).map((p) => p.id as string);
  if (projectIds.length === 0) return NextResponse.json({ gates: [] });

  const { data: runs } = await auth.sb
    .from("agent_runs")
    .select("id, agent, squad, step, phase, phase_name, status, output_ref, created_at, project_id")
    .in("project_id", projectIds)
    .eq("status", "waiting")
    .order("created_at", { ascending: true });

  const projById = new Map((projects ?? []).map((p) => [p.id as string, { name: p.name, slug: p.slug }]));
  const gates = (runs ?? []).map((r) => {
    const proj = projById.get(r.project_id as string);
    return {
      id:          r.id,
      agent:       r.agent,
      squad:       r.squad,
      step:        r.step,
      phase:       r.phase,
      phase_name:  r.phase_name,
      output_ref:  r.output_ref,
      created_at:  r.created_at,
      project_name: proj?.name ?? null,
      project_slug: proj?.slug ?? null,
    };
  });

  return NextResponse.json({ gates });
}
