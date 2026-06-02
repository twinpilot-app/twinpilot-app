/**
 * PATCH  /api/projects/:id/backlog/:itemId  — partial update (status, title,
 *                                              description, order_index, sprint_id)
 * DELETE /api/projects/:id/backlog/:itemId  — hard delete the item
 *
 * Status changes are tracked by the DB trigger
 * (set_project_backlog_items_updated_at): completed_at is set when status
 * enters 'done' and cleared when leaving it. The caller doesn't manage
 * timestamps.
 *
 * Authorization: caller must be owner/admin/member of the project's tenant
 * (RLS enforces; service-role client used here because we already check
 * membership upstream).
 */
import { NextRequest, NextResponse } from "next/server";
import type { BacklogItem } from "@/lib/types";
import {
  getOperatorUser, parseBody, errorResponse,
  ForbiddenError, NotFoundError,
} from "@/lib/api-helpers";
import { BacklogPatchSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

/**
 * Project-scoped membership gate. Looks up the project's tenant in the
 * same shot so the caller doesn't need a separate factory→tenant query.
 * Throws structured errors that the standard `errorResponse` translates.
 */
async function assertProjectMember(req: NextRequest, projectId: string) {
  const { user, sb } = await getOperatorUser(req);
  const { data: project } = await sb
    .from("projects")
    .select("factory_id, factories!inner(tenant_id)")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) throw new NotFoundError(`Project ${projectId} not found`);
  const tenantId = (project.factories as unknown as { tenant_id: string }).tenant_id;
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) throw new ForbiddenError(`Caller is not a member of tenant ${tenantId}`);
  return { sb, user, role: member.role as string };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  try {
    const { id: projectId, itemId } = await params;
    const { sb } = await assertProjectMember(req, projectId);
    // Validated body — Zod enforces title (≤200, trimmed), description
    // (≤32KB), status enum, order_index integer range, sprint_id uuid.
    const body = await parseBody(req, BacklogPatchSchema);

    const patch: Record<string, unknown> = {};
    if (body.title       !== undefined) patch.title       = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.status      !== undefined) patch.status      = body.status;
    if (body.order_index !== undefined) patch.order_index = body.order_index;
    if (body.sprint_id   !== undefined) patch.sprint_id   = body.sprint_id;  // null clears, uuid sets

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update", code: "EMPTY_PATCH" }, { status: 400 });
    }

    const { data, error } = await sb
      .from("project_backlog_items")
      .update(patch)
      .eq("id", itemId)
      .eq("project_id", projectId)   // belt-and-braces tenant isolation
      .select("*")
      .single();
    if (error) {
      if (error.code === "PGRST116") throw new NotFoundError("Backlog item not found");
      throw new Error(error.message);
    }
    return NextResponse.json({ item: data as BacklogItem });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  try {
    const { id: projectId, itemId } = await params;
    const { sb } = await assertProjectMember(req, projectId);
    const { error } = await sb
      .from("project_backlog_items")
      .delete()
      .eq("id", itemId)
      .eq("project_id", projectId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
