/**
 * GET    /api/settings/apikey?tenantId=… — returns { keys: [{ id, preview, factory_id, factory_name?, created_at, name? }, …] }
 * POST   /api/settings/apikey             — body { tenantId, factoryId?, name? } — regenerates the key for that scope, returns it ONCE
 * DELETE /api/settings/apikey?id=…&tenantId=… — revokes a specific key
 *
 * Scope rules:
 *   - factoryId === null (omitted) → tenant-wide key (one per tenant)
 *   - factoryId === <uuid>          → factory-scoped key (one per tenant/factory)
 * POST with an existing scope replaces the prior key.
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

async function assertMember(sb: ReturnType<typeof serviceClient>, token: string, tenantId: string) {
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data } = await sb.from("tenant_members").select("role").eq("tenant_id", tenantId).eq("user_id", user.id).single();
  if (!data) throw new Error("Forbidden");
}

async function assertFactoryInTenant(sb: ReturnType<typeof serviceClient>, tenantId: string, factoryId: string) {
  const { data } = await sb.from("factories").select("id").eq("id", factoryId).eq("tenant_id", tenantId).maybeSingle();
  if (!data) throw new Error("Factory does not belong to tenant");
}

function unauthorized(e: unknown) {
  const msg = (e as Error).message;
  return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : msg.includes("Factory") ? 400 : 401 });
}

/* ── GET: list keys ── */
export async function GET(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = req.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

  const sb = serviceClient();
  try { await assertMember(sb, token, tenantId); } catch (e) { return unauthorized(e); }

  const { data: keys } = await sb
    .from("tenant_api_keys")
    .select("id, preview, factory_id, name, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  const factoryIds = Array.from(new Set((keys ?? []).map((k) => k.factory_id).filter((x): x is string => !!x)));
  let factoryNames: Record<string, string> = {};
  if (factoryIds.length > 0) {
    const { data: factories } = await sb.from("factories").select("id, name, slug").in("id", factoryIds);
    factoryNames = Object.fromEntries((factories ?? []).map((f) => [f.id, f.name]));
  }

  return NextResponse.json({
    keys: (keys ?? []).map((k) => ({
      id:           k.id,
      preview:      k.preview,
      factory_id:   k.factory_id,
      factory_name: k.factory_id ? (factoryNames[k.factory_id] ?? null) : null,
      name:         k.name,
      created_at:   k.created_at,
    })),
  });
}

/* ── POST: regenerate for a scope ── */
export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json()) as { tenantId: string; factoryId?: string | null; name?: string | null };
  const tenantId  = body.tenantId;
  const factoryId = body.factoryId?.trim() || null;
  const name      = body.name?.trim() || null;
  if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

  const sb = serviceClient();
  try {
    await assertMember(sb, token, tenantId);
    if (factoryId) await assertFactoryInTenant(sb, tenantId, factoryId);
  } catch (e) { return unauthorized(e); }

  const raw     = "sk_live_" + randomBytes(24).toString("hex");
  const preview = "…" + raw.slice(-6);

  // Delete existing key for this exact scope (one key per scope), then insert.
  let deleteQuery = sb.from("tenant_api_keys").delete().eq("tenant_id", tenantId);
  deleteQuery = factoryId ? deleteQuery.eq("factory_id", factoryId) : deleteQuery.is("factory_id", null);
  await deleteQuery;

  const { data: inserted, error } = await sb
    .from("tenant_api_keys")
    .insert({ tenant_id: tenantId, factory_id: factoryId, key: raw, preview, name })
    .select("id")
    .single();
  if (error || !inserted) return NextResponse.json({ error: error?.message ?? "insert failed" }, { status: 500 });

  return NextResponse.json({ id: inserted.id, key: raw, preview, factory_id: factoryId, name });
}

/* ── DELETE: revoke a specific key ── */
export async function DELETE(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id       = req.nextUrl.searchParams.get("id");
  const tenantId = req.nextUrl.searchParams.get("tenantId");
  if (!id || !tenantId) return NextResponse.json({ error: "id and tenantId required" }, { status: 400 });

  const sb = serviceClient();
  try { await assertMember(sb, token, tenantId); } catch (e) { return unauthorized(e); }

  // Scope the delete by tenant to guard against cross-tenant revocation.
  const { error } = await sb.from("tenant_api_keys").delete().eq("id", id).eq("tenant_id", tenantId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
