/**
 * POST /api/skills/github-import/preview
 *
 * Fetch + parse a GitHub-hosted SKILL.md without persisting it. The
 * operator confirms the parsed metadata in the import modal before we
 * commit a row to factory_skills via the sibling install endpoint.
 *
 * Body: { url }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchSkillFromGitHub, GitHubImportError, suggestSlug } from "@/lib/github-skill-import";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertAuth(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { user };
}

export async function POST(req: NextRequest) {
  try {
    await assertAuth(req);
    const { url } = await req.json() as { url?: string };
    if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

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
          owner:  result.ref.owner,
          repo:   result.ref.repo,
          ref:    result.ref.ref,
          path:   result.ref.filePath,
          sha:    result.sha,
          rawUrl: result.rawUrl,
          htmlUrl: result.htmlUrl,
        },
      },
    });
  } catch (e) {
    if (e instanceof GitHubImportError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
