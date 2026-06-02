/**
 * GET  /api/knowledge?tenantId=...  — list all knowledge instances for a tenant
 * POST /api/knowledge               — create a new knowledge instance
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getOperatorUser, parseBody, errorResponse, ForbiddenError,
} from "@/lib/api-helpers";
import { KnowledgeCreateSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

/* ─── GET — list knowledge instances ─────────────────────────── */

export async function GET(req: NextRequest) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!tenantId) return NextResponse.json({ error: "tenantId required", code: "VALIDATION_ERROR" }, { status: 400 });

    // Verify membership
    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", tenantId).eq("user_id", user.id).single();
    if (!member) throw new ForbiddenError(`Caller is not a member of tenant ${tenantId}`);

    const { data: instances, error } = await sb
      .from("knowledge_instances")
      .select("id, name, description, embedding_model, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);

    // Fetch source counts and chunk counts per instance
    const enriched = await Promise.all(
      (instances ?? []).map(async (inst) => {
        const { count: sourceCount } = await sb
          .from("knowledge_sources")
          .select("id", { count: "exact", head: true })
          .eq("instance_id", inst.id);

        const { count: chunkCount } = await sb
          .from("knowledge_chunks")
          .select("id", { count: "exact", head: true })
          .eq("instance_id", inst.id);

        return {
          id: inst.id,
          name: inst.name,
          description: inst.description,
          sourceCount: sourceCount ?? 0,
          chunkCount: chunkCount ?? 0,
          createdAt: inst.created_at,
        };
      }),
    );

    return NextResponse.json({ instances: enriched });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}

/* ─── POST — create knowledge instance ───────────────────────── */

export async function POST(req: NextRequest) {
  try {
    const { user, sb } = await getOperatorUser(req);
    // Validated body — Zod enforces tenantId uuid, name 1-200,
    // description ≤2000.
    const body = await parseBody(req, KnowledgeCreateSchema);

    // Verify membership
    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", body.tenantId).eq("user_id", user.id).single();
    if (!member) throw new ForbiddenError(`Caller is not a member of tenant ${body.tenantId}`);

    const { data: instance, error } = await sb
      .from("knowledge_instances")
      .insert({
        tenant_id:   body.tenantId,
        name:        body.name,
        description: body.description ?? null,
      })
      .select("id, name, description")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ instance }, { status: 201 });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
