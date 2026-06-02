/**
 * POST /api/projects/[id]/continue
 *
 * Resumes a paused or waiting project from the next step after the last
 * completed agent run. Mirrors `factory continue <slug>` from the CLI.
 *
 * Body: { fromStep?: number }
 */
import { NextRequest, NextResponse } from "next/server";
import { dispatchSprint } from "@/lib/sprint-dispatcher";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { ProjectContinueSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

// "running" is included so a stuck dispatch can be retried from the UI —
// the route flips it to idle below before re-acquiring the slot.
// "completed" is included so a specific step (e.g. sprint-push commit) can be re-run
const RESUMABLE_STATUSES = ["idle", "queued", "running"];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = await parseBody(req, ProjectContinueSchema);
    const { user, sb } = await getOperatorUser(req);
    const { id: projectId } = await params;

    // ── Load project ──────────────────────────────────────────────
    const { data: project } = await sb
      .from("projects")
      .select("id, name, slug, status, factory_id, pipeline, intake_brief")
      .eq("id", projectId)
      .maybeSingle();

    if (!project) throw new NotFoundError("Project not found");

    // ── Verify membership ─────────────────────────────────────────
    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", project.factory_id).single();
    if (!factory) throw new NotFoundError("Factory not found");

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      throw new ForbiddenError("Caller is not an admin of this project's tenant");
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
    // dispatchSprint's TriggerExecutionMode is binary; local-git collapses
    // to local because it runs on the operator's dev worker.
    const cliExecutionMode: "cloud" | "local" | undefined =
      body.cliExecutionMode === "local-git" ? "local"
      : (body.cliExecutionMode as "cloud" | "local" | undefined);

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
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
