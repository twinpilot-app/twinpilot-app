/**
 * POST /api/projects/[id]/edit-heartbeat
 *
 * Refreshes the editor-slot heartbeat. Only the current holder can keep
 * the slot alive; if some else has taken over, returns 409 so the
 * frontend can surface "{name} took over" and stop heartbeating.
 *
 * No body. Idempotent.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = serviceClient();
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: projectId } = await params;
    const { data: project } = await sb
      .from("projects").select("editing_user_id").eq("id", projectId).maybeSingle();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    if (project.editing_user_id !== user.id) {
      return NextResponse.json({
        error: "You are no longer the editor of this project.",
        currentHolder: project.editing_user_id,
      }, { status: 409 });
    }

    await sb
      .from("projects")
      .update({ editing_last_heartbeat: new Date().toISOString() })
      .eq("id", projectId);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
