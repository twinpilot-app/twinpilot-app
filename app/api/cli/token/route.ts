/**
 * POST /api/cli/token
 * Exchanges an authenticated user session for a CLI token (TIRSA_API_KEY).
 * Called by /cli-auth page after the user confirms.
 *
 * Body: { tenantId: string; factorySlug: string }
 * Auth: Bearer {supabase access token}
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sb = serviceClient();

  // Verify session
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { tenantId, factorySlug } = await req.json() as { tenantId: string; factorySlug: string };
  if (!tenantId || !factorySlug) {
    return NextResponse.json({ error: "tenantId and factorySlug required" }, { status: 400 });
  }

  // Verify membership
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .single();

  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Get tenant + factory slugs
  const [tenantRes, factoryRes] = await Promise.all([
    sb.from("tenants").select("slug").eq("id", tenantId).single(),
    sb.from("factories").select("id, slug").eq("tenant_id", tenantId).eq("slug", factorySlug).single(),
  ]);

  if (!tenantRes.data || !factoryRes.data) {
    return NextResponse.json({ error: "Tenant or factory not found" }, { status: 404 });
  }

  // Get or create API key scoped to the selected factory. The CLI login
  // flow is always a deliberate (tenant, factory) choice, so we bind the
  // key to that factory — tenant-wide keys stay a distinct codepath
  // reachable only from the API Keys page.
  const factoryId = factoryRes.data.id as string;
  const { data: existing } = await sb
    .from("tenant_api_keys")
    .select("key")
    .eq("tenant_id", tenantId)
    .eq("factory_id", factoryId)
    .maybeSingle();

  let apiKey: string;

  if (existing) {
    apiKey = existing.key;
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
    tenantSlug:  tenantRes.data.slug,
    factorySlug: factoryRes.data.slug,
    email:       user.email,
  });
}
