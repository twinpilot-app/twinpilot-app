/**
 * GET /api/notifications/unread-count?tenantId=...
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

    // Verify membership
    const { data: member } = await sb.from("tenant_members").select("id").eq("tenant_id", tenantId).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const scopeFilter = req.nextUrl.searchParams.get("scope") ?? "tenant";
    const { count, error } = await sb.from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("scope", scopeFilter)
      .is("read_at", null);
    if (error) throw new Error(error.message);

    return NextResponse.json({ count: count ?? 0 });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
