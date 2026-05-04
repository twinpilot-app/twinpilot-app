import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const serviceClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const BYPASS_COOKIE  = "tirsa_maint_bypass";
const BYPASS_MAX_AGE = 60 * 60 * 24; // 24 h

/** Verify the caller is authenticated and is an owner in tenant_members. */
async function getOwnerUserId(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);

  // Verify token via Supabase auth (getUser checks it server-side)
  const userClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const { data: { user }, error } = await userClient.auth.getUser(token);
  if (error || !user) return null;

  const { data: member } = await serviceClient
    .from("tenant_members")
    .select("role")
    .eq("user_id", user.id)
    .single();

  return member?.role === "platform_admin" ? user.id : null;
}

/** GET /api/admin/maintenance — returns current status (owner only). */
export async function GET(req: NextRequest) {
  const userId = await getOwnerUserId(req);
  if (!userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data } = await serviceClient
    .from("platform_config")
    .select("maintenance_mode, maintenance_since, maintenance_by")
    .eq("id", "singleton")
    .single();

  return NextResponse.json({
    maintenanceMode: data?.maintenance_mode ?? false,
    since:           data?.maintenance_since ?? null,
    by:              data?.maintenance_by ?? null,
  });
}

/** POST /api/admin/maintenance — enable or disable (owner only).
 *  Body: { action: "enable" | "disable" }
 */
export async function POST(req: NextRequest) {
  const userId = await getOwnerUserId(req);
  if (!userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json() as { action: "enable" | "disable" };

  if (body.action === "enable") {
    const bypass = randomUUID();

    await serviceClient
      .from("platform_config")
      .update({
        maintenance_mode:  true,
        maintenance_since: new Date().toISOString(),
        maintenance_by:    userId,
        bypass_token:      bypass,
      })
      .eq("id", "singleton");

    try {
      const { createNotification } = await import("@/lib/notifications");
      const { data: owner } = await serviceClient.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
      if (owner) await createNotification({ tenantId: owner.id, eventType: "platform_instability", severity: "critical", title: "Maintenance mode enabled", body: "Platform is now in maintenance mode" });
    } catch { /* non-blocking */ }

    const res = NextResponse.json({ ok: true, maintenanceMode: true });
    res.cookies.set(BYPASS_COOKIE, bypass, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      path:     "/",
      maxAge:   BYPASS_MAX_AGE,
      sameSite: "lax",
    });
    return res;
  }

  if (body.action === "disable") {
    await serviceClient
      .from("platform_config")
      .update({
        maintenance_mode:  false,
        maintenance_since: null,
        maintenance_by:    null,
        bypass_token:      null,
      })
      .eq("id", "singleton");

    try {
      const { createNotification } = await import("@/lib/notifications");
      const { data: owner } = await serviceClient.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
      if (owner) await createNotification({ tenantId: owner.id, eventType: "platform_update", severity: "info", title: "Maintenance mode disabled", body: "Platform is back online" });
    } catch { /* non-blocking */ }

    const res = NextResponse.json({ ok: true, maintenanceMode: false });
    res.cookies.delete(BYPASS_COOKIE);
    return res;
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
