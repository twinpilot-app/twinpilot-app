/**
 * POST /api/projects/[id]/approve
 *
 * Approves a waiting agent run (escalation or human gate) and resumes the pipeline.
 *
 * Body: { runId: string; instructions?: string }
 *
 * Steps:
 *   1. Insert agent_events row (event_type: "approved")
 *   2. Mark agent_run status → "done"
 *   3. Set project status → "paused"
 *   4. Trigger pipeline continue via Trigger.dev (if configured)
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { dispatchSprint } from "@/lib/sprint-dispatcher";

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
    const body = await req.json() as { runId: string; instructions?: string; cliExecutionMode?: "cloud" | "local" };

    if (!body.runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

    // ── Verify membership ─────────────────────────────────────────
    const { data: project } = await sb
      .from("projects")
      .select("id, slug, factory_id, intake_brief, status")
      .eq("id", projectId)
      .single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Load the run to find its step ─────────────────────────────
    const { data: run } = await sb
      .from("agent_runs")
      .select("id, step, agent, status")
      .eq("id", body.runId)
      .single();
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    // ── 1. Insert approved event ──────────────────────────────────
    await sb.from("agent_events").insert({
      run_id:     body.runId,
      event_type: "approved",
      payload: {
        action:       "approve",
        approved_by:  user.id,
        approved_at:  new Date().toISOString(),
        instructions: body.instructions ?? null,
      },
    });

    // ── 2. Mark run as done ───────────────────────────────────────
    await sb.from("agent_runs").update({ status: "done" }).eq("id", body.runId);

    // ── 3. Settle project to idle so dispatchSprint can re-acquire ─
    // The sprint stays in its waiting/paused state; only the project
    // returns to a non-busy status before we kick off the next run.
    await sb.from("projects").update({ status: "idle" }).eq("id", projectId);

    // ── 4. Auto-continue via Trigger.dev ──────────────────────────
    const cliExecutionMode = body.cliExecutionMode ?? undefined;
    const resumeStep = ((run.step as number) ?? 0) + 1;
    const signal = (project.intake_brief as string | null)
      ?? `Resuming project after approval of ${run.agent as string}`;

    const dispatch = await dispatchSprint({
      sb,
      projectId,
      factoryId: project.factory_id as string,
      tenantId: factory.tenant_id as string,
      projectSlug: project.slug as string,
      cliExecutionMode,
      payload: {
        signal,
        startFromStep: resumeStep,
      },
    });

    if (!dispatch.ok) {
      if (dispatch.reason === "no-slot") {
        return NextResponse.json(
          { error: "Factory is at its concurrent project limit. Wait for a running sprint to finish and try again." },
          { status: 429, headers: { "Retry-After": "30" } },
        );
      }
      // no-key / trigger-rejected / trigger-error / project-busy / other:
      // surface the CLI fallback so the user can resume manually.
      return NextResponse.json({
        ok:          true,
        triggered:   false,
        resume_step: resumeStep,
        cli_command: `factory continue ${project.slug as string} --from-step ${resumeStep}`,
        ...(dispatch.reason !== "no-key" ? { warning: dispatch.detail ?? dispatch.reason } : {}),
      });
    }

    return NextResponse.json({
      ok:            true,
      triggered:     dispatch.triggerRunId !== null,
      resume_step:   resumeStep,
      cli_command:   dispatch.triggerRunId
        ? null
        : `factory continue ${project.slug as string} --from-step ${resumeStep}`,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
