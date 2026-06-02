/**
 * GET  /api/projects/:id/backlog       — list all items for the project
 * POST /api/projects/:id/backlog       — create a new item
 *
 * Items are returned in column-then-order_index order (todo first, doing,
 * done, cancelled) so the kanban view can split them by status without a
 * second sort.
 *
 * Authorization: caller must be a tenant member of the project's tenant.
 * Inserts require owner/admin/member role (RLS enforces).
 */
import { NextRequest, NextResponse } from "next/server";
import type { BacklogItem, BacklogStatus } from "@/lib/types";
import {
  getUser, parseBody, errorResponse,
  AuthError, ForbiddenError, NotFoundError,
} from "@/lib/api-helpers";
import { BacklogAddSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

/**
 * Project-scoped membership gate. Looks up the project's tenant in the
 * same shot so the caller doesn't need a separate factory→tenant query.
 * Throws structured errors that the standard `errorResponse` translates.
 */
async function assertProjectMember(req: NextRequest, projectId: string) {
  const { user, sb } = await getUser(req);
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
  return { sb, user, project, tenantId, role: member.role as string };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const { sb } = await assertProjectMember(req, projectId);
    // Join sprint number for agent-origin items so the kanban can show
    // "🤖 sprint #5 · scout" without a second roundtrip per card. Other
    // origins ignore the join (created_by_sprint_id is NULL).
    const { data, error } = await sb
      .from("project_backlog_items")
      .select("*, created_by_sprint:sprints!project_backlog_items_created_by_sprint_id_fkey(sprint_num)")
      .eq("project_id", projectId)
      // Custom column order: todo (active work), doing (in progress), done
      // (history), cancelled (parked). Within column, order_index ASC.
      .order("status", { ascending: true })
      .order("order_index", { ascending: true });
    if (error) throw new Error(error.message);
    // Flatten the join into a top-level field for the UI.
    const items = (data ?? []).map((row) => {
      const joined = (row as { created_by_sprint?: { sprint_num?: number } | null }).created_by_sprint;
      const created_by_sprint_num = joined?.sprint_num ?? null;
      const { created_by_sprint: _drop, ...rest } = row as Record<string, unknown>;
      return { ...rest, created_by_sprint_num } as BacklogItem & { created_by_sprint_num: number | null };
    });
    return NextResponse.json({ items });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const { sb, user } = await assertProjectMember(req, projectId);
    // Validated body — Zod enforces title length (<=200, trimmed),
    // description cap (32KB), enum values for status/source. The
    // schema rejects unknown fields, so source-of-truth is api-schemas.ts.
    const body = await parseBody(req, BacklogAddSchema);
    const status: BacklogStatus = (body.status ?? "todo") as BacklogStatus;
    const source = body.source ?? "manual";

    // If order_index isn't given, append: max(order_index)+100 within the
    // target status column. Gap of 100 keeps drag-drop reorders cheap.
    let orderIndex = body.order_index;
    if (orderIndex === undefined) {
      const { data: max } = await sb
        .from("project_backlog_items")
        .select("order_index")
        .eq("project_id", projectId)
        .eq("status", status)
        .order("order_index", { ascending: false })
        .limit(1)
        .maybeSingle();
      orderIndex = (max?.order_index ?? 0) + 100;
    }

    const { data, error } = await sb
      .from("project_backlog_items")
      .insert({
        project_id:  projectId,
        title:       body.title,
        description: body.description ?? null,
        status,
        source,
        order_index: orderIndex,
        created_by:  user.id,
        // Optional traceability — only populated when an ingester (GH/Jira/etc.)
        // creates the item. Manual UI inserts leave both NULL.
        ...(body.source_url      ? { source_url:      body.source_url      } : {}),
        ...(body.source_metadata ? { source_metadata: body.source_metadata } : {}),
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ item: data as BacklogItem }, { status: 201 });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
