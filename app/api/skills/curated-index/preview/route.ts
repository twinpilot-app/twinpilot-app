/**
 * POST /api/skills/curated-index/preview
 *
 * Three resolution modes — operator pastes any of these and we DTRT:
 *
 *   1. Repo root              (https://github.com/{owner}/{repo})
 *      → try `/skills/` subdir; if absent, scan root for `{slug}/SKILL.md`
 *        subdirs (covers awesome-claude-skills-style repos where every
 *        top-level directory is a skill). Final fallback: README parse.
 *   2. Tree URL on a directory (.../tree/{ref}/{some/dir})
 *      → scan the directory for `{slug}/SKILL.md` subdirs.
 *   3. Curated awesome-style README (.../tree/{ref}/README.md or
 *      .../blob/{ref}/{path}.md)
 *      → parse markdown bullet links into items (legacy mode).
 *
 * Skills differ from commands because the canonical layout is one
 * directory per skill with a SKILL.md inside (not flat .md files).
 * We use a single recursive trees API call to enumerate all skill
 * directories beneath a path, which scales to repos with hundreds
 * of skills (e.g. ComposioHQ/awesome-claude-skills/composio-skills).
 *
 * Body: { url }
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchMarkdownFromGitHub, GitHubImportError } from "@/lib/github-skill-import";
import { parseCuratedIndex, type CuratedItem } from "@/lib/curated-index-parser";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { UrlPreviewSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

const SKILLS_SUBDIR = "skills";

function authHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  return token
    ? { Authorization: `Bearer ${token}`, "User-Agent": "TwinPilot-curated-skills" }
    : { "User-Agent": "TwinPilot-curated-skills" };
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  sha:  string;
}

/**
 * Walk the recursive tree once and return every `{...}/SKILL.md` blob
 * whose immediate parent directory sits at `{base}/{slug}` (depth-1
 * children of base; depth-2 SKILL.md). Hidden dirs (starting with `.`)
 * are excluded so `.github`, `.claude-plugin` etc. are skipped.
 */
async function findSkillDirs(
  owner: string,
  repo:  string,
  ref:   string,
  base:  string,
): Promise<{ slug: string; path: string }[] | null> {
  // Resolve the base directory to a tree SHA so the recursive listing
  // is scoped — saves bandwidth on large repos like
  // awesome-claude-skills which has 700+ skills.
  let treeRef: string;
  if (!base) {
    treeRef = ref;
  } else {
    const dirRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${base}?ref=${encodeURIComponent(ref)}`,
      { headers: { ...authHeaders(), Accept: "application/vnd.github+json" }, cache: "no-store" },
    );
    if (dirRes.status === 404) return null;
    if (dirRes.status === 403) throw new GitHubImportError("GitHub rate limit hit. Set GITHUB_TOKEN to raise it.", 429);
    if (!dirRes.ok) throw new GitHubImportError(`GitHub list failed (${dirRes.status})`, 502);
    // Contents endpoint on a directory returns an array; pick the
    // tree-level sha by re-querying the parent so we can scope the
    // recursive call.
    const parentPath = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
    const baseSlug = base.split("/").pop()!;
    const parentUrl = parentPath
      ? `https://api.github.com/repos/${owner}/${repo}/contents/${parentPath}?ref=${encodeURIComponent(ref)}`
      : `https://api.github.com/repos/${owner}/${repo}/contents?ref=${encodeURIComponent(ref)}`;
    const parentRes = await fetch(parentUrl, { headers: { ...authHeaders(), Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (!parentRes.ok) throw new GitHubImportError(`GitHub list failed (${parentRes.status})`, 502);
    const parentEntries = (await parentRes.json()) as { name: string; type: "file" | "dir"; sha: string }[];
    const ownEntry = parentEntries.find((e) => e.name === baseSlug && e.type === "dir");
    if (!ownEntry) return null;
    treeRef = ownEntry.sha;
  }

  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${treeRef}?recursive=1`,
    { headers: { ...authHeaders(), Accept: "application/vnd.github+json" }, cache: "no-store" },
  );
  if (treeRes.status === 404) return null;
  if (treeRes.status === 403) throw new GitHubImportError("GitHub rate limit hit. Set GITHUB_TOKEN to raise it.", 429);
  if (!treeRes.ok) throw new GitHubImportError(`GitHub tree failed (${treeRes.status})`, 502);
  const tree = (await treeRes.json()) as { tree: TreeEntry[]; truncated: boolean };

  // Find every depth-1 dir whose direct child is SKILL.md. The tree
  // entries are already relative to treeRef, so a depth-2 entry of
  // shape "{slug}/SKILL.md" identifies the skill dir.
  const skills: { slug: string; path: string }[] = [];
  for (const e of tree.tree) {
    if (e.type !== "blob") continue;
    if (!/(^|\/)SKILL\.md$/i.test(e.path)) continue;
    const parts = e.path.split("/");
    // Only skill manifests directly under {base}/{slug}/SKILL.md
    if (parts.length !== 2) continue;
    const slug = parts[0];
    if (slug.startsWith(".")) continue;
    const fullPath = base ? `${base}/${slug}` : slug;
    skills.push({ slug, path: fullPath });
  }
  return skills;
}

function buildItemsFromSkills(
  owner:   string,
  repo:    string,
  ref:     string,
  section: string,
  skills:  { slug: string; path: string }[],
): CuratedItem[] {
  return skills.map((s) => ({
    title:       s.slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    url:         `https://github.com/${owner}/${repo}/tree/${ref}/${s.path}`,
    description: "",
    section,
  }));
}

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

