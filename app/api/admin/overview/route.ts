/**
 * GET /api/admin/overview
 * Returns platform-wide stats for the admin dashboard.
 * Requires app_metadata.role === "admin" on the calling user.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const MRR: Record<string, number> = { starter: 0, pro: 79, enterprise: 500, owner: 0 };

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
  return user;
}

export async function GET(req: NextRequest) {
  try {
    await assertAdmin(req);
    const sb = serviceClient();

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [tenantsRes, newTenantsRes, costRes, runsRes] = await Promise.all([
      sb.from("tenants").select("id, plan"),
      sb.from("tenants").select("id").gte("created_at", weekAgo),
      sb.from("agent_runs").select("cost_usd").gte("created_at", monthAgo),
      sb.from("agent_runs").select("id").gte("created_at", monthAgo),
    ]);

    const tenants = tenantsRes.data ?? [];
    const mrr = tenants.reduce((sum, t) => sum + (MRR[t.plan] ?? 0), 0);
    const totalCost = (costRes.data ?? []).reduce((s, r) => s + (r.cost_usd ?? 0), 0);

    // Recent tenants with counts
    const { data: recent } = await sb
      .from("tenants")
      .select("id, name, slug, plan, created_at")
      .order("created_at", { ascending: false })
      .limit(6);

    return NextResponse.json({
      totalTenants:   tenants.length,
      newThisWeek:    (newTenantsRes.data ?? []).length,
      mrr,
      costThisMonth:  totalCost,
      runsThisMonth:  (runsRes.data ?? []).length,
      recentTenants:  recent ?? [],
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}
