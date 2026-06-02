/**
 * GET /api/notifications?tenantId=...&unread=true&limit=20&offset=0
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function sb() { return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }); }

async function getUser(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const s = sb();
  const { data: { user }, error } = await s.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { user, s };
}

export async function GET(req: NextRequest) {
  try {
    const { user, s } = await getUser(req);
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

    // Verify membership
    const { data: member } = await s.from("tenant_members").select("id").eq("tenant_id", tenantId).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const unread = req.nextUrl.searchParams.get("unread") === "true";
    const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "20"), 50);
    const offset = parseInt(req.nextUrl.searchParams.get("offset") ?? "0");

    const scopeFilter = req.nextUrl.searchParams.get("scope") ?? "tenant";
    let query = s.from("notifications")
      .select("id, event_type, severity, title, body, metadata, read_at, created_at, scope")
      .eq("tenant_id", tenantId)
      .eq("scope", scopeFilter)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (unread) query = query.is("read_at", null);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return NextResponse.json({ notifications: data ?? [] });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}
