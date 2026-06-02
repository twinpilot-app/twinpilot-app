/**
 * POST /api/admin/redeploy
 *
 * Triggers a Vercel redeploy via the configured deploy hook URL.
 * Hook URL is read from admin_config in Supabase.
 * Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAdminConfig } from "@/lib/admin-config";
import { brand } from "@/lib/brand";

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

    const hookUrl = await getAdminConfig("VERCEL_DEPLOY_HOOK_URL");
    if (!hookUrl) {
      return NextResponse.json(
        { error: "VERCEL_DEPLOY_HOOK_URL is not configured. Add it in Admin → Integrations." },
        { status: 422 },
      );
    }

    const res = await fetch(hookUrl, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Deploy hook returned ${res.status}: ${body}`);
    }

    // Notify owner (platform ops)
    try {
      const { createNotification } = await import("@/lib/notifications");
      const sc = serviceClient();
      const { data: owner } = await sc.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
      if (owner) await createNotification({ tenantId: owner.id, eventType: "deploy_command_center", severity: "info", title: "Command Center redeployed", body: "Vercel deploy hook triggered" });
      // Notify all tenants about platform update
      const { data: tenants } = await sc.from("tenants").select("id");
      for (const t of tenants ?? []) {
        createNotification({ tenantId: t.id, eventType: "platform_update", severity: "info", title: "Platform updated", body: `${brand.name} has been updated with the latest version` }).catch(() => {});
      }
    } catch { /* non-blocking */ }

    return NextResponse.json({ ok: true, triggered: new Date().toISOString() });

  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized" || msg === "Forbidden")
      return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
