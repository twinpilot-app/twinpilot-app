/**
 * GET /api/projects/[id]/knowledge — list linked knowledge instances
 * PUT /api/projects/[id]/knowledge — update linked instances
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

async function getUser(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { user, sb };
}

async function assertProjectAccess(
  sb: ReturnType<typeof serviceClient>,
  userId: string,
  projectId: string,
) {
  const { data: project } = await sb
    .from("projects")
    .select("id, factory_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) throw Object.assign(new Error("Project not found"), { status: 404 });

  const { data: factory } = await sb
    .from("factories").select("tenant_id").eq("id", project.factory_id).single();
  if (!factory) throw Object.assign(new Error("Factory not found"), { status: 404 });

  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", factory.tenant_id).eq("user_id", userId).single();
  if (!member) throw Object.assign(new Error("Forbidden"), { status: 403 });

  return { project, tenantId: factory.tenant_id as string };
}

/* ─── GET — list linked instances ────────────────────────────── */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
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
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}

/* ─── PUT — update linked instances ──────────────────────────── */

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId } = await params;
    await assertProjectAccess(sb, user.id, projectId);

    const body = await req.json() as {
      instances: { id: string; enabled: boolean }[];
    };

    if (!Array.isArray(body.instances)) {
      return NextResponse.json({ error: "instances array required" }, { status: 400 });
    }

    // Remove existing links that are not in the new list
    const newIds = body.instances.map((i) => i.id);

    // Delete all current links for this project
    await sb
      .from("project_knowledge")
      .delete()
      .eq("project_id", projectId);

    // Insert new links
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
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
