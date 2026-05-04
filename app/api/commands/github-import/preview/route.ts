/**
 * POST /api/commands/github-import/preview
 *
 * Read-only preview of a slash command that lives in a GitHub repo.
 * The operator pastes a URL; we parse the URL, resolve the ref to a
 * commit SHA, fetch SKILL-style frontmatter + body, and return a
 * payload the UI uses to seed the import form. Nothing is persisted.
 *
 * Body: { url }
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchCommandFromGitHub, suggestSlug } from "@/lib/github-command-import";
import { GitHubImportError } from "@/lib/github-skill-import";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization");
    if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json() as { url?: string };
    if (!body.url) return NextResponse.json({ error: "url is required" }, { status: 400 });

    const fetched = await fetchCommandFromGitHub(body.url);
    return NextResponse.json({
      ok: true,
      preview: {
        ref:               fetched.ref,
        sha:               fetched.sha,
        rawUrl:            fetched.rawUrl,
        htmlUrl:           fetched.htmlUrl,
        suggestedSlug:     suggestSlug(fetched.ref),
        suggestedName:     fetched.frontmatter.name ?? suggestSlug(fetched.ref),
        suggestedDesc:     fetched.frontmatter.description ?? "",
        body:              fetched.body,
      },
    });
  } catch (e) {
    if (e instanceof GitHubImportError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
