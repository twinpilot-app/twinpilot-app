/**
 * GET  /api/knowledge?tenantId=...  — list all knowledge instances for a tenant
 * POST /api/knowledge               — create a new knowledge instance
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

/* ─── GET — list knowledge instances ─────────────────────────── */

export async function GET(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

    // Verify membership
    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", tenantId).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/* ─── POST — create knowledge instance ───────────────────────── */

export async function POST(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const body = await req.json() as {
      tenantId: string;
      name: string;
      description?: string;
    };

    if (!body.tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });
    if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

    // Verify membership
    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", body.tenantId).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data: instance, error } = await sb
      .from("knowledge_instances")
      .insert({
        tenant_id:   body.tenantId,
        name:        body.name.trim(),
        description: body.description?.trim() ?? null,
      })
      .select("id, name, description")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ instance }, { status: 201 });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
