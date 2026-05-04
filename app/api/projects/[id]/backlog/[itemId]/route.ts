/**
 * PATCH  /api/projects/:id/backlog/:itemId  — partial update (status, title,
 *                                              description, order_index)
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
import { createClient } from "@supabase/supabase-js";
import type { BacklogItem, BacklogStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID_STATUSES: ReadonlySet<BacklogStatus> = new Set(["todo", "doing", "done", "cancelled"]);

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertProjectMember(req: NextRequest, projectId: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: project } = await sb
    .from("projects")
    .select("factory_id, factories!inner(tenant_id)")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) throw new Error("NotFound");
  const tenantId = (project.factories as unknown as { tenant_id: string }).tenant_id;
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) throw new Error("Forbidden");
  return { sb, user, role: member.role as string };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  try {
    const { id: projectId, itemId } = await params;
    const { sb } = await assertProjectMember(req, projectId);
    const body = await req.json() as {
      title?:       string;
      description?: string | null;
      status?:      BacklogStatus;
      order_index?: number;
      sprint_id?:   string | null;
    };

    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) {
      const t = body.title.trim();
      if (!t) return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
      patch.title = t.slice(0, 200);
    }
    if (body.description !== undefined) {
      patch.description = body.description === null ? null : String(body.description).slice(0, 4000);
    }
    if (body.status !== undefined) {
      if (!VALID_STATUSES.has(body.status)) {
        return NextResponse.json({ error: `Invalid status. Allowed: ${[...VALID_STATUSES].join(", ")}` }, { status: 400 });
      }
      patch.status = body.status;
    }
    if (body.order_index !== undefined) {
      if (!Number.isFinite(body.order_index)) {
        return NextResponse.json({ error: "order_index must be a number" }, { status: 400 });
      }
      patch.order_index = body.order_index;
    }
    if (body.sprint_id !== undefined) {
      patch.sprint_id = body.sprint_id;  // null clears, uuid sets
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const { data, error } = await sb
      .from("project_backlog_items")
      .update(patch)
      .eq("id", itemId)
      .eq("project_id", projectId)   // belt-and-braces tenant isolation
      .select("*")
      .single();
    if (error) {
      if (error.code === "PGRST116") return NextResponse.json({ error: "Item not found" }, { status: 404 });
      throw new Error(error.message);
    }
    return NextResponse.json({ item: data as BacklogItem });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
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
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
