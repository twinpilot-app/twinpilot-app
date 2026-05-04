/**
 * GET    /api/pipelines/[id] — pipeline detail (system or tenant)
 * PATCH  /api/pipelines/[id] — update custom pipeline
 * DELETE /api/pipelines/[id] — delete custom pipeline
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

async function getPipeline(sb: ReturnType<typeof serviceClient>, id: string) {
  const { data, error } = await sb.from("pipelines").select("*").eq("id", id).single();
  if (error || !data) throw new Error("Pipeline not found");
  return data;
}

async function assertCanEdit(
  sb: ReturnType<typeof serviceClient>,
  userId: string,
  pipeline: Record<string, unknown>,
) {
  if (pipeline.type === "system") throw new Error("Cannot modify system pipelines");
  const { data } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", pipeline.tenant_id)
    .eq("user_id", userId)
    .single();
  if (!data || !["platform_admin", "admin"].includes(data.role as string)) throw new Error("Forbidden");
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, sb } = await getUser(req);
    const { id } = await params;
    const pipeline = await getPipeline(sb, id);

    // System pipeline: any authenticated user can read
    if (pipeline.tenant_id !== null) {
      const { data: member } = await sb
        .from("tenant_members")
        .select("role")
        .eq("tenant_id", pipeline.tenant_id)
        .eq("user_id", user.id)
        .single();
      if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ pipeline });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, sb } = await getUser(req);
    const { id } = await params;
    const pipeline = await getPipeline(sb, id);
    await assertCanEdit(sb, user.id, pipeline as Record<string, unknown>);

    const body = await req.json() as {
      name?: string; description?: string; steps?: unknown[]; is_active?: boolean;
      mode?: string; intent?: "discovery" | "planning" | "execution" | "review";
    };
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name        !== undefined) update.name        = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.steps       !== undefined) update.steps       = body.steps;
    if (body.is_active   !== undefined) update.is_active   = body.is_active;
    if (body.mode        !== undefined) update.mode         = body.mode;
    if (body.intent      !== undefined) update.intent       = body.intent;

    const { data, error } = await sb.from("pipelines").update(update).eq("id", id).select("*").single();
    if (error) throw new Error(error.message);

    // Propagate updated steps to all projects using this pipeline so the
    // denormalized `pipeline` snapshot stays in sync with the source of truth.
    if (body.steps !== undefined) {
      await sb
        .from("projects")
        .update({ pipeline: body.steps, updated_at: new Date().toISOString() })
        .eq("pipeline_id", id);
    }

    return NextResponse.json({ pipeline: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, sb } = await getUser(req);
    const { id } = await params;
    const pipeline = await getPipeline(sb, id);
    await assertCanEdit(sb, user.id, pipeline as Record<string, unknown>);

    const { error } = await sb.from("pipelines").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
