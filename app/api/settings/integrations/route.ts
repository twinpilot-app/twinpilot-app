/**
 * POST /api/settings/integrations
 * Saves tenant API keys to tenant_integrations.secret_value (service_role only).
 * Keys are never returned to the browser — RLS blocks all authenticated/anon reads.
 *
 * GET /api/settings/integrations?tenantId=...
 * Returns which (serviceId:keyName) pairs are already configured — no values.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) throw new Error("Supabase service role env vars not set");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function assertMember(req: NextRequest, tenantId: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = getServiceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: member } = await sb.from("tenant_members").select("id").eq("tenant_id", tenantId).eq("user_id", user.id).single();
  if (!member) throw new Error("Forbidden");
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
  if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

  try {
    await assertMember(req, tenantId);
    const sb = getServiceClient();
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
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: msg }, { status: 401 });
    if (msg === "Forbidden")    return NextResponse.json({ error: msg }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/* ─── POST — save keys ─────────────────────────────────────── */

interface SaveBody {
  tenantId: string;
  serviceId: string;
  keys: Record<string, string>;
}

export async function POST(req: NextRequest) {
  let body: SaveBody;
  try {
    body = await req.json() as SaveBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId, serviceId, keys } = body;
  if (!tenantId || !serviceId || !keys || typeof keys !== "object") {
    return NextResponse.json({ error: "tenantId, serviceId and keys are required" }, { status: 400 });
  }

  try {
    await assertMember(req, tenantId);
    const sb = getServiceClient();

    for (const [varName, rawValue] of Object.entries(keys)) {
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
            tenant_id:    tenantId,
            service_id:   serviceId,
            var_name:     varName,
            secret_value: value,
            updated_at:   new Date().toISOString(),
          },
          { onConflict: "tenant_id,service_id,var_name" },
        );

      if (upsertErr) throw new Error(`Save failed: ${upsertErr.message}`);
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: msg }, { status: 401 });
    if (msg === "Forbidden")    return NextResponse.json({ error: msg }, { status: 403 });
    console.error("[settings/integrations] POST error:", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
