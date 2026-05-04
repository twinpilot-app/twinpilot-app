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
import { createClient } from "@supabase/supabase-js";
import { composeSprintPlan, type ComposeSprintPlanInput } from "@/lib/sprint-plan";

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
    const body = (await req.json().catch(() => ({}))) as ComposeSprintPlanInput["overrides"];

    /* ── Membership check ─────────────────────────────────────────────── */
    const { data: project, error: projErr } = await sb
      .from("projects")
      .select("factory_id")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr) return NextResponse.json({ error: projErr.message }, { status: 500 });
    if (!project)  return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb
      .from("factories")
      .select("tenant_id")
      .eq("id", project.factory_id)
      .maybeSingle();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", factory.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
    if (insertErr || !inserted) {
      return NextResponse.json({ error: insertErr?.message ?? "Failed to persist plan" }, { status: 500 });
    }

    return NextResponse.json({ planId: inserted.id, plan });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
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
    const { user, sb } = await getUser(req);
    const { id: projectId } = await params;
    const planId = req.nextUrl.searchParams.get("planId");
    if (!planId) return NextResponse.json({ error: "planId is required" }, { status: 400 });

    const { data: row, error } = await sb
      .from("sprint_plans")
      .select("id, plan, sprint_id, sprint_num, version, dispatched_at, created_at, tenant_id")
      .eq("id", planId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (error)  return NextResponse.json({ error: error.message }, { status: 500 });
    if (!row)   return NextResponse.json({ error: "Plan not found" }, { status: 404 });

    // Membership check — user must belong to the plan's tenant
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", row.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    return NextResponse.json({
      planId:        row.id,
      plan:          row.plan,
      sprintId:      row.sprint_id,
      sprintNum:     row.sprint_num,
      version:       row.version,
      dispatchedAt:  row.dispatched_at,
      createdAt:     row.created_at,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
