/**
 * GET    /api/knowledge/[instanceId]  — instance detail with sources
 * PATCH  /api/knowledge/[instanceId]  — update name / description
 * DELETE /api/knowledge/[instanceId]  — delete instance (cascade)
 */
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getOperatorUser, parseBody, errorResponse,
  ForbiddenError, NotFoundError,
} from "@/lib/api-helpers";
import { KnowledgePatchSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

/** Verify user belongs to the tenant that owns the instance. */
async function assertAccess(
  sb: SupabaseClient,
  userId: string,
  instanceId: string,
) {
  const { data: instance } = await sb
    .from("knowledge_instances")
    .select("id, tenant_id, name, description, embedding_model, created_at")
    .eq("id", instanceId)
    .maybeSingle();
  if (!instance) throw new NotFoundError(`Knowledge instance ${instanceId} not found`);

  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", instance.tenant_id).eq("user_id", userId).single();
  if (!member) throw new ForbiddenError(`Caller is not a member of tenant ${instance.tenant_id}`);

  return instance;
}

/* ─── GET — instance detail ──────────────────────────────────── */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { instanceId } = await params;
    const instance = await assertAccess(sb, user.id, instanceId);

    const { data: sources } = await sb
      .from("knowledge_sources")
      .select("id, name, type, status, config, chunk_count, token_count, last_indexed_at, error_message, created_at")
      .eq("instance_id", instanceId)
      .order("created_at", { ascending: false });

    return NextResponse.json({
      instance: {
        id: instance.id,
        name: instance.name,
        description: instance.description,
        embeddingModel: instance.embedding_model,
        createdAt: instance.created_at,
        sources: (sources ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          status: s.status,
          config: s.config,
          chunk_count: s.chunk_count,
          token_count: s.token_count,
          last_indexed_at: s.last_indexed_at,
          error_message: s.error_message,
          created_at: s.created_at,
        })),
      },
    });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}

/* ─── PATCH — update instance ────────────────────────────────── */

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { instanceId } = await params;
    await assertAccess(sb, user.id, instanceId);

    // Validated body — Zod enforces name 1-200, description ≤2000.
    const body = await parseBody(req, KnowledgePatchSchema);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name        !== undefined) patch.name        = body.name;
    if (body.description !== undefined) patch.description = body.description ?? null;

    const { data, error } = await sb
      .from("knowledge_instances")
      .update(patch)
      .eq("id", instanceId)
      .select("id, name, description")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ instance: data });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}

/* ─── DELETE — delete instance (cascade) ─────────────────────── */

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { instanceId } = await params;
    await assertAccess(sb, user.id, instanceId);

    // Foreign keys with ON DELETE CASCADE handle sources + chunks + project_knowledge
    const { error } = await sb
      .from("knowledge_instances")
      .delete()
      .eq("id", instanceId);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, deleted: instanceId });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
