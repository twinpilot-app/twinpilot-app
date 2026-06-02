/**
 * POST /api/skills/updates/check
 *
 * Checks every installed skill in the given scope for an upstream
 * update. Custom skills are excluded (no upstream); built-in /
 * github-import / marketplace each have their own check logic in
 * lib/skills-updates.ts.
 *
 * GitHub-import checks each cost one GitHub API call. The check is
 * user-initiated (button click), so we accept the cost and parallelise
 * up to 4 at a time to avoid hammering the API.
 *
 * Body: { factory_id, project_id? }
 * Returns: { results: UpdateCheckResult[] }
 */
import { NextRequest, NextResponse } from "next/server";
import { checkSkillUpdate, FactorySkillRow } from "@/lib/skills-updates";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { SkillsUpdatesCheckSchema } from "@/lib/api-schemas";
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

async function mapInBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, SkillsUpdatesCheckSchema);
    const { user, sb } = await getOperatorUser(req);
    await assertFactoryMember(sb, user.id, body.factory_id);

    let query = sb
      .from("factory_skills")
      .select("id, factory_id, project_id, slug, name, origin, source_url, source_version, source_commit_sha, body, category, description, updated_at, created_at")
      .eq("factory_id", body.factory_id)
      .neq("origin", "custom");
    if (body.project_id) query = query.eq("project_id", body.project_id);
    else                 query = query.is("project_id", null);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const skills = (data ?? []) as FactorySkillRow[];
    const results = await mapInBatches(skills, 4, (s) => checkSkillUpdate(sb, s));

    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
