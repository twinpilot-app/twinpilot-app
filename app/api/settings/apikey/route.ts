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
import { randomBytes } from "crypto";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { SettingsApiKeyCreateSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function assertMember(sb: SupabaseClient, userId: string, tenantId: string) {
  const { data } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle();
  if (!data) throw new ForbiddenError("Caller is not a member of this tenant");
}

async function assertFactoryInTenant(sb: SupabaseClient, tenantId: string, factoryId: string) {
  const { data } = await sb
    .from("factories").select("id")
    .eq("id", factoryId).eq("tenant_id", tenantId).maybeSingle();
  if (!data) throw new ValidationError("Factory does not belong to tenant", []);
}

/* ── GET: list keys ── */
export async function GET(req: NextRequest) {
  try {
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId required", code: "VALIDATION_ERROR" }, { status: 400 });
    }
    const { user, sb } = await getOperatorUser(req);
    await assertMember(sb, user.id, tenantId);

    const { data: keys } = await sb
      .from("tenant_api_keys")
      .select("id, preview, factory_id, name, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });

    const factoryIds = Array.from(new Set((keys ?? []).map((k) => k.factory_id).filter((x): x is string => !!x)));
    let factoryNames: Record<string, string> = {};
    if (factoryIds.length > 0) {
      const { data: factories } = await sb.from("factories").select("id, name, slug").in("id", factoryIds);
      factoryNames = Object.fromEntries((factories ?? []).map((f) => [f.id as string, f.name as string]));
    }

    return NextResponse.json({
      keys: (keys ?? []).map((k) => ({
        id:           k.id,
        preview:      k.preview,
        factory_id:   k.factory_id,
        factory_name: k.factory_id ? (factoryNames[k.factory_id as string] ?? null) : null,
        name:         k.name,
        created_at:   k.created_at,
      })),
    });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

/* ── POST: regenerate for a scope ── */
export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, SettingsApiKeyCreateSchema);
    const { user, sb } = await getOperatorUser(req);
    await assertMember(sb, user.id, body.tenantId);

    const factoryId = body.factoryId?.trim() || null;
    const name      = body.name?.trim() || null;
    if (factoryId) await assertFactoryInTenant(sb, body.tenantId, factoryId);

    const raw     = "sk_live_" + randomBytes(24).toString("hex");
    const preview = "…" + raw.slice(-6);

    // Delete existing key for this exact scope (one key per scope), then insert.
    let deleteQuery = sb.from("tenant_api_keys").delete().eq("tenant_id", body.tenantId);
    deleteQuery = factoryId ? deleteQuery.eq("factory_id", factoryId) : deleteQuery.is("factory_id", null);
    await deleteQuery;

    const { data: inserted, error } = await sb
      .from("tenant_api_keys")
      .insert({ tenant_id: body.tenantId, factory_id: factoryId, key: raw, preview, name })
      .select("id")
      .single();
    if (error || !inserted) throw new Error(error?.message ?? "insert failed");

    return NextResponse.json({ id: inserted.id, key: raw, preview, factory_id: factoryId, name });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

/* ── DELETE: revoke a specific key ── */
export async function DELETE(req: NextRequest) {
  try {
    const id       = req.nextUrl.searchParams.get("id");
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!id || !tenantId) {
      return NextResponse.json({ error: "id and tenantId required", code: "VALIDATION_ERROR" }, { status: 400 });
    }
    const { user, sb } = await getOperatorUser(req);
    await assertMember(sb, user.id, tenantId);

    // Scope the delete by tenant to guard against cross-tenant revocation.
    const { error } = await sb.from("tenant_api_keys").delete().eq("id", id).eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
