/**
 * POST /api/cli/gates/[runId] — approve or reject a pending human gate.
 *
 * First /api/cli/* route adopting the new `getCliCaller` wrapper from
 * lib/api-helpers (introduced in Trilho E leva 2). The wrapper translates
 * `lib/cli-api-auth.ts:authCli`'s NextResponse-on-failure shape into the
 * structured throw + errorResponse pattern shared with operator-UI
 * routes — same envelope, same try/catch shape, same parseBody validation.
 *
 * Writes an agent_event (approved/rejected), updates the run status, and
 * sets the parent project to "idle" so the user can `continue` it.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getCliCaller, parseBody, errorResponse,
  ForbiddenError, NotFoundError,
} from "@/lib/api-helpers";
import { CliGateDecisionSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  try {
    const auth = await getCliCaller(req);
    const { runId } = await ctx.params;
    // Validated body — Zod enforces action enum, comment ≤8KB,
    // instructions ≤8KB.
    const body = await parseBody(req, CliGateDecisionSchema);

    // Load run + validate it belongs to a project the caller can reach
    const { data: run } = await auth.sb
      .from("agent_runs")
      .select("id, agent, status, project_id")
      .eq("id", runId)
      .maybeSingle();
    if (!run) throw new NotFoundError(`Run ${runId} not found`);

    const { data: project } = await auth.sb
      .from("projects")
      .select("id, factory_id")
      .eq("id", run.project_id)
      .maybeSingle();
    if (!project) throw new NotFoundError(`Parent project ${run.project_id} not found`);

    // Factory scope check (factory-scoped key)
    if (auth.factoryId && project.factory_id !== auth.factoryId) {
      throw new ForbiddenError("Run belongs to a different factory than the API key allows");
    }
    // Tenant scope check (catches tenant-wide keys reaching another tenant)
    const { data: factory } = await auth.sb.from("factories").select("tenant_id").eq("id", project.factory_id).maybeSingle();
    if (!factory || factory.tenant_id !== auth.tenantId) {
      throw new ForbiddenError("Run belongs to a different tenant than the API key");
    }

    if (run.status !== "waiting") {
      return NextResponse.json({ error: `Run is not waiting (status: ${run.status})`, code: "WRONG_RUN_STATE" }, { status: 409 });
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
    if (evtErr) throw new Error(evtErr.message);

    const newRunStatus = body.action === "approve" ? "done" : "cancelled";
    await auth.sb.from("agent_runs").update({ status: newRunStatus }).eq("id", runId);
    // Sprint owns the gate state. Project goes idle so the next dispatch
    // can acquire the slot; the sprint stays in its waiting/paused state
    // for the operator to act on.
    await auth.sb.from("projects").update({ status: "idle" }).eq("id", run.project_id);

    return NextResponse.json({ ok: true, agent: run.agent });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
