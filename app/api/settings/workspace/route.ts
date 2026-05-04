/**
 * GET /api/settings/workspace?tenantId=...
 * Returns tenant slug + factories for the CI/CD env var panel.
 * Auth: Bearer token (the calling user must be a member of the tenant).
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

export async function GET(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sb = serviceClient();
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = req.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

  // Verify membership
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .single();

  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [tenantRes, factoriesRes] = await Promise.all([
    sb.from("tenants").select("id, name, slug").eq("id", tenantId).single(),
    sb.from("factories").select("id, name, slug").eq("tenant_id", tenantId).order("created_at"),
  ]);

  return NextResponse.json({
    tenant:    tenantRes.data,
    factories: factoriesRes.data ?? [],
  });
}
