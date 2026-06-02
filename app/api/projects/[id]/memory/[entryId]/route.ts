/**
 * PATCH /api/projects/:id/memory/:entryId
 *
 * Operator transitions a memory entry through its lifecycle:
 *   proposed → approved | rejected
 *   approved | rejected → archived
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { ProjectMemoryPatchSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function assertProjectMember(sb: SupabaseClient, userId: string, projectId: string) {
  const { data: project } = await sb
    .from("projects")
    .select("factory_id, factories!inner(tenant_id)")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) throw new NotFoundError("Project not found");
  const tenantId = (project.factories as unknown as { tenant_id: string }).tenant_id;
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
    throw new ForbiddenError("Caller is not a member of this project's tenant");
  }
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  proposed: ["approved", "rejected"],
  approved: ["archived"],
  rejected: ["archived"],
  archived: [],
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  try {
    const body = await parseBody(req, ProjectMemoryPatchSchema);
    const { user, sb } = await getOperatorUser(req);
    const { id: projectId, entryId } = await params;

    if (!body.status) throw new ValidationError("status is required", []);
    await assertProjectMember(sb, user.id, projectId);

    // Read current row to validate the transition.
    const { data: current } = await sb
      .from("project_memory_entries")
      .select("status")
      .eq("id", entryId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (!current) throw new NotFoundError("Entry not found");

    const allowed = ALLOWED_TRANSITIONS[current.status as string] ?? [];
    if (!allowed.includes(body.status)) {
      return NextResponse.json({
        error: `Invalid transition: ${current.status as string} → ${body.status}. Allowed from ${current.status as string}: ${allowed.length === 0 ? "(none)" : allowed.join(", ")}`,
        code:  "INVALID_TRANSITION",
      }, { status: 422 });
    }

    const patch: Record<string, unknown> = { status: body.status };
    const now = new Date().toISOString();
    if (body.status === "approved") {
      patch.approved_at = now;
      patch.approved_by = user.id;
      patch.rejection_reason = null;
    } else if (body.status === "rejected") {
      patch.rejection_reason = (body.rejection_reason ?? "").trim().slice(0, 500) || null;
    } else if (body.status === "archived") {
      patch.archived_at = now;
    }

    const { data, error } = await sb
      .from("project_memory_entries")
      .update(patch)
      .eq("id", entryId)
      .eq("project_id", projectId)
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ entry: data });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
