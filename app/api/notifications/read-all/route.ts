/**
 * POST /api/notifications/read-all — mark all unread notifications as read
 * Body: { tenantId }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { tenantId } = await req.json() as { tenantId?: string };
    if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

    // Verify membership
    const { data: member } = await sb.from("tenant_members").select("id").eq("tenant_id", tenantId).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { error } = await sb.from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .is("read_at", null);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
