/**
 * POST /api/skills/curated-index/preview
 *
 * Fetch a curated-index markdown file (e.g. awesome-claude-skills
 * README.md), parse out the skill links, and return them grouped for
 * the operator to pick from. The actual install is delegated to
 * /api/skills/github-import — the UI loops over selected items.
 *
 * Body: { url }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchMarkdownFromGitHub, GitHubImportError } from "@/lib/github-skill-import";
import { parseCuratedIndex } from "@/lib/curated-index-parser";

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
}

export async function POST(req: NextRequest) {
  try {
    await assertAuth(req);
    const { url } = await req.json() as { url?: string };
    if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

    // Curated index URLs typically point at a repo root (→ README.md)
    // or directly at a markdown file via /blob/.
    const fetched = await fetchMarkdownFromGitHub(url, { defaultFile: "README.md" });
    const items = parseCuratedIndex(fetched.content);

    return NextResponse.json({
      ok: true,
      source: {
        owner:   fetched.ref.owner,
        repo:    fetched.ref.repo,
        ref:     fetched.ref.ref,
        path:    fetched.ref.filePath,
        sha:     fetched.sha,
        htmlUrl: fetched.htmlUrl,
      },
      items,
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
