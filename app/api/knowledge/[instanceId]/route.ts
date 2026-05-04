/**
 * GET    /api/knowledge/[instanceId]  — instance detail with sources
 * PATCH  /api/knowledge/[instanceId]  — update name / description
 * DELETE /api/knowledge/[instanceId]  — delete instance (cascade)
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function getUser(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { user, sb };
}

/** Verify user belongs to the tenant that owns the instance. */
async function assertAccess(
  sb: ReturnType<typeof serviceClient>,
  userId: string,
  instanceId: string,
) {
  const { data: instance } = await sb
    .from("knowledge_instances")
    .select("id, tenant_id, name, description, embedding_model, created_at")
    .eq("id", instanceId)
    .maybeSingle();
  if (!instance) throw Object.assign(new Error("Instance not found"), { status: 404 });

  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", instance.tenant_id).eq("user_id", userId).single();
  if (!member) throw Object.assign(new Error("Forbidden"), { status: 403 });

  return instance;
}

/* ─── GET — instance detail ──────────────────────────────────── */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
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
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}

/* ─── PATCH — update instance ────────────────────────────────── */

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { instanceId } = await params;
    await assertAccess(sb, user.id, instanceId);

    const body = await req.json() as { name?: string; description?: string };
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.description !== undefined) patch.description = body.description?.trim() ?? null;

    const { data, error } = await sb
      .from("knowledge_instances")
      .update(patch)
      .eq("id", instanceId)
      .select("id, name, description")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ instance: data });
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}

/* ─── DELETE — delete instance (cascade) ─────────────────────── */

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
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
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
