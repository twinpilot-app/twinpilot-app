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
import { createClient } from "@supabase/supabase-js";
import type { BacklogItem, BacklogSource, BacklogStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const VALID_SOURCES: ReadonlySet<BacklogSource> = new Set(["manual", "wizard-gen", "trigger", "agent"]);

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
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const { sb, user } = await assertProjectMember(req, projectId);
    const body = await req.json() as {
      title?:           string;
      description?:     string;
      status?:          BacklogStatus;
      source?:          BacklogSource;
      order_index?:     number;
      source_url?:      string;
      source_metadata?: Record<string, unknown>;
    };
    if (!body.title?.trim()) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    const status: BacklogStatus = body.status ?? "todo";
    const source: BacklogSource = body.source && VALID_SOURCES.has(body.source) ? body.source : "manual";

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
        title:       body.title.trim().slice(0, 200),
        description: body.description?.slice(0, 4000) ?? null,
        status,
        source,
        order_index: orderIndex,
        created_by:  user.id,
        // Optional traceability — only populated when an ingester (GH/Jira/etc.)
        // creates the item. Manual UI inserts leave both NULL.
        ...(body.source_url      ? { source_url:      body.source_url.slice(0, 1000) } : {}),
        ...(body.source_metadata ? { source_metadata: body.source_metadata          } : {}),
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ item: data as BacklogItem }, { status: 201 });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
