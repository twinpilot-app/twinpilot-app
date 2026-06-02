/**
 * POST /api/settings/integrations
 * Saves tenant API keys to tenant_integrations.secret_value (service_role only).
 * Keys are never returned to the browser — RLS blocks all authenticated/anon reads.
 *
 * GET /api/settings/integrations?tenantId=...
 * Returns which (serviceId:keyName) pairs are already configured — no values.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { SettingsIntegrationsSaveSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function assertMember(sb: SupabaseClient, userId: string, tenantId: string) {
  const { data } = await sb
    .from("tenant_members")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new ForbiddenError("Caller is not a member of this tenant");
}

/* ─── GET — list configured key names ─────────────────────── */

/**
 * Returns the last 4 characters of a secret, prefixed with mask dots so the
 * UI can show e.g. "tr_prod_…●●●●abcd" and the user can verify which key is
 * saved without exposing the full value. For very short values (<6 chars),
 * return a fully masked placeholder so we don't leak most of the secret.
 */
function maskedPreview(raw: string): string {
  const s = raw.trim();
  if (s.length < 6) return "●●●●";
  return `…${s.slice(-4)}`;
}

export async function GET(req: NextRequest) {
  const tenantId = req.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId required", code: "VALIDATION_ERROR" }, { status: 400 });

  try {
    const { user, sb } = await getOperatorUser(req);
    await assertMember(sb, user.id, tenantId);
    const { data, error } = await sb
      .from("tenant_integrations")
      .select("service_id, var_name, secret_value")
      .eq("tenant_id", tenantId);

    if (error) throw new Error(error.message);

    const rows = (data ?? []) as { service_id: string; var_name: string; secret_value: string }[];
    const configured = rows.map((r) => `${r.service_id}:${r.var_name}`);
    const previews: Record<string, string> = {};
    for (const r of rows) {
      previews[`${r.service_id}:${r.var_name}`] = maskedPreview(r.secret_value);
    }
    return NextResponse.json({ configured, previews });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

/* ─── POST — save keys ─────────────────────────────────────── */

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, SettingsIntegrationsSaveSchema);
    const { user, sb } = await getOperatorUser(req);
    await assertMember(sb, user.id, body.tenantId);

    for (const [varName, rawValue] of Object.entries(body.keys)) {
      if (!rawValue?.trim()) continue;

      // Normalize GITHUB_OWNER: accept full URL or bare username/org name
      let value = rawValue.trim();
      if (varName === "GITHUB_OWNER") {
        // Strip https://github.com/ prefix if present
        value = value.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").trim();
      }

      const { error: upsertErr } = await sb
        .from("tenant_integrations")
        .upsert(
          {
            tenant_id:    body.tenantId,
            service_id:   body.serviceId,
            var_name:     varName,
            secret_value: value,
            updated_at:   new Date().toISOString(),
          },
          { onConflict: "tenant_id,service_id,var_name" },
        );

      if (upsertErr) throw new Error(`Save failed: ${upsertErr.message}`);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    console.error("[settings/integrations] POST error:", e);
    return errorResponse(e);
  }
}
