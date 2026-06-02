/**
 * GET /api/admin/rls
 *
 * Returns the RLS audit overview: every declared table (from
 * rls_audit_metadata) joined with pg_catalog info about whether RLS is
 * enabled and how many policies exist per operation. Admins use this to
 * confirm the tenant isolation contract is still intact after migrations.
 *
 * Returns: {
 *   tables: [{
 *     table_name, scope, isolation, notes,
 *     rls_enabled, policies: { select: N, insert: N, update: N, delete: N, all: N }
 *   }]
 * }
 *
 * Authorization: caller must have app_metadata.role === 'admin'.
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
  return sb;
}

type PolicyRow = {
  tablename: string;
  policyname: string;
  cmd: string | null; // ALL, SELECT, INSERT, UPDATE, DELETE
  qual: string | null;
  with_check: string | null;
};

type ClassRow = {
  relname: string;
  relrowsecurity: boolean;
};

export async function GET(req: NextRequest) {
  try {
    const sb = await assertAdmin(req);

    const { data: meta, error: mErr } = await sb
      .from("rls_audit_metadata")
      .select("table_name, scope, isolation, notes, updated_at")
      .order("scope", { ascending: true })
      .order("table_name", { ascending: true });
    if (mErr) throw new Error(mErr.message);

    // Reflect RLS enabled per table
    const { data: classes } = await sb
      .rpc("rls_audit_class_info", {});
    const classMap = new Map<string, boolean>();
    for (const row of ((classes ?? []) as ClassRow[])) {
      classMap.set(row.relname, row.relrowsecurity);
    }

    // Reflect policies per table
    const { data: policies } = await sb.rpc("rls_audit_policies", {});
    const policyByTable = new Map<string, Record<string, number>>();
    for (const p of ((policies ?? []) as PolicyRow[])) {
      const op = (p.cmd ?? "ALL").toLowerCase();
      const current = policyByTable.get(p.tablename) ?? {};
      current[op] = (current[op] ?? 0) + 1;
      policyByTable.set(p.tablename, current);
    }

    const tables = (meta ?? []).map((m) => ({
      ...m,
      rls_enabled: classMap.get(m.table_name) ?? null,
      policies: policyByTable.get(m.table_name) ?? {},
    }));

    return NextResponse.json({ tables });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : msg === "Unauthorized" ? 401 : 500 });
  }
}
