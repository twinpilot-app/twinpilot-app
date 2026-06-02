/**
 * GET    /api/factory/harness-presets/:id
 * PATCH  /api/factory/harness-presets/:id
 * DELETE /api/factory/harness-presets/:id
 *
 * BL-26 Phase 4. Per-preset CRUD. Same auth model as the list endpoint:
 * read for any tenant member, write for platform_admin / admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { slugify } from "@/lib/slugify";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { FactoryHarnessPresetPatchSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function loadPresetWithFactory(
  sb: SupabaseClient,
  id: string,
) {
  const { data } = await sb
    .from("harness_presets")
    .select("id, slug, name, description, config, factory_id, created_at, updated_at, factories!inner(tenant_id)")
    .eq("id", id)
    .maybeSingle();
  if (!data) throw new NotFoundError("Preset not found");
  return data as unknown as {
    id: string; slug: string; name: string; description: string | null;
    config: Record<string, unknown>; factory_id: string;
    created_at: string; updated_at: string;
    factories: { tenant_id: string };
  };
}

async function assertWriteRole(
  sb: SupabaseClient,
  userId: string,
  tenantId: string,
) {
  const { data } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new ForbiddenError("Caller is not a member of this tenant");
  if (!["platform_admin", "admin"].includes(data.role as string)) {
    throw new ForbiddenError("Caller is not an admin of this tenant");
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { id } = await params;
    const preset = await loadPresetWithFactory(sb, id);

    // Read: any tenant member.
    const { data } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", preset.factories.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!data) throw new ForbiddenError("Caller is not a member of this tenant");

    return NextResponse.json({
      preset: {
        id: preset.id,
        slug: preset.slug,
        name: preset.name,
        description: preset.description,
        config: preset.config,
        factory_id: preset.factory_id,
        created_at: preset.created_at,
        updated_at: preset.updated_at,
      },
    });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = await parseBody(req, FactoryHarnessPresetPatchSchema);
    const { user, sb } = await getOperatorUser(req);
    const { id } = await params;
    const preset = await loadPresetWithFactory(sb, id);
    await assertWriteRole(sb, user.id, preset.factories.tenant_id);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (!body.name.trim()) throw new ValidationError("name cannot be empty", []);
      patch.name = body.name.trim();
    }
    if (body.slug !== undefined) {
      const slug = slugify(body.slug);
      if (!slug) throw new ValidationError("slug must be at least one alphanumeric char", []);
      patch.slug = slug;
    }
    if (body.description !== undefined) {
      patch.description = body.description?.trim() || null;
    }
    if (body.config !== undefined) {
      if (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)) {
        throw new ValidationError("config must be a JSON object", []);
      }
      patch.config = body.config;
    }

    const { data, error } = await sb
      .from("harness_presets")
      .update(patch)
      .eq("id", id)
      .select("id, slug, name, description, config, factory_id, created_at, updated_at")
      .single();
    if (error) {
      const status = error.message.includes("duplicate") ? 409 : 500;
      return NextResponse.json({
        error: error.message,
        code:  status === 409 ? "CONFLICT" : "INTERNAL",
      }, { status });
    }
    return NextResponse.json({ preset: data });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { id } = await params;
    const preset = await loadPresetWithFactory(sb, id);
    await assertWriteRole(sb, user.id, preset.factories.tenant_id);

    const { error } = await sb.from("harness_presets").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
