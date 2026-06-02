/**
 * POST /api/skills/github-import
 *
 * Persist a GitHub-imported skill into factory_skills with
 * origin='github-import' and full provenance (source_url, source_commit_sha,
 * source_version=ref). The body has already been previewed via the sibling
 * /preview endpoint, but we re-fetch here so a tampered client payload
 * can't smuggle different content through.
 *
 * Body: { url, factory_id, project_id?, slug, name, description, category, allowed_tools?, disable_model_invocation? }
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchSkillFromGitHub, GitHubImportError } from "@/lib/github-skill-import";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { SkillsGithubImportSchema } from "@/lib/api-schemas";
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
    const body = await parseBody(req, SkillsGithubImportSchema);
    const { user, sb } = await getOperatorUser(req);
    await assertFactoryMember(sb, user.id, body.factory_id);

    // Re-fetch from GitHub (server-side) so the persisted body matches a
    // real SHA. We trust operator-edited slug/name/description/category
    // because those are UX choices, not content.
    const fetched = await fetchSkillFromGitHub(body.url);

    // Slug collision check within scope.
    const scopeFilter = body.project_id
      ? sb.from("factory_skills")
          .select("id, name")
          .eq("factory_id", body.factory_id)
          .eq("project_id", body.project_id)
          .eq("slug", body.slug)
      : sb.from("factory_skills")
          .select("id, name")
          .eq("factory_id", body.factory_id)
          .is("project_id", null)
          .eq("slug", body.slug);
    const { data: existing } = await scopeFilter;
    if (existing && existing.length > 0) {
      return NextResponse.json({
        error: `A skill with slug "${body.slug}" already exists in this scope. Pick a different slug or uninstall first.`,
        code: "CONFLICT",
        existing_id: existing[0].id,
      }, { status: 409 });
    }

    const { data: inserted, error: insErr } = await sb
      .from("factory_skills")
      .insert({
        factory_id:               body.factory_id,
        project_id:               body.project_id ?? null,
        slug:                     body.slug,
        name:                     body.name,
        description:              body.description,
        body:                     fetched.body,
        category:                 body.category,
        allowed_tools:            body.allowed_tools ?? fetched.frontmatter.allowedTools,
        disable_model_invocation: body.disable_model_invocation ?? fetched.frontmatter.disableModelInvocation,
        model_override:           fetched.frontmatter.modelOverride,
        origin:                   "github-import",
        source_url:               fetched.htmlUrl,
        source_commit_sha:        fetched.sha,
        source_version:           fetched.ref.ref,
      })
      .select("*")
      .single();
    if (insErr) throw new Error(insErr.message);

    return NextResponse.json({ ok: true, skill: inserted }, { status: 201 });
  } catch (e) {
    if (e instanceof GitHubImportError) {
      return NextResponse.json({ error: e.message, code: "GITHUB_IMPORT_ERROR" }, { status: e.status });
    }
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
