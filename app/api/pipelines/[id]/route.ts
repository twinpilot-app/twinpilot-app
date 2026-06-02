/**
 * GET    /api/pipelines/[id] — pipeline detail (system or tenant)
 * PATCH  /api/pipelines/[id] — update custom pipeline
 * DELETE /api/pipelines/[id] — delete custom pipeline
 */
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getOperatorUser, parseBody, errorResponse,
  ForbiddenError, NotFoundError,
} from "@/lib/api-helpers";
import { PipelinePatchSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

async function getPipeline(sb: SupabaseClient, id: string) {
  const { data, error } = await sb.from("pipelines").select("*").eq("id", id).single();
  if (error || !data) throw new NotFoundError("Pipeline not found");
  return data;
}

async function assertCanEdit(
  sb: SupabaseClient,
  userId: string,
  pipeline: Record<string, unknown>,
) {
  if (pipeline.type === "system") throw new ForbiddenError("Cannot modify system pipelines");
  const { data } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", pipeline.tenant_id)
    .eq("user_id", userId)
    .single();
  if (!data || !["platform_admin", "admin"].includes(data.role as string)) {
    throw new ForbiddenError(`Caller lacks platform_admin/admin on tenant ${pipeline.tenant_id}`);
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, sb } = await getOperatorUser(req);
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
      if (!member) throw new ForbiddenError(`Caller lacks membership on tenant ${pipeline.tenant_id}`);
    }

    return NextResponse.json({ pipeline });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { id } = await params;
    const pipeline = await getPipeline(sb, id);
    await assertCanEdit(sb, user.id, pipeline as Record<string, unknown>);

    // Validated body — Zod enforces caps on text fields, intent enum,
    // is_active boolean, and EACH step's shape (mig 185 contract).
    const body = await parseBody(req, PipelinePatchSchema);
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name        !== undefined) update.name        = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.steps       !== undefined) update.steps       = body.steps;
    if (body.is_active   !== undefined) update.is_active   = body.is_active;
    if (body.mode        !== undefined) update.mode        = body.mode;
    if (body.intent      !== undefined) update.intent      = body.intent;
    if (body.projectId   !== undefined) update.project_id  = body.projectId;

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
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { id } = await params;
    const pipeline = await getPipeline(sb, id);
    await assertCanEdit(sb, user.id, pipeline as Record<string, unknown>);

    const { error } = await sb.from("pipelines").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
