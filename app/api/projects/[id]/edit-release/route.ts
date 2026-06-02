/**
 * POST /api/projects/[id]/edit-release
 *
 * Releases the editor slot. Frontend calls this on navigate-away
 * (beforeunload, route change). Only the current holder can release.
 * Idempotent — returns ok even if the slot was already empty.
 *
 * No body.
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
    await sb
      .from("projects")
      .update({
        editing_user_id:        null,
        editing_started_at:     null,
        editing_last_heartbeat: null,
      })
      .eq("id", projectId)
      .eq("editing_user_id", user.id);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
