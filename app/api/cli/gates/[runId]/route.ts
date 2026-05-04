/**
 * POST /api/cli/gates/[runId] — approve or reject a pending human gate.
 * Body: { action: "approve" | "reject", comment?: string, instructions?: string }
 *
 * Writes an agent_event (approved/rejected), updates the run status, and
 * sets the parent project to "paused" so the user can `continue` it.
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli } from "@/lib/cli-api-auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: "approve" | "reject";
    comment?: string;
    instructions?: string;
  };
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
  }

  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;

  const { runId } = await ctx.params;

  // Load run + validate it belongs to a project the caller can reach
  const { data: run } = await auth.sb
    .from("agent_runs")
    .select("id, agent, status, project_id")
    .eq("id", runId)
    .maybeSingle();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const { data: project } = await auth.sb
    .from("projects")
    .select("id, factory_id")
    .eq("id", run.project_id)
    .maybeSingle();
  if (!project) return NextResponse.json({ error: "Parent project not found" }, { status: 404 });

  // Factory scope check
  if (auth.factoryId && project.factory_id !== auth.factoryId) {
    return NextResponse.json({ error: "Run belongs to a different factory" }, { status: 403 });
  }
  // Tenant scope check (if key is tenant-wide)
  const { data: factory } = await auth.sb.from("factories").select("tenant_id").eq("id", project.factory_id).maybeSingle();
  if (!factory || factory.tenant_id !== auth.tenantId) {
    return NextResponse.json({ error: "Run belongs to a different tenant" }, { status: 403 });
  }

  if (run.status !== "waiting") {
    return NextResponse.json({ error: `Run is not waiting (status: ${run.status})` }, { status: 409 });
  }

  const eventType = body.action === "approve" ? "approved" : "rejected";
  const payload: Record<string, unknown> = {
    action:      body.action,
    comment:     body.comment ?? null,
    approved_by: "cli",
    approved_at: new Date().toISOString(),
  };
  if (body.instructions) payload.instructions = body.instructions;

  const { error: evtErr } = await auth.sb.from("agent_events").insert({
    run_id:     runId,
    event_type: eventType,
    payload,
  });
  if (evtErr) return NextResponse.json({ error: evtErr.message }, { status: 500 });

  const newRunStatus = body.action === "approve" ? "done" : "cancelled";
  await auth.sb.from("agent_runs").update({ status: newRunStatus }).eq("id", runId);
  // Sprint owns the gate state. Project goes idle so the next dispatch
  // can acquire the slot; the sprint stays in its waiting/paused state
  // for the operator to act on.
  await auth.sb.from("projects").update({ status: "idle" }).eq("id", run.project_id);

  return NextResponse.json({ ok: true, agent: run.agent });
}
