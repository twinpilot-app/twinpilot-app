/**
 * POST /api/skills/updates/apply
 *
 * Re-fetches the upstream skill and overwrites the installed copy.
 * Local edits to the body are lost; the UI warns before calling.
 *
 * Body: { skill_id }
 */
import { NextRequest, NextResponse } from "next/server";
import { applySkillUpdate, FactorySkillRow } from "@/lib/skills-updates";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { SkillsUpdatesApplySchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, SkillsUpdatesApplySchema);
    const { user, sb } = await getOperatorUser(req);

    const { data: skill } = await sb
      .from("factory_skills")
      .select("id, factory_id, project_id, slug, name, origin, source_url, source_version, source_commit_sha, body, category, description, updated_at, created_at")
      .eq("id", body.skill_id)
      .maybeSingle();
    if (!skill) throw new NotFoundError("Skill not found");

    // Authorise via factory→tenant→member chain.
    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", skill.factory_id as string).maybeSingle();
    if (!factory) throw new NotFoundError("Factory not found");
    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).maybeSingle();
    if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
      throw new ForbiddenError("Caller is not a member of this skill's tenant");
    }

    const result = await applySkillUpdate(sb, skill as FactorySkillRow);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
