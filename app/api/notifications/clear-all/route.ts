/**
 * POST /api/notifications/clear-all — delete all tenant-scope notifications
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

    // Get all tenant-scope notification IDs
    const { data: notifs } = await sb
      .from("notifications")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("scope", "tenant");

    if (notifs && notifs.length > 0) {
      const ids = notifs.map((n) => n.id as string);
      await sb.from("notification_deliveries").delete().in("notification_id", ids);
      await sb.from("notifications").delete().in("id", ids);
    }

    return NextResponse.json({ ok: true, deleted: notifs?.length ?? 0 });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
