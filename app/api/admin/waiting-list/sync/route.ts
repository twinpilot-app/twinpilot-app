/**
 * POST /api/admin/waiting-list/sync
 *
 * Reconciles pending waiting_list leads with existing tenants. For every lead
 * with converted_at IS NULL, looks up an auth user with the same email that
 * already has a tenant_members row and stamps the lead as converted.
 *
 * Idempotent — safe to call repeatedly. Used to backfill leads that existed
 * before migration 087 (conversion tracking) and to correct drift.
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

export async function POST(req: NextRequest) {
  try {
    await assertAdmin(req);
    const sb = serviceClient();

    const { data: pending, error: pendErr } = await sb
      .from("waiting_list")
      .select("id, email")
      .is("converted_at", null);
    if (pendErr) throw new Error(pendErr.message);
    if (!pending || pending.length === 0) {
      return NextResponse.json({ updated: 0, scanned: 0 });
    }

    // Fetch all auth users (paginated) into an email → id map.
    const emailToUser = new Map<string, string>();
    let page = 1;
    const perPage = 1000;
    while (true) {
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
      if (error) throw new Error(error.message);
      for (const u of data.users) {
        if (u.email) emailToUser.set(u.email.toLowerCase(), u.id);
      }
      if (data.users.length < perPage) break;
      page++;
    }

    // Fetch tenant memberships — first row per user_id wins (earliest join).
    const { data: members, error: mErr } = await sb
      .from("tenant_members")
      .select("user_id, tenant_id, created_at")
      .order("created_at", { ascending: true });
    if (mErr) throw new Error(mErr.message);

    const userToMembership = new Map<string, { tenant_id: string; created_at: string }>();
    for (const m of members ?? []) {
      if (!userToMembership.has(m.user_id)) {
        userToMembership.set(m.user_id, { tenant_id: m.tenant_id, created_at: m.created_at });
      }
    }

    let updated = 0;
    for (const lead of pending) {
      const userId = emailToUser.get(lead.email.toLowerCase());
      if (!userId) continue;
      const membership = userToMembership.get(userId);
      if (!membership) continue;
      const { error: uErr } = await sb
        .from("waiting_list")
        .update({
          converted_at: membership.created_at,
          converted_tenant_id: membership.tenant_id,
        })
        .eq("id", lead.id);
      if (!uErr) updated++;
    }

    return NextResponse.json({ updated, scanned: pending.length });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}
