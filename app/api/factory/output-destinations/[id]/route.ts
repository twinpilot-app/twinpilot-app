/**
 * PATCH  /api/factory/output-destinations/[id]
 * DELETE /api/factory/output-destinations/[id]
 *
 * Update or remove a single destination. Writes require owner/admin
 * on the destination's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getOperatorUser, parseBody, errorResponse,
  ForbiddenError, NotFoundError,
} from "@/lib/api-helpers";
import { FactoryDestinationPatchSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

async function authAndLoad(req: NextRequest, id: string): Promise<{
  sb: SupabaseClient;
  row: { id: string; tenant_id: string };
}> {
  const { user, sb } = await getOperatorUser(req);

  const { data: row } = await sb
    .from("factory_output_destinations")
    .select("id, tenant_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new NotFoundError(`Destination ${id} not found`);

  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", row.tenant_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || !["platform_admin", "admin"].includes(member.role)) {
    throw new ForbiddenError(`Caller lacks platform_admin/admin on tenant ${row.tenant_id}`);
  }

  return { sb, row: row as { id: string; tenant_id: string } };
}

function maskToken(t: string): string {
  const s = t.trim();
  if (s.length < 6) return "●●●●";
  return `…${s.slice(-4)}`;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { sb } = await authAndLoad(req, id);
    // Validated body — Zod enforces optional caps mirroring create.
    // Owner / branch normalised post-validation (strip http prefix /
    // trailing slashes / empty-string-to-null for branch).
    const body = await parseBody(req, FactoryDestinationPatchSchema);

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name  !== undefined) update.name  = body.name;
    if (body.owner !== undefined) update.owner = body.owner.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").trim();
    if (body.token !== undefined) update.token = body.token;
    if (body.branch !== undefined) update.branch = (body.branch ?? "").trim() || null;

    const { data, error } = await sb
      .from("factory_output_destinations")
      .update(update)
      .eq("id", id)
      .select("id, name, owner, token, branch, created_at, updated_at")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: `A destination with that name already exists.`, code: "DUPLICATE" }, { status: 409 });
      }
      throw new Error(error.message);
    }

    return NextResponse.json({
      destination: {
        id:        data.id as string,
        name:      data.name as string,
        owner:     data.owner as string,
        tokenMask: maskToken(data.token as string),
        branch:    (data.branch as string | null) ?? null,
        createdAt: data.created_at as string,
        updatedAt: data.updated_at as string,
      },
    });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { sb } = await authAndLoad(req, id);

    const { error } = await sb
      .from("factory_output_destinations")
      .delete()
      .eq("id", id);
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
