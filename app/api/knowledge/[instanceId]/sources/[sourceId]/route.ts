/**
 * DELETE /api/knowledge/[instanceId]/sources/[sourceId] — remove source (cascade)
 * POST   /api/knowledge/[instanceId]/sources/[sourceId] — re-index source
 * PATCH  /api/knowledge/[instanceId]/sources/[sourceId] — pause / rename / config
 */
import { NextRequest, NextResponse } from "next/server";
import { mintWorkerToken } from "@/lib/worker-jwt";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import {
  KnowledgeSourceReindexSchema,
  KnowledgeSourcePatchSchema,
} from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const TRIGGER_API = "https://api.trigger.dev";

async function assertAccess(
  sb: SupabaseClient,
  userId: string,
  instanceId: string,
) {
  const { data: instance } = await sb
    .from("knowledge_instances")
    .select("id, tenant_id")
    .eq("id", instanceId)
    .maybeSingle();
  if (!instance) throw new NotFoundError("Instance not found");

  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", instance.tenant_id).eq("user_id", userId).maybeSingle();
  if (!member) throw new ForbiddenError("Caller is not a member of this instance's tenant");

  return instance;
}

async function getTriggerKey(
  sb: SupabaseClient,
  tenantId: string,
  preferDev = false,
): Promise<string | null> {
  const order = preferDev
    ? ["TRIGGER_DEV_SECRET_KEY", "TRIGGER_PROD_SECRET_KEY", "TRIGGER_SECRET_KEY"]
    : ["TRIGGER_PROD_SECRET_KEY", "TRIGGER_DEV_SECRET_KEY", "TRIGGER_SECRET_KEY"];
  for (const varName of order) {
    const { data: row } = await sb
      .from("tenant_integrations")
      .select("secret_value")
      .eq("tenant_id", tenantId)
      .eq("service_id", "trigger")
      .eq("var_name", varName)
      .maybeSingle();
    if (row?.secret_value) return row.secret_value as string;
  }
  return process.env.TRIGGER_SECRET_KEY ?? null;
}

/* ─── DELETE — remove source ─────────────────────────────────── */

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string; sourceId: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { instanceId, sourceId } = await params;
    await assertAccess(sb, user.id, instanceId);

    const { data: source } = await sb
      .from("knowledge_sources")
      .select("id")
      .eq("id", sourceId)
      .eq("instance_id", instanceId)
      .maybeSingle();
    if (!source) throw new NotFoundError("Source not found");

    const { error } = await sb
      .from("knowledge_sources")
      .delete()
      .eq("id", sourceId);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, deleted: sourceId });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

/* ─── POST — re-index source ────────────────────────────────── */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string; sourceId: string }> },
) {
  try {
    const body = await parseBody(req, KnowledgeSourceReindexSchema);
    const { user, sb } = await getOperatorUser(req);
    const { instanceId, sourceId } = await params;
    const instance = await assertAccess(sb, user.id, instanceId);

    const { data: source } = await sb
      .from("knowledge_sources")
      .select("id, name, type, status")
      .eq("id", sourceId)
      .eq("instance_id", instanceId)
      .maybeSingle();
    if (!source) throw new NotFoundError("Source not found");

    const indexEnv: "prod" | "dev" = body.indexEnv === "dev" ? "dev" : "prod";

    const triggerKey = await getTriggerKey(sb, instance.tenant_id as string, indexEnv === "dev");
    if (!triggerKey) throw new ValidationError("Trigger.dev key not configured", []);

    const minted = mintWorkerToken({
      tenantId:   instance.tenant_id as string,
      ttlSeconds: 60 * 60,
    });
    const triggerRes = await fetch(`${TRIGGER_API}/api/v1/tasks/index-knowledge-source/trigger`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${triggerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payload: {
          sourceId,
          supabaseJwt:          minted.token,
          supabaseJwtExpiresAt: minted.expiresAt,
          supabaseUrl:          process.env.NEXT_PUBLIC_SUPABASE_URL,
        },
      }),
    });

    if (!triggerRes.ok) {
      const detail = await triggerRes.text().catch(() => "unknown");
      throw new Error(`Trigger.dev dispatch failed: ${detail}`);
    }

    await sb
      .from("knowledge_sources")
      .update({ status: "indexing", error_message: null, updated_at: new Date().toISOString() })
      .eq("id", sourceId);

    return NextResponse.json({
      source: { id: source.id, name: source.name, type: source.type, status: "indexing" },
    });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

/* ─── PATCH — update source status (pause/unpause) ─────────── */

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string; sourceId: string }> },
) {
  try {
    const body = await parseBody(req, KnowledgeSourcePatchSchema);
    const { user, sb } = await getOperatorUser(req);
    const { instanceId, sourceId } = await params;
    await assertAccess(sb, user.id, instanceId);

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.status) updates.status = body.status;
    if (body.name?.trim()) updates.name = body.name.trim();
    if (body.config && typeof body.config === "object") updates.config = body.config;
    if (body.clearError) updates.error_message = null;
    if (Object.keys(updates).length <= 1) {
      throw new ValidationError("Nothing to update", []);
    }

    await sb
      .from("knowledge_sources")
      .update(updates)
      .eq("id", sourceId)
      .eq("instance_id", instanceId);

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
