/**
 * PATCH /api/projects/:id/memory/:entryId
 *
 * Operator transitions a memory entry through its lifecycle:
 *   proposed → approved (with approved_by + approved_at)
 *   proposed → rejected (with rejection_reason)
 *   approved → archived (no longer loaded into future sprints)
 *
 * Anything else returns 422.
 *
 * Approved is the only status that surfaces in the next sprint's
 * .tp/MEMORY.md — see writeProjectContextFiles in the worker.
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

async function getUserAndProject(req: NextRequest, projectId: string) {
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
  return { sb, user };
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
    const { id: projectId, entryId } = await params;
    const { sb, user } = await getUserAndProject(req, projectId);
    const body = await req.json() as {
      status?:           "approved" | "rejected" | "archived";
      rejection_reason?: string | null;
    };

    if (!body.status || !["approved", "rejected", "archived"].includes(body.status)) {
      return NextResponse.json({ error: "status must be one of approved | rejected | archived" }, { status: 400 });
    }

    // Read current row first so we can validate the transition. Single
    // row-level check is cheap; better than letting the UI race with
    // another operator's action and ending up in a weird state.
    const { data: current } = await sb
      .from("project_memory_entries")
      .select("status")
      .eq("id", entryId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (!current) return NextResponse.json({ error: "Entry not found" }, { status: 404 });

    const allowed = ALLOWED_TRANSITIONS[current.status as string] ?? [];
    if (!allowed.includes(body.status)) {
      return NextResponse.json({
        error: `Invalid transition: ${current.status} → ${body.status}. Allowed from ${current.status}: ${allowed.length === 0 ? "(none)" : allowed.join(", ")}`,
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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ entry: data });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
