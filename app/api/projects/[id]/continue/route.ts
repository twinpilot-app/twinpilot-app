/**
 * POST /api/projects/[id]/continue
 *
 * Resumes a paused or waiting project from the next step after the last
 * completed agent run. Mirrors `factory continue <slug>` from the CLI.
 *
 * Body: { fromStep?: number }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { dispatchSprint } from "@/lib/sprint-dispatcher";

export const dynamic = "force-dynamic";

// "running" is included so a stuck dispatch can be retried from the UI —
// the route flips it to idle below before re-acquiring the slot.
// "completed" is included so a specific step (e.g. sprint-push commit) can be re-run
const RESUMABLE_STATUSES = ["idle", "queued", "running"];

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
    const body = await req.json() as { fromStep?: number; toStep?: number; note?: string; bypassGates?: boolean; provider?: string; model?: string; cliExecutionMode?: "cloud" | "local" };

    // ── Load project ──────────────────────────────────────────────
    const { data: project } = await sb
      .from("projects")
      .select("id, name, slug, status, factory_id, pipeline, intake_brief")
      .eq("id", projectId)
      .single();

    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    // ── Verify membership ─────────────────────────────────────────
    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Guard: must be in a resumable status ──────────────────────
    if (!RESUMABLE_STATUSES.includes(project.status as string)) {
      return NextResponse.json(
        { error: `Project is ${project.status}. Only ${RESUMABLE_STATUSES.join(", ")} projects can be continued.` },
        { status: 409 },
      );
    }

    const bypassGates = body.bypassGates ?? false;
    const provider    = body.provider?.trim() || undefined;
    const model       = body.model?.trim() || undefined;
    const endAtStep   = body.toStep ?? undefined;
    const runNote     = body.note?.trim() || undefined;
    const cliExecutionMode = body.cliExecutionMode ?? undefined;

    // ── Resolve resume step ───────────────────────────────────────
    let resumeStep = body.fromStep;
    if (!resumeStep) {
      const { data: lastRun } = await sb
        .from("agent_runs")
        .select("step")
        .eq("project_id", projectId)
        .eq("status", "done")
        .order("step", { ascending: false })
        .limit(1)
        .single();
      resumeStep = lastRun ? ((lastRun.step as number) ?? 0) + 1 : 1;
    }

    // ── Settle project to a non-busy status before slot acquire ───
    // "running" would be rejected by the slot function as project-busy,
    // so flip down to "idle" first. The slot is re-acquired atomically
    // by dispatchSprint below.
    if (project.status === "running") {
      await sb.from("projects").update({ status: "idle" }).eq("id", projectId);
    }

    const signal = (project.intake_brief as string | null) ?? `Resuming project "${project.name as string}"`;

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
        ...(endAtStep !== undefined ? { endAtStep } : {}),
        ...(runNote ? { runNote } : {}),
        ...(bypassGates ? { bypassGates: true } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        // Single-step invocation (run-once): fromStep === toStep
        ...(endAtStep !== undefined && resumeStep === endAtStep ? { runType: "run-once" } : {}),
      },
    });

    if (!dispatch.ok) {
      if (dispatch.reason === "no-slot") {
        return NextResponse.json(
          { error: "Factory is at its concurrent project limit. Wait for a running sprint to finish and try again." },
          { status: 429, headers: { "Retry-After": "30" } },
        );
      }
      // No-key / trigger-rejected / trigger-error: fall back to CLI instructions.
      return NextResponse.json({
        triggered:      false,
        trigger_run_id: null,
        resume_step:    resumeStep,
        cli_command:    `factory continue ${project.slug as string} --from-step ${resumeStep}`,
        ...(dispatch.reason !== "no-key" ? { warning: dispatch.detail ?? dispatch.reason } : {}),
      });
    }

    if (dispatch.triggerRunId) {
      // Restore sprint row to "running" when resuming.
      await sb.from("sprints")
        .update({ status: "running" })
        .eq("project_id", projectId)
        .in("status", ["paused", "waiting", "queued"]);
    }

    return NextResponse.json({
      triggered:      dispatch.triggerRunId !== null,
      trigger_run_id: dispatch.triggerRunId,
      resume_step:    resumeStep,
      cli_command:    dispatch.triggerRunId
        ? null
        : `factory continue ${project.slug as string} --from-step ${resumeStep}`,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