export async function POST(req: NextRequest) {
  try {
    const { url } = await parseBody(req, UrlPreviewSchema);
    await getOperatorUser(req);

    const trimmed = url.trim();
    const treeMatch = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/i.exec(trimmed);
    const bareMatch = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/?$/i.exec(trimmed);

    // ── Mode 2: explicit tree URL → scan dir for {slug}/SKILL.md ─────
    if (treeMatch) {
      const owner = treeMatch[1];
      const repo  = treeMatch[2].replace(/\.git$/i, "");
      const ref   = treeMatch[3];
      const path  = (treeMatch[4] ?? "").replace(/\/+$/g, "");
      const skills = await findSkillDirs(owner, repo, ref, path);
      if (skills === null) {
        return NextResponse.json({
          error: `Directory not found: ${path || "(root)"} on ${owner}/${repo}@${ref}`,
        }, { status: 404 });
      }
      if (skills.length === 0) {
        return NextResponse.json({
          error: `No skills (subdirs with SKILL.md) found at ${path || "(root)"} on ${owner}/${repo}@${ref}.`,
        }, { status: 404 });
      }
      const section = path ? path.split("/").pop() ?? "Skills" : "Skills";
      return NextResponse.json({
        ok: true,
        mode: "directory-scan",
        source: { owner, repo, ref, path: path || "/", htmlUrl: trimmed },
        items: buildItemsFromSkills(owner, repo, ref, section.charAt(0).toUpperCase() + section.slice(1), skills),
      });
    }

    // ── Mode 1: bare repo root → try /skills/, then root scan ────────
    if (bareMatch) {
      const owner = bareMatch[1];
      const repo  = bareMatch[2].replace(/\.git$/i, "");
      const ref   = await resolveDefaultBranchSafe(owner, repo);

      // 1a. Conventional /skills/ subdir
      const inSubdir = await findSkillDirs(owner, repo, ref, SKILLS_SUBDIR);
      if (inSubdir && inSubdir.length > 0) {
        return NextResponse.json({
          ok: true,
          mode: "directory-scan",
          source: { owner, repo, ref, path: SKILLS_SUBDIR, htmlUrl: `https://github.com/${owner}/${repo}/tree/${ref}/${SKILLS_SUBDIR}` },
          items: buildItemsFromSkills(owner, repo, ref, "Skills", inSubdir),
        });
      }

      // 1b. Root-as-collection layout (awesome-claude-skills)
      const atRoot = await findSkillDirs(owner, repo, ref, "");
      if (atRoot && atRoot.length > 0) {
        return NextResponse.json({
          ok: true,
          mode: "directory-scan",
          source: { owner, repo, ref, path: "/", htmlUrl: `https://github.com/${owner}/${repo}/tree/${ref}` },
          items: buildItemsFromSkills(owner, repo, ref, "Skills", atRoot),
        });
      }

      // Fall through to README parse — some awesome-lists are pure
      // markdown indexes pointing at OTHER repos.
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
      return NextResponse.json({ error: e.message, code: "GITHUB_IMPORT_ERROR" }, { status: e.status });
    }
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
