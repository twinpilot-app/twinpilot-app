/**
 * GET    /api/admin/tenants/[id] — tenant detail
 * PATCH  /api/admin/tenants/[id] — update plan or suspended status
 * DELETE /api/admin/tenants/[id] — permanently delete tenant + auth users
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

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertAdmin(req);
    const sb = serviceClient();
    const { id } = await params;

    const [tenantRes, membersRes, factoriesRes] = await Promise.all([
      sb.from("tenants").select("*").eq("id", id).single(),
      sb.from("tenant_members").select("*").eq("tenant_id", id),
      sb.from("factories").select("*").eq("tenant_id", id),
    ]);

    if (tenantRes.error) throw new Error(tenantRes.error.message);

    // Projects across all factories
    const factoryIds = (factoriesRes.data ?? []).map((f) => f.id);
    const { data: projects } = factoryIds.length
      ? await sb.from("projects").select("*").in("factory_id", factoryIds)
      : { data: [] };

    // Agent runs with cost
    const projectIds = (projects ?? []).map((p) => p.id);
    const { data: runs } = projectIds.length
      ? await sb.from("agent_runs")
          .select("id, agent, status, cost_usd, started_at, finished_at, project_id")
          .in("project_id", projectIds)
          .order("started_at", { ascending: false })
          .limit(50)
      : { data: [] };

    const totalCost = (runs ?? []).reduce((s, r) => s + (r.cost_usd ?? 0), 0);

    // Enrich members with email from Auth
    const memberList = membersRes.data ?? [];
    const enrichedMembers = [];
    for (const m of memberList) {
      const { data: { user: authUser } } = await sb.auth.admin.getUserById(m.user_id as string);
      enrichedMembers.push({ ...m, email: authUser?.email ?? null });
    }

    return NextResponse.json({
      tenant:    tenantRes.data,
      members:   enrichedMembers,
      factories: factoriesRes.data ?? [],
      projects:  projects ?? [],
      recentRuns: runs ?? [],
      totalCost,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertAdmin(req);
    const sb = serviceClient();
    const body = await req.json() as { plan?: string; suspended?: boolean; resetPassword?: { userId: string; newPassword: string } };
    const { id } = await params;

    // Password reset for a tenant member
    if (body.resetPassword) {
      const { userId, newPassword } = body.resetPassword;
      if (!newPassword || newPassword.length < 8) {
        return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
      }
      // Verify user belongs to this tenant
      const { data: membership } = await sb.from("tenant_members").select("id").eq("tenant_id", id).eq("user_id", userId).maybeSingle();
      if (!membership) {
        return NextResponse.json({ error: "User not found in this tenant" }, { status: 404 });
      }
      const { data: updatedUser, error: resetErr } = await sb.auth.admin.updateUserById(userId, { password: newPassword });
      if (resetErr) throw new Error(resetErr.message);
      if (!updatedUser?.user) throw new Error("Password update returned no user");
      return NextResponse.json({ ok: true, message: "Password reset successfully", updatedUserId: updatedUser.user.id });
    }

    const update: Record<string, unknown> = {};
    if (body.plan      !== undefined) update.plan      = body.plan;
    if (body.suspended !== undefined) update.suspended = body.suspended;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const { error } = await sb.from("tenants").update(update).eq("id", id);
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertAdmin(req);
    const sb = serviceClient();
    const { id } = await params;

    // Collect user IDs that belong exclusively to this tenant (no other memberships)
    const { data: members } = await sb
      .from("tenant_members")
      .select("user_id")
      .eq("tenant_id", id);

    const userIds = (members ?? []).map((m) => m.user_id as string);

    // Find users that belong ONLY to this tenant (safe to delete from auth)
    const exclusiveUsers: string[] = [];
    for (const uid of userIds) {
      const { count } = await sb
        .from("tenant_members")
        .select("*", { count: "exact", head: true })
        .eq("user_id", uid)
        .neq("tenant_id", id);
      if (count === 0) exclusiveUsers.push(uid);
    }

    // Get tenant info before deletion for notification
    const { data: tenantInfo } = await sb.from("tenants").select("name, slug").eq("id", id).single();

    // Delete tenant (cascades to tenant_members, factories, projects, agent_runs via FK)
    const { error: delErr } = await sb.from("tenants").delete().eq("id", id);
    if (delErr) throw new Error(delErr.message);

    // Delete auth users that had no other tenant
    for (const uid of exclusiveUsers) {
      await sb.auth.admin.deleteUser(uid);
    }

    // Notify owner
    try {
      const { createNotification } = await import("@/lib/notifications");
      const { data: owner } = await sb.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
      if (owner) await createNotification({ tenantId: owner.id, eventType: "tenant_deleted", severity: "warning", title: `Tenant deleted: ${tenantInfo?.name ?? id}`, body: `${tenantInfo?.slug ?? ""} · ${exclusiveUsers.length} auth users removed` });
    } catch { /* non-blocking */ }

    return NextResponse.json({ ok: true, deletedAuthUsers: exclusiveUsers.length });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}
