/**
 * GET   /api/projects/:id/memory          — list memory entries (filterable by status)
 * PATCH /api/projects/:id/memory/:entryId — approve / reject / archive a single entry
 *
 * Phase 2 of the Local+Git Excellence program. Operators review what the
 * agents proposed via record_decision; only approved entries reach the
 * next sprint's loaded MEMORY.md.
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
  if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
    throw new Error("Forbidden");
  }
  return { sb, user, role: member.role as string };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const { sb } = await assertProjectMember(req, projectId);

    // Status filter — defaults to ALL so the dashboard can render multiple
    // tabs (proposed, approved, rejected, archived) from one fetch.
    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    const allowed = ["proposed", "approved", "rejected", "archived"];
    const statusList = statusParam
      ? statusParam.split(",").filter((s) => allowed.includes(s))
      : allowed;

    const { data, error } = await sb
      .from("project_memory_entries")
      .select("id, type, title, content, status, agent_slug, sprint_id, created_at, approved_at, approved_by, rejection_reason, archived_at")
      .eq("project_id", projectId)
      .in("status", statusList)
      .order("created_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ entries: data ?? [] });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
