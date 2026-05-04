/**
 * POST /api/cli/mint-run-token
 *
 * Exchanges a TIRSA_API_KEY for a short-lived tenant-scoped Supabase JWT
 * that the CLI uses to install its AsyncLocalStorage scope. Same
 * underlying mint helper as /api/worker/mint-token, but authenticated by
 * the user's API key instead of the platform service_role.
 *
 * This is the CLI's only bridge to the platform: once it has this JWT,
 * every downstream Supabase query goes through RLS and CLI-side code
 * never needs SUPABASE_SERVICE_ROLE_KEY.
 *
 * Auth: `Authorization: Bearer <TIRSA_API_KEY>`
 * Body: { factoryId?: string; ttlSeconds?: number }
 * Returns: { token, expiresAt, tenantId, factoryId?, supabaseUrl }
 *
 * Rate limiting is the next step (Stage 5 follow-up) — this endpoint is
 * intentionally open to valid API keys for now so the CLI can mint on
 * every command invocation without caching logic.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { mintWorkerToken } from "@/lib/worker-jwt";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("authorization")?.replace("Bearer ", "")?.trim();
    if (!apiKey) {
      return NextResponse.json({ error: "Missing TIRSA_API_KEY (Authorization: Bearer …)" }, { status: 401 });
    }

    const sb = serviceClient();

    // Look up API key → tenant + (optional) factory scope
    const { data: keyRow, error: keyErr } = await sb
      .from("tenant_api_keys")
      .select("tenant_id, factory_id")
      .eq("key", apiKey)
      .maybeSingle();
    if (keyErr || !keyRow) {
      return NextResponse.json({ error: "Invalid TIRSA_API_KEY" }, { status: 401 });
    }
    const tenantId = keyRow.tenant_id as string;
    const keyFactoryId = (keyRow.factory_id as string | null) ?? null;

    const body = (await req.json().catch(() => ({}))) as {
      factoryId?: string;
      ttlSeconds?: number;
    };
    const requestedFactoryId = body.factoryId?.trim() || null;

    // Scope enforcement: a factory-scoped key can only mint for its own
    // factory; a tenant-wide key can mint for any factory in the tenant
    // (or tenant-wide). requestedFactoryId must still belong to the tenant.
    if (keyFactoryId) {
      if (requestedFactoryId && requestedFactoryId !== keyFactoryId) {
        return NextResponse.json(
          { error: "This API key is scoped to a different factory" },
          { status: 403 },
        );
      }
    }
    const factoryId = requestedFactoryId ?? keyFactoryId;

    if (factoryId) {
      const { data: factory } = await sb
        .from("factories")
        .select("tenant_id")
        .eq("id", factoryId)
        .maybeSingle();
      if (!factory || factory.tenant_id !== tenantId) {
        return NextResponse.json({ error: "Factory does not belong to tenant" }, { status: 400 });
      }
    }

    const result = mintWorkerToken({
      tenantId,
      factoryId,
      ttlSeconds: body.ttlSeconds,
    });

    return NextResponse.json({
      ...result,
      supabaseUrl:     process.env.NEXT_PUBLIC_SUPABASE_URL,
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
