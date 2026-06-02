/**
 * POST /api/skills/built-in/install
 *
 * Install a built-in skill into a factory or project. Copies the catalog
 * row into factory_skills with origin='built-in' + provenance fields.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { SkillsBuiltInInstallSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function assertFactoryMember(sb: SupabaseClient, userId: string, factoryId: string) {
  const { data: factory } = await sb
    .from("factories").select("tenant_id").eq("id", factoryId).maybeSingle();
  if (!factory) throw new NotFoundError("Factory not found");
  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", factory.tenant_id).eq("user_id", userId).maybeSingle();
  if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
    throw new ForbiddenError("Caller is not a member of this factory's tenant");
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, SkillsBuiltInInstallSchema);
    const { user, sb } = await getOperatorUser(req);
    await assertFactoryMember(sb, user.id, body.factory_id);

    // Pull the catalog row.
    const { data: catalog, error: catErr } = await sb
      .from("built_in_skills")
      .select("slug, name, description, body, category, allowed_tools, source_url, source_attribution, version")
      .eq("id", body.built_in_skill_id)
      .maybeSingle();
    if (catErr) throw new Error(catErr.message);
    if (!catalog) throw new NotFoundError("Built-in skill not found");

    // Slug collision check within scope.
    const scopeFilter = body.project_id
      ? sb.from("factory_skills")
          .select("id, name", { count: "exact" })
          .eq("factory_id", body.factory_id)
          .eq("project_id", body.project_id)
          .eq("slug", catalog.slug as string)
      : sb.from("factory_skills")
          .select("id, name", { count: "exact" })
          .eq("factory_id", body.factory_id)
          .is("project_id", null)
          .eq("slug", catalog.slug as string);
    const { data: existing } = await scopeFilter;
    if (existing && existing.length > 0) {
      return NextResponse.json({
        error: `A skill with slug "${catalog.slug as string}" already exists in this scope. Uninstall or rename first.`,
        code: "CONFLICT",
        existing_id: existing[0].id,
      }, { status: 409 });
    }

    const { data: inserted, error: insErr } = await sb
      .from("factory_skills")
      .insert({
        factory_id:     body.factory_id,
        project_id:     body.project_id ?? null,
        slug:           catalog.slug,
        name:           catalog.name,
        description:    catalog.description,
        body:           catalog.body,
        category:       catalog.category,
        allowed_tools:  catalog.allowed_tools ?? [],
        origin:         "built-in",
        source_url:     catalog.source_url,
        source_version: catalog.version,
      })
      .select("*")
      .single();
    if (insErr) throw new Error(insErr.message);

    return NextResponse.json({ ok: true, skill: inserted }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
