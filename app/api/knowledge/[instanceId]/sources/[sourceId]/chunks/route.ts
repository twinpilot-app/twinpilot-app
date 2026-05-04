/**
 * GET /api/knowledge/[instanceId]/sources/[sourceId]/chunks
 * List chunks for a source with content preview and metadata.
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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string; sourceId: string }> },
) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = serviceClient();
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { instanceId, sourceId } = await params;

    // Verify instance access
    const { data: instance } = await sb
      .from("knowledge_instances")
      .select("tenant_id")
      .eq("id", instanceId)
      .maybeSingle();
    if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", instance.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Fetch chunks
    const { data: chunks, error } = await sb
      .from("knowledge_chunks")
      .select("id, content, metadata, token_count, excluded, created_at")
      .eq("source_id", sourceId)
      .eq("instance_id", instanceId)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) throw new Error(error.message);

    return NextResponse.json({
      chunks: (chunks ?? []).map((c) => ({
        id: c.id,
        content: c.content,
        metadata: c.metadata,
        token_count: c.token_count,
        excluded: c.excluded,
      })),
      total: chunks?.length ?? 0,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/* ─── DELETE — clear all chunks for a source ──────────────────── */

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string; sourceId: string }> },
) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = serviceClient();
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { instanceId, sourceId } = await params;

    // Verify access
    const { data: instance } = await sb
      .from("knowledge_instances")
      .select("tenant_id")
      .eq("id", instanceId)
      .maybeSingle();
    if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", instance.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Delete all chunks for this source
    await sb
      .from("knowledge_chunks")
      .delete()
      .eq("source_id", sourceId)
      .eq("instance_id", instanceId);

    // Reset source stats
    await sb
      .from("knowledge_sources")
      .update({ chunk_count: 0, token_count: 0, status: "pending", last_indexed_at: null, error_message: null })
      .eq("id", sourceId)
      .eq("instance_id", instanceId);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
