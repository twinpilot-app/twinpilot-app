/**
 * Shared auth helper for /api/cli/* endpoints. The CLI passes its
 * TWINPILOT_API_KEY (or the legacy TIRSA_API_KEY — they're the same raw
 * value, only the env var differs on the client) as a Bearer token;
 * this helper looks up the key, resolves tenant + factory scope, and
 * returns a service-role Supabase client the endpoint can use.
 *
 * Scope rules:
 *   - Factory-scoped key: `factoryId` is the key's factory. If the
 *     request tries to operate on a different factory, 403.
 *   - Tenant-wide key: `factoryId` comes from the request (body or
 *     query). If the endpoint needs a factory and none is provided,
 *     callers should reject with 400.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface CliAuthContext {
  sb:        SupabaseClient;
  tenantId:  string;
  factoryId: string | null;
}

export async function authCli(
  req: NextRequest,
  opts?: { requestedFactoryId?: string | null },
): Promise<CliAuthContext | NextResponse> {
  const apiKey = req.headers.get("authorization")?.replace("Bearer ", "")?.trim();
  if (!apiKey) {
    return NextResponse.json({ error: "Missing API key (Authorization: Bearer …)" }, { status: 401 });
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const { data: keyRow } = await sb
    .from("tenant_api_keys")
    .select("tenant_id, factory_id")
    .eq("key", apiKey)
    .maybeSingle();

  if (!keyRow) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

  const tenantId     = keyRow.tenant_id as string;
  const keyFactoryId = (keyRow.factory_id as string | null) ?? null;
  const requested    = opts?.requestedFactoryId ?? null;

  if (keyFactoryId && requested && requested !== keyFactoryId) {
    return NextResponse.json(
      { error: "This API key is scoped to a different factory" },
      { status: 403 },
    );
  }

  const factoryId = keyFactoryId ?? requested;
  return { sb, tenantId, factoryId };
}

/**
 * Resolves the active factory for a CLI request. If `factoryId` is already
 * set (from a factory-scoped key or an explicit request param), returns
 * it. Otherwise falls back to the tenant's default factory (the single
 * factory the tenant has, if any).
 */
export async function requireFactoryId(
  ctx: CliAuthContext,
): Promise<{ factoryId: string } | NextResponse> {
  if (ctx.factoryId) return { factoryId: ctx.factoryId };

  const { data: rows } = await ctx.sb
    .from("factories")
    .select("id")
    .eq("tenant_id", ctx.tenantId);

  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: "Tenant has no factory" }, { status: 400 });
  }
  if (rows.length > 1) {
    return NextResponse.json({
      error: "Multiple factories exist for this tenant; specify factoryId in the request or use a factory-scoped API key",
    }, { status: 400 });
  }
  return { factoryId: rows[0]!.id as string };
}
