/**
 * POST /api/worker/mint-token
 *
 * Server-to-server endpoint that mints a short-lived tenant-scoped JWT
 * for a worker run. The same minting logic is used internally by the
 * sprint dispatcher; this endpoint exists for ad-hoc diagnostics and
 * for workers that run outside our dispatch path and need to request
 * their own token.
 *
 * Body: { tenantId: string; factoryId?: string; ttlSeconds?: number }
 * Returns: { token, expiresAt, tenantId, factoryId }
 *
 * Authorization: caller must present SUPABASE_SERVICE_ROLE_KEY in
 * the Authorization header. Never exposed to the browser.
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

function assertServerSideCaller(req: NextRequest) {
  const header = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!header || header !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Unauthorized");
  }
}

export async function POST(req: NextRequest) {
  try {
    assertServerSideCaller(req);

    const body = (await req.json()) as {
      tenantId?: string;
      factoryId?: string;
      ttlSeconds?: number;
    };
    const tenantId = body.tenantId?.trim();
    const factoryId = body.factoryId?.trim() ?? null;

    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    // Sanity: tenant exists; factory (if given) belongs to the tenant.
    const sb = serviceClient();
    const { data: tenant } = await sb.from("tenants").select("id").eq("id", tenantId).maybeSingle();
    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

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

    const result = mintWorkerToken({ tenantId, factoryId, ttlSeconds: body.ttlSeconds });
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}
