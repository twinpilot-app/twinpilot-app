/**
 * POST /api/commands/github-import
 *
 * Persist a GitHub-imported slash command into factory_slash_commands
 * with origin='github-import' and full provenance.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchCommandFromGitHub } from "@/lib/github-command-import";
import { GitHubImportError } from "@/lib/github-skill-import";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { CommandsGithubImportSchema } from "@/lib/api-schemas";
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
    const body = await parseBody(req, CommandsGithubImportSchema);
    const { user, sb } = await getOperatorUser(req);
    await assertFactoryMember(sb, user.id, body.factory_id);

    const fetched = await fetchCommandFromGitHub(body.url);

    // Slug collision check within scope.
    const scopeFilter = body.project_id
      ? sb.from("factory_slash_commands")
          .select("id, name")
          .eq("factory_id", body.factory_id)
          .eq("project_id", body.project_id)
          .eq("slug", body.slug)
      : sb.from("factory_slash_commands")
          .select("id, name")
          .eq("factory_id", body.factory_id)
          .is("project_id", null)
          .eq("slug", body.slug);
    const { data: existing } = await scopeFilter;
    if (existing && existing.length > 0) {
      return NextResponse.json({
        error: `A slash command with slug "${body.slug}" already exists in this scope. Pick a different slug or delete first.`,
        code: "CONFLICT",
        existing_id: existing[0].id,
      }, { status: 409 });
    }

    const { data: inserted, error: insErr } = await sb
      .from("factory_slash_commands")
      .insert({
        factory_id:        body.factory_id,
        project_id:        body.project_id ?? null,
        slug:              body.slug,
        name:              body.name,
        description:       body.description ?? "",
        body:              fetched.body,
        origin:            "github-import",
        source_url:        fetched.htmlUrl,
        source_commit_sha: fetched.sha,
        source_version:    fetched.ref.ref,
      })
      .select("*")
      .single();
    if (insErr) throw new Error(insErr.message);

    return NextResponse.json({ ok: true, command: inserted }, { status: 201 });
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
