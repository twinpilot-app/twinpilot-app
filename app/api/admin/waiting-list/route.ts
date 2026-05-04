/**
 * GET /api/admin/waiting-list — list all waiting-list sign-ups, newest first
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

async function assertAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") throw new Error("Forbidden");
}

export async function GET(req: NextRequest) {
  try {
    await assertAdmin(req);
    const sb = serviceClient();
    const { data, error } = await sb
      .from("waiting_list")
      .select("*, tenant:tenants!waiting_list_converted_tenant_id_fkey(id, name, slug)")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return NextResponse.json({ leads: data });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}
