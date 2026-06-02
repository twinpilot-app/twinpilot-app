/**
 * GET /api/projects/[id]/knowledge — list linked knowledge instances
 * PUT /api/projects/[id]/knowledge — update linked instances
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { ProjectKnowledgePatchSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function assertProjectAccess(
  sb: SupabaseClient,
  userId: string,
  projectId: string,
) {
  const { data: project } = await sb
    .from("projects")
    .select("id, factory_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) throw new NotFoundError("Project not found");

  const { data: factory } = await sb
    .from("factories").select("tenant_id").eq("id", project.factory_id).single();
  if (!factory) throw new NotFoundError("Factory not found");

  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", factory.tenant_id).eq("user_id", userId).maybeSingle();
  if (!member) throw new ForbiddenError("Caller is not a member of this project's tenant");

  return { project, tenantId: factory.tenant_id as string };
}

/* ─── GET — list linked instances ────────────────────────────── */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { id: projectId } = await params;
    await assertProjectAccess(sb, user.id, projectId);

    // Join project_knowledge with knowledge_instances
    const { data: links, error } = await sb
      .from("project_knowledge")
      .select("instance_id, enabled")
      .eq("project_id", projectId);

    if (error) throw new Error(error.message);

    if (!links || links.length === 0) {
      return NextResponse.json({ instances: [] });
    }

    const instanceIds = links.map((l) => l.instance_id as string);
    const { data: instances } = await sb
      .from("knowledge_instances")
      .select("id, name, description")
      .in("id", instanceIds);

    // Fetch chunk counts per instance
    const chunkCounts = await Promise.all(
      instanceIds.map(async (iid) => {
        const { count } = await sb
          .from("knowledge_chunks")
          .select("id", { count: "exact", head: true })
          .eq("instance_id", iid);
        return { id: iid, count: count ?? 0 };
      }),
    );
    const countMap = new Map(chunkCounts.map((c) => [c.id, c.count]));
    const enabledMap = new Map(links.map((l) => [l.instance_id, l.enabled]));

    return NextResponse.json({
      instances: (instances ?? []).map((inst) => ({
        id: inst.id,
        name: inst.name,
        enabled: enabledMap.get(inst.id) ?? true,
        chunkCount: countMap.get(inst.id) ?? 0,
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

/* ─── PUT — update linked instances ──────────────────────────── */

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = await parseBody(req, ProjectKnowledgePatchSchema);
    const { user, sb } = await getOperatorUser(req);
    const { id: projectId } = await params;
    await assertProjectAccess(sb, user.id, projectId);

    const newIds = body.instances.map((i) => i.id);

    // Delete all current links for this project, then insert new.
    await sb
      .from("project_knowledge")
      .delete()
      .eq("project_id", projectId);

    if (body.instances.length > 0) {
      const rows = body.instances.map((inst) => ({
        project_id:  projectId,
        instance_id: inst.id,
        enabled:     inst.enabled,
        added_at:    new Date().toISOString(),
      }));

      const { error } = await sb
        .from("project_knowledge")
        .insert(rows);

      if (error) throw new Error(error.message);
    }

    return NextResponse.json({ ok: true, linked: newIds });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
