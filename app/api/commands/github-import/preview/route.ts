/**
 * POST /api/commands/github-import/preview
 *
 * Read-only preview of a slash command in a GitHub repo. Operator
 * pastes a URL, we fetch + parse + suggest, nothing persisted.
 *
 * Body: { url } — validated by UrlPreviewSchema.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchCommandFromGitHub, suggestSlug } from "@/lib/github-command-import";
import { GitHubImportError } from "@/lib/github-skill-import";
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

    const fetched = await fetchCommandFromGitHub(url);
    return NextResponse.json({
      ok: true,
      preview: {
        ref:           fetched.ref,
        sha:           fetched.sha,
        rawUrl:        fetched.rawUrl,
        htmlUrl:       fetched.htmlUrl,
        suggestedSlug: suggestSlug(fetched.ref),
        suggestedName: fetched.frontmatter.name ?? suggestSlug(fetched.ref),
        suggestedDesc: fetched.frontmatter.description ?? "",
        body:          fetched.body,
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
