/**
 * POST /api/cli/token
 * Exchanges an authenticated user session for a CLI token (TIRSA_API_KEY).
 * Called by /cli-auth page after the user confirms.
 *
 * Body: validated by CliTokenExchangeSchema.
 * Auth: Bearer {supabase access token}
 */
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { CliTokenExchangeSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { tenantId, factorySlug } = await parseBody(req, CliTokenExchangeSchema);
    const { user, sb } = await getOperatorUser(req);

    // Verify membership
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member) throw new ForbiddenError("Caller is not a member of this tenant");

    // Resolve tenant + factory slugs
    const [tenantRes, factoryRes] = await Promise.all([
      sb.from("tenants").select("slug").eq("id", tenantId).single(),
      sb.from("factories").select("id, slug").eq("tenant_id", tenantId).eq("slug", factorySlug).single(),
    ]);
    if (!tenantRes.data || !factoryRes.data) {
      throw new NotFoundError("Tenant or factory not found");
    }

    // Get or create API key scoped to the selected factory.
    const factoryId = factoryRes.data.id as string;
    const { data: existing } = await sb
      .from("tenant_api_keys")
      .select("key")
      .eq("tenant_id", tenantId)
      .eq("factory_id", factoryId)
      .maybeSingle();

    let apiKey: string;
    if (existing) {
      apiKey = existing.key as string;
    } else {
      const raw     = "sk_live_" + randomBytes(24).toString("hex");
      const preview = "…" + raw.slice(-6);
      await sb.from("tenant_api_keys").insert({
        tenant_id:  tenantId,
        factory_id: factoryId,
        key:        raw,
        preview,
      });
      apiKey = raw;
    }

    return NextResponse.json({
      apiKey,
      tenantSlug:  tenantRes.data.slug as string,
      factorySlug: factoryRes.data.slug as string,
      email:       user.email ?? null,
    });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
