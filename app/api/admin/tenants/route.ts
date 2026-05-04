/**
 * GET /api/admin/tenants
 * Returns all tenants with aggregated stats.
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

    const { data: tenants, error } = await sb
      .from("tenants")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    // Aggregate member count, factory count, cost per tenant
    const [membersRes, factoriesRes, projectsRes, runsRes] = await Promise.all([
      sb.from("tenant_members").select("tenant_id"),
      sb.from("factories").select("tenant_id"),
      sb.from("projects").select("factory_id, factories!inner(tenant_id)"),
      sb.from("agent_runs").select("cost_usd, projects!inner(factory_id, factories!inner(tenant_id))"),
    ]);

    const memberCount: Record<string, number>  = {};
    const factoryCount: Record<string, number> = {};
    const projectCount: Record<string, number> = {};
    const costTotal: Record<string, number>    = {};

    for (const m of membersRes.data ?? [])   memberCount[m.tenant_id]  = (memberCount[m.tenant_id]  ?? 0) + 1;
    for (const f of factoriesRes.data ?? []) factoryCount[f.tenant_id] = (factoryCount[f.tenant_id] ?? 0) + 1;

    for (const p of projectsRes.data ?? []) {
      const tid = (p as unknown as { factories: { tenant_id: string } }).factories.tenant_id;
      projectCount[tid] = (projectCount[tid] ?? 0) + 1;
    }

    for (const r of runsRes.data ?? []) {
      const tid = (r as unknown as { projects: { factories: { tenant_id: string } } }).projects.factories.tenant_id;
      costTotal[tid] = (costTotal[tid] ?? 0) + (r.cost_usd ?? 0);
    }

    const result = (tenants ?? []).map((t) => ({
      ...t,
      member_count:  memberCount[t.id]  ?? 0,
      factory_count: factoryCount[t.id] ?? 0,
      project_count: projectCount[t.id] ?? 0,
      cost_usd:      costTotal[t.id]    ?? 0,
    }));

    return NextResponse.json({ tenants: result });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}
