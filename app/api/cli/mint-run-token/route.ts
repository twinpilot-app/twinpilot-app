/**
 * POST /api/cli/mint-run-token
 *
 * Exchanges a TIRSA_API_KEY for a short-lived tenant-scoped Supabase JWT
 * that the CLI uses to install its AsyncLocalStorage scope.
 *
 * Auth: `Authorization: Bearer <TIRSA_API_KEY>`
 * Body: validated by CliMintRunTokenSchema (factoryId? + ttlSeconds?)
 * Returns: { token, expiresAt, tenantId, factoryId?, supabaseUrl }
 */
import { NextRequest, NextResponse } from "next/server";
import { mintWorkerToken } from "@/lib/worker-jwt";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  errorResponse, parseBody, serviceClient,
} from "@/lib/api-helpers";
import { CliMintRunTokenSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const apiKey = req.headers.get("authorization")?.replace("Bearer ", "")?.trim();
    if (!apiKey) {
      throw new AuthError("Missing TIRSA_API_KEY (Authorization: Bearer …)");
    }

    const body = await parseBody(req, CliMintRunTokenSchema);
    const sb = serviceClient();

    // Look up API key → tenant + (optional) factory scope
    const { data: keyRow, error: keyErr } = await sb
      .from("tenant_api_keys")
      .select("tenant_id, factory_id")
      .eq("key", apiKey)
      .maybeSingle();
    if (keyErr || !keyRow) throw new AuthError("Invalid TIRSA_API_KEY");
    const tenantId = keyRow.tenant_id as string;
    const keyFactoryId = (keyRow.factory_id as string | null) ?? null;

    const requestedFactoryId = body.factoryId ?? null;

    // Scope enforcement.
    if (keyFactoryId && requestedFactoryId && requestedFactoryId !== keyFactoryId) {
      throw new ForbiddenError("This API key is scoped to a different factory");
    }
    const factoryId = requestedFactoryId ?? keyFactoryId;

    if (factoryId) {
      const { data: factory } = await sb
        .from("factories")
        .select("tenant_id")
        .eq("id", factoryId)
        .maybeSingle();
      if (!factory || factory.tenant_id !== tenantId) {
        throw new ValidationError("Factory does not belong to tenant", []);
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
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
