/**
 * POST /api/skills/github-import/preview
 *
 * Fetch + parse a GitHub-hosted SKILL.md without persisting it.
 *
 * Body: { url } — validated by UrlPreviewSchema.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchSkillFromGitHub, GitHubImportError, suggestSlug } from "@/lib/github-skill-import";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { UrlPreviewSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { url } = await parseBody(req, UrlPreviewSchema);
    await getOperatorUser(req);

    const result = await fetchSkillFromGitHub(url);
    return NextResponse.json({
      ok: true,
      preview: {
        slug:         suggestSlug(result.ref),
        name:         result.frontmatter.name ?? result.ref.filePath,
        description:  result.frontmatter.description ?? "",
        body:         result.body,
        allowed_tools:            result.frontmatter.allowedTools,
        disable_model_invocation: result.frontmatter.disableModelInvocation,
        model_override:           result.frontmatter.modelOverride,
        source: {
          owner:   result.ref.owner,
          repo:    result.ref.repo,
          ref:     result.ref.ref,
          path:    result.ref.filePath,
          sha:     result.sha,
          rawUrl:  result.rawUrl,
          htmlUrl: result.htmlUrl,
        },
      },
    });
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
