/**
 * POST /api/commands/curated-index/preview
 *
 * Three resolution modes — operator pastes any of these and we DTRT:
 *
 *   1. Repo root              (https://github.com/{owner}/{repo})
 *      → list `.md` under /commands/ subdir if it exists; fall back to
 *        README parse with markdown bullet links.
 *   2. Tree URL on a directory (.../tree/{ref}/{some/dir})
 *      → list `.md` files in that directory.
 *   3. Curated awesome-style README (.../tree/{ref}/README.md or
 *      .../blob/{ref}/{path}.md)
 *      → parse markdown bullet links into items (legacy mode).
 *
 * Mode 1's directory scan is what makes repos like
 * everything-claude-code work — they don't have a README full of
 * GitHub links, they have files under /commands/{slug}.md.
 *
 * Body: { url }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchMarkdownFromGitHub, GitHubImportError, parseGitHubUrl } from "@/lib/github-skill-import";
import { parseCuratedIndex, type CuratedItem } from "@/lib/curated-index-parser";

export const dynamic = "force-dynamic";

const COMMANDS_SUBDIR = "commands";

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

function authHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  return token
    ? { Authorization: `Bearer ${token}`, "User-Agent": "TwinPilot-curated-commands" }
    : { "User-Agent": "TwinPilot-curated-commands" };
}

interface GhEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

/**
 * List `.md` files under `{owner}/{repo}/{ref}/{path}`. Returns null
 * when the directory doesn't exist (404). Other failures throw.
 */
async function listMarkdownInDir(
  owner: string,
  repo:  string,
  ref:   string,
  path:  string,
): Promise<{ name: string; path: string }[] | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: { ...authHeaders(), Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (res.status === 404) return null;
  if (res.status === 403) throw new GitHubImportError("GitHub rate limit hit. Set GITHUB_TOKEN env to raise it to 5000 req/hour.", 429);
  if (!res.ok) throw new GitHubImportError(`GitHub list failed (${res.status})`, 502);
  const entries = (await res.json()) as GhEntry[];
  return entries
    .filter((e) => e.type === "file" && /\.md$/i.test(e.name) && !/^README\.md$/i.test(e.name))
    .map((e) => ({ name: e.name, path: e.path }));
}

function buildItemsFromDir(
  owner:   string,
  repo:    string,
  ref:     string,
  section: string,
  files:   { name: string; path: string }[],
): CuratedItem[] {
  return files.map((f) => ({
    title:       f.name.replace(/\.md$/i, ""),
    url:         `https://github.com/${owner}/${repo}/blob/${ref}/${f.path}`,
    description: "",
    section,
  }));
}

export async function POST(req: NextRequest) {
  try {
    await assertAuth(req);
    const { url } = await req.json() as { url?: string };
    if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

    // Inspect the URL shape to decide which resolution mode to use.
    // parseGitHubUrl normalises but doesn't tell us "this was a tree
    // URL" vs "this was a bare repo" — re-detect with a regex on the
    // raw input so we know which mode to attempt first.
    const trimmed = url.trim();
    const treeMatch = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/i.exec(trimmed);
    const bareMatch = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/?$/i.exec(trimmed);

    // ── Mode 2: explicit tree URL → list .md files in that dir ──────
    if (treeMatch) {
      const owner = treeMatch[1];
      const repo  = treeMatch[2].replace(/\.git$/i, "");
      const ref   = treeMatch[3];
      const path  = (treeMatch[4] ?? "").replace(/\/+$/g, "");
      const files = await listMarkdownInDir(owner, repo, ref, path);
      if (files === null) {
        return NextResponse.json({
          error: `Directory not found: ${path || "(root)"} on ${owner}/${repo}@${ref}`,
        }, { status: 404 });
      }
      const section = path ? path.split("/").pop() ?? "Commands" : "Commands";
      return NextResponse.json({
        ok: true,
        mode: "directory-scan",
        source: { owner, repo, ref, path: path || "/", htmlUrl: trimmed },
        items: buildItemsFromDir(owner, repo, ref, section.charAt(0).toUpperCase() + section.slice(1), files),
      });
    }

    // ── Mode 1: bare repo root → try /commands/, fall back to README ─
    if (bareMatch) {
      const owner = bareMatch[1];
      const repo  = bareMatch[2].replace(/\.git$/i, "");
      // Resolve default branch via the skill module's helper (it already
      // handles "main" fallback to whatever the repo uses).
      const ref = await resolveDefaultBranchSafe(owner, repo);
      const files = await listMarkdownInDir(owner, repo, ref, COMMANDS_SUBDIR);
      if (files !== null && files.length > 0) {
        return NextResponse.json({
          ok: true,
          mode: "directory-scan",
          source: { owner, repo, ref, path: COMMANDS_SUBDIR, htmlUrl: `https://github.com/${owner}/${repo}/tree/${ref}/${COMMANDS_SUBDIR}` },
          items: buildItemsFromDir(owner, repo, ref, "Commands", files),
        });
      }
      // Fall through to README parse.
    }

    // ── Mode 3: README parse (legacy awesome-list) ─────────────────
    const fetched = await fetchMarkdownFromGitHub(url, { defaultFile: "README.md" });
    const items = parseCuratedIndex(fetched.content);
    return NextResponse.json({
      ok: true,
      mode: "readme-parse",
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

/**
 * Resolve the repo's default branch. Falls back to "main" if the API
 * call fails (rate-limited or private repo), letting the caller's tree
 * URL still work for repos that follow the convention.
 */
async function resolveDefaultBranchSafe(owner: string, repo: string): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { ...authHeaders(), Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const body = await res.json() as { default_branch?: string };
      return body.default_branch ?? "main";
    }
  } catch { /* fall through */ }
  return "main";
}

// Re-use parseGitHubUrl so the import stays meaningful in the diff.
void parseGitHubUrl;
