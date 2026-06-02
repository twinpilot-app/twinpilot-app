/**
 * GET  /api/admin/config  — list all known admin config keys with masked values
 * PUT  /api/admin/config  — upsert { key, value } (empty value = delete)
 *
 * Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getAdminConfigs,
  setAdminConfig,
  deleteAdminConfig,
  maskSecret,
  type AdminConfigKey,
} from "@/lib/admin-config";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody, serviceClient,
} from "@/lib/api-helpers";
import { AdminConfigPutSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

const KNOWN_KEYS: AdminConfigKey[] = [
  "VERCEL_TOKEN",
  "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID",
  "VERCEL_DEPLOY_HOOK_URL",
  "GITHUB_ADMIN_TOKEN",
  "PUSH_VIA_TRIGGER",
];

async function assertPlatformAdmin(req: NextRequest) {
  const { user } = await getOperatorUser(req);
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") {
    throw new ForbiddenError("Caller is not a platform admin");
  }
  return user;
}

export async function GET(req: NextRequest) {
  try {
    await assertPlatformAdmin(req);

    // Also fetch which keys are stored in DB (vs env var fallback)
    const sb = serviceClient();
    const { data: dbRows } = await sb
      .from("admin_config")
      .select("key, updated_at, updated_by")
      .in("key", KNOWN_KEYS);

    const dbMeta: Record<string, { updatedAt: string; updatedBy: string | null }> = {};
    for (const row of dbRows ?? []) {
      dbMeta[row.key as string] = { updatedAt: row.updated_at as string, updatedBy: row.updated_by as string | null };
    }

    const values = await getAdminConfigs(KNOWN_KEYS);

    const config = KNOWN_KEYS.map((key) => ({
      key,
      set:       !!values[key],
      inDb:      !!dbMeta[key],
      preview:   maskSecret(values[key]),
      updatedAt: dbMeta[key]?.updatedAt ?? null,
    }));

    return NextResponse.json({ config });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await parseBody(req, AdminConfigPutSchema);
    const user = await assertPlatformAdmin(req);

    if (!KNOWN_KEYS.includes(body.key as AdminConfigKey)) {
      throw new ValidationError(`Unknown config key: ${body.key}`, []);
    }

    if (!body.value || body.value.trim() === "") {
      await deleteAdminConfig(body.key as AdminConfigKey);
      return NextResponse.json({ ok: true, deleted: true });
    }

    await setAdminConfig(body.key as AdminConfigKey, body.value.trim(), user.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
