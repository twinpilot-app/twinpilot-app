/**
 * DELETE /api/notifications/[id] — delete a single tenant notification
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;

    // Verify the notification belongs to a tenant the user is a member of
    const { data: notif } = await sb.from("notifications").select("id, scope, tenant_id").eq("id", id).single();
    if (!notif) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (notif.scope === "platform") return NextResponse.json({ error: "Cannot delete platform notifications" }, { status: 403 });

    const { data: member } = await sb.from("tenant_members").select("id").eq("tenant_id", notif.tenant_id).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Delete deliveries first (FK), then notification
    await sb.from("notification_deliveries").delete().eq("notification_id", id);
    const { error } = await sb.from("notifications").delete().eq("id", id);
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
