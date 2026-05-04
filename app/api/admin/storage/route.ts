/**
 * GET /api/admin/storage
 *
 * Returns the platform DB-usage breakdown the admin panel renders.
 * Wraps the admin_storage_usage() RPC (migration 176): total bytes,
 * per-table sizes, per-tenant row counts.
 *
 * Auth: app_metadata.role === "admin" — same gate every other admin
 * endpoint uses. The RPC itself runs SECURITY DEFINER, so the caller's
 * role doesn't need direct SELECT on pg_* catalog views.
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
    const { data, error } = await sb.rpc("admin_storage_usage");
    if (error) throw new Error(error.message);
    return NextResponse.json(data ?? {});
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
