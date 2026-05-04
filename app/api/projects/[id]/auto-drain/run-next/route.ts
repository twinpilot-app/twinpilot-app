/**
 * POST /api/projects/[id]/auto-drain/run-next
 *
 * One-shot dispatch of the next backlog item for THIS project. Wraps
 * the same `attemptDrainOne` the cron uses, so eligibility rules
 * (pause flag, cooldown, daily cap, active window, unproductive guard,
 * pending-save proceed) are honoured identically.
 *
 * Why a separate endpoint vs reusing /api/cron/backlog-auto-drain:
 *   - The cron endpoint authenticates with CRON_SECRET (a shared system
 *     secret). Browsers can't safely hold that — a Run Next button in
 *     the kanban needs an endpoint the operator's session can call.
 *   - The cron iterates over ALL eligible projects; a per-project
 *     button should only touch THIS one.
 *
 * Auth: tenant member (owner/admin/member) of the project's tenant.
 * Same gate as the regular backlog endpoints.
 *
 * Returns the same DrainAttemptResult shape the cron emits per project.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { attemptDrainOne } from "@/lib/backlog-drain";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = serviceClient();
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: projectId } = await params;

    // Load project + verify execution_mode supports kanban dispatches. We
    // query the same shape attemptDrainOne expects so it can be passed
    // straight through.
    const { data: project, error: projErr } = await sb
      .from("projects")
      .select("id, name, slug, status, factory_id, pipeline, intake_brief, pipeline_id, discovery_pipeline_id, execution_pipeline_id, execution_mode, sprint_count, settings")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr || !project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Membership check (tenant-scoped via factory).
    const { data: factory } = await sb
      .from("factories")
      .select("tenant_id")
      .eq("id", project.factory_id as string)
      .maybeSingle();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", factory.tenant_id as string)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Project must use kanban (manual or auto). For execution_mode=manual
    // there's no backlog to advance — the operator types a per-sprint
    // briefing and uses the Start Sprint flow instead.
    const execMode = (project as { execution_mode?: string }).execution_mode;
    if (execMode !== "kanban_auto" && execMode !== "kanban_manual") {
      return NextResponse.json(
        { error: "This project doesn't use a kanban. Switch execution mode to Kanban (manual or autonomous) in Project Settings to dispatch backlog items." },
        { status: 422 },
      );
    }

    // Status filter mirrors the cron's scan exclusion. paused/completed/
    // pending_save/failed/cancelled all proceed; running states cannot.
    const status = project.status as string;
    if (["executing", "running", "provisioning", "waiting", "draft"].includes(status)) {
      return NextResponse.json(
        { error: `Project is in "${status}" — wait for the current activity to finish.` },
        { status: 409 },
      );
    }

    const result = await attemptDrainOne(sb, project as unknown as Record<string, unknown>);
    return NextResponse.json(result);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
