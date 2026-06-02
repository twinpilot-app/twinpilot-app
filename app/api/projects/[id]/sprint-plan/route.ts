/**
 * POST /api/projects/[id]/sprint-plan
 *
 * Compose the reviewable plan for the next sprint using the caller-supplied
 * overrides (same shape as /run). Persists the result in `sprint_plans` so
 * the operator can review at /projects/[id]/sprint-plan?planId=… and later
 * dispatch the run deterministically by referencing the plan id.
 *
 * Body: same overrides accepted by /run — briefing, sprintInstruction,
 *       agentInstructions, stepRoutingOverrides, bypassGates,
 *       startFromStep, endAtStep, contextSprintIds, contextCategories,
 *       cliExecutionMode, model, provider, maxTurnsOverride, runNote.
 *
 * Returns: { planId, plan } — the full SprintPlan JSON.
 *
 * Authorization: caller must be owner/admin of the factory's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { composeSprintPlan, type ComposeSprintPlanInput } from "@/lib/sprint-plan";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { ProjectSprintPlanSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = (await parseBody(req, ProjectSprintPlanSchema)) as ComposeSprintPlanInput["overrides"];
    const { user, sb } = await getOperatorUser(req);
    const { id: projectId } = await params;

    /* ── Membership check ─────────────────────────────────────────────── */
    const { data: project, error: projErr } = await sb
      .from("projects")
      .select("factory_id")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr) throw new Error(projErr.message);
    if (!project) throw new NotFoundError("Project not found");

    const { data: factory } = await sb
      .from("factories")
      .select("tenant_id")
      .eq("id", project.factory_id)
      .maybeSingle();
    if (!factory) throw new NotFoundError("Factory not found");

    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", factory.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      throw new ForbiddenError("Caller is not an admin of this project's tenant");
    }

    /* ── Compose ──────────────────────────────────────────────────────── */
    const plan = await composeSprintPlan({
      sb,
      projectId,
      userId: user.id,
      overrides: body ?? {},
    });

    /* ── Persist ──────────────────────────────────────────────────────── */
    const { data: inserted, error: insertErr } = await sb
      .from("sprint_plans")
      .insert({
        tenant_id:  factory.tenant_id,
        project_id: projectId,
        sprint_num: plan.sprint.num,
        version:    plan.version,
        plan,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (insertErr || !inserted) throw new Error(insertErr?.message ?? "Failed to persist plan");

    return NextResponse.json({ planId: inserted.id, plan });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

/**
 * GET /api/projects/[id]/sprint-plan?planId=…
 *
 * Fetches a previously composed plan for review. The dedicated preview page
 * hits this so a refresh doesn't recompute (and doesn't create another row).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { id: projectId } = await params;
    const planId = req.nextUrl.searchParams.get("planId");
    if (!planId) {
      return NextResponse.json({ error: "planId is required", code: "VALIDATION_ERROR" }, { status: 400 });
    }

    const { data: row, error } = await sb
      .from("sprint_plans")
      .select("id, plan, sprint_id, sprint_num, version, dispatched_at, created_at, tenant_id")
      .eq("id", planId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row)  throw new NotFoundError("Plan not found");

    // Membership check — user must belong to the plan's tenant
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", row.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member) throw new ForbiddenError("Caller is not a member of this plan's tenant");

    return NextResponse.json({
      planId:        row.id,
      plan:          row.plan,
      sprintId:      row.sprint_id,
      sprintNum:     row.sprint_num,
      version:       row.version,
      dispatchedAt:  row.dispatched_at,
      createdAt:     row.created_at,
    });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
