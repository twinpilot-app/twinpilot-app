/**
 * GET  /api/admin/config  — list all known admin config keys with masked values
 * PUT  /api/admin/config  — upsert { key, value } (empty value = delete)
 *
 * Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  getAdminConfigs,
  setAdminConfig,
  deleteAdminConfig,
  maskSecret,
  type AdminConfigKey,
} from "@/lib/admin-config";

export const dynamic = "force-dynamic";

const KNOWN_KEYS: AdminConfigKey[] = [
  "VERCEL_TOKEN",
  "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID",
  "VERCEL_DEPLOY_HOOK_URL",
  "GITHUB_ADMIN_TOKEN",
  "PUSH_VIA_TRIGGER",
];

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

    // Also fetch which keys are stored in DB (vs env var fallback)
    const sb = serviceClient();
    const { data: dbRows } = await sb
      .from("admin_config")
      .select("key, updated_at, updated_by")
      .in("key", KNOWN_KEYS);

    const dbMeta: Record<string, { updatedAt: string; updatedBy: string | null }> = {};
    for (const row of dbRows ?? []) {
      dbMeta[row.key] = { updatedAt: row.updated_at, updatedBy: row.updated_by };
    }

    const values = await getAdminConfigs(KNOWN_KEYS);

    const config = KNOWN_KEYS.map((key) => ({
      key,
      set: !!values[key],
      inDb: !!dbMeta[key],
      preview: maskSecret(values[key]),
      updatedAt: dbMeta[key]?.updatedAt ?? null,
    }));

    return NextResponse.json({ config });

  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized" || msg === "Forbidden")
      return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await assertAdmin(req);

    const body = await req.json() as { key: string; value: string };
    const { key, value } = body;

    if (!KNOWN_KEYS.includes(key as AdminConfigKey)) {
      return NextResponse.json({ error: `Unknown config key: ${key}` }, { status: 400 });
    }

    if (!value || value.trim() === "") {
      await deleteAdminConfig(key as AdminConfigKey);
      return NextResponse.json({ ok: true, deleted: true });
    }

    await setAdminConfig(key as AdminConfigKey, value.trim(), user.id);
    return NextResponse.json({ ok: true });

  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized" || msg === "Forbidden")
      return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
