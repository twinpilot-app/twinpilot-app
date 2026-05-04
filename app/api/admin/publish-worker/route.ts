/**
 * POST /api/admin/publish-worker
 *
 * Triggers the publish-worker.yml GitHub Actions workflow via workflow_dispatch.
 * Token is read from admin_config in Supabase (requires `workflow` scope).
 * Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAdminConfig } from "@/lib/admin-config";
import { brand } from "@/lib/brand";

export const dynamic = "force-dynamic";

const GH_REPO  = "tirsasoftware/tirsa-factory";
const WORKFLOW = "publish-worker.yml";

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

    const ghToken = await getAdminConfig("GITHUB_ADMIN_TOKEN");
    if (!ghToken) {
      return NextResponse.json(
        { error: "GITHUB_ADMIN_TOKEN is not configured. Add it in Admin → Integrations." },
        { status: 422 },
      );
    }

    const res = await fetch(
      `https://api.github.com/repos/${GH_REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );

    if (res.status === 204) {
      try {
        const { createNotification } = await import("@/lib/notifications");
        const sc = serviceClient();
        const { data: owner } = await sc.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
        if (owner) await createNotification({ tenantId: owner.id, eventType: "deploy_workers", severity: "info", title: "Worker publish triggered", body: "GitHub Actions workflow dispatched" });
        // Notify all tenants about worker update
        const { data: tenants } = await sc.from("tenants").select("id");
        for (const t of tenants ?? []) {
          createNotification({ tenantId: t.id, eventType: "worker_update", severity: "info", title: "Worker update available", body: `Run ${brand.cli.packageName} init to update your local worker` }).catch(() => {});
        }
      } catch { /* non-blocking */ }
      return NextResponse.json({ ok: true, triggered: new Date().toISOString() });
    }

    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `GitHub API returned ${res.status}`);

  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized" || msg === "Forbidden")
      return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
