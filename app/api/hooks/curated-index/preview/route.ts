/**
 * POST /api/hooks/curated-index/preview
 *
 * Hooks travel as JSON bundles in the wild — community repos publish a
 * `hooks.json` (or similar) at a known path containing the upstream
 * settings.json shape:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         { "matcher": "Bash",
 *           "hooks": [{ "type": "command", "command": "...", "timeout": 60 }],
 *           "description": "...", "id": "pre:bash:dispatcher" }
 *       ],
 *       "PostToolUse": [...]
 *     }
 *   }
 *
 * We flatten that into one item per (event, matcher, command) tuple so
 * the operator can pick individual hooks instead of installing the whole
 * bundle blindly. The id field becomes the curated-item identifier;
 * the install endpoint (POST /api/hooks/github-import) re-fetches the
 * JSON, looks the id up, and persists a single factory_hooks row.
 *
 * Three URL resolution modes mirror the skills/commands routes:
 *
 *   1. Repo root              (https://github.com/{owner}/{repo})
 *      → try `/hooks/` subdir; if absent, scan root for `*.json` files.
 *   2. Tree URL on a directory (.../tree/{ref}/{some/dir})
 *      → list `*.json` files in that directory.
 *   3. Blob URL on a JSON file (.../blob/{ref}/{path}.json)
 *      → parse just that file.
 *
 * Body: { url }
 */
import { NextRequest, NextResponse } from "next/server";
import { GitHubImportError } from "@/lib/github-skill-import";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { UrlPreviewSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

const HOOKS_SUBDIR = "hooks";

const VALID_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "UserPromptSubmit",
  "Notification", "Stop", "SubagentStop",
  "PreCompact", "SessionStart", "SessionEnd",
]);


function authHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  return token
    ? { Authorization: `Bearer ${token}`, "User-Agent": "TwinPilot-curated-hooks" }
    : { "User-Agent": "TwinPilot-curated-hooks" };
}

interface GhEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  sha:  string;
}

interface HookCommandEntry {
  type:        "command";
  command:     string;
  timeout?:    number;
  async?:      boolean;
  description?: string;
}

interface HookGroup {
  matcher?:    string;
  hooks:       HookCommandEntry[];
  description?: string;
  id?:         string;
}

interface UpstreamSettings {
  hooks?: Record<string, HookGroup[]>;
}

export interface HookCuratedItem {
  /** Slug-ish identifier scoped to the source file. */
  id:           string;
  /** Display title — derived from id or top-level description. */
  title:        string;
  /** One-line description for the picker. */
  description:  string;
  /** GitHub blob URL of the JSON file this entry came from. */
  url:          string;
  /** Section label for grouping in the picker = the lifecycle event. */
  section:      string;
  /** Hook event (PreToolUse / Stop / etc.). */
  event:        string;
  /** Optional matcher (tool name regex / glob). */
  matcher:      string | null;
  /** Shell command. */
  command:      string;
  /** Hook timeout (seconds). */
  timeoutSecs:  number;
}

/** Normalise an upstream settings.json hooks bundle into curated items. */
function flattenHookBundle(
  blobUrl: string,
  contents: UpstreamSettings,
): HookCuratedItem[] {
  const out: HookCuratedItem[] = [];
  if (!contents.hooks || typeof contents.hooks !== "object") return out;

  let counter = 0;
  for (const [event, groups] of Object.entries(contents.hooks)) {
    if (!VALID_EVENTS.has(event)) continue;
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;

      for (const cmdEntry of group.hooks) {
        if (!cmdEntry || cmdEntry.type !== "command" || !cmdEntry.command) continue;

        const matcher = group.matcher ?? null;
        const id = group.id
          ?? cmdEntry.description?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
          ?? `hook-${event.toLowerCase()}-${counter}`;
        counter++;

        const description = group.description ?? cmdEntry.description ?? "";
        const title = group.id ?? description ?? `${event} hook`;

        out.push({
          id,
          title:       title.length > 80 ? `${title.slice(0, 77)}…` : title,
          description,
          url:         blobUrl,
          section:     event,
          event,
          matcher,
          command:     cmdEntry.command,
          timeoutSecs: typeof cmdEntry.timeout === "number" ? cmdEntry.timeout : 60,
        });
      }
    }
  }
  return out;
}

async function listJsonInDir(
  owner: string,
  repo:  string,
  ref:   string,
  path:  string,
): Promise<{ name: string; path: string }[] | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: { ...authHeaders(), Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (res.status === 404) return null;
  if (res.status === 403) throw new GitHubImportError("GitHub rate limit hit. Set GITHUB_TOKEN to raise it.", 429);
  if (!res.ok) throw new GitHubImportError(`GitHub list failed (${res.status})`, 502);
  const entries = (await res.json()) as GhEntry[];
  return entries
    .filter((e) => e.type === "file" && /\.json$/i.test(e.name))
    .map((e) => ({ name: e.name, path: e.path }));
}

async function fetchAndParseJson(
  owner: string,
  repo:  string,
  ref:   string,
  path:  string,
): Promise<{ items: HookCuratedItem[]; sha: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: { ...authHeaders(), Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (res.status === 404) throw new GitHubImportError(`File not found: ${path}`, 404);
  if (res.status === 403) throw new GitHubImportError("GitHub rate limit hit. Set GITHUB_TOKEN to raise it.", 429);
  if (!res.ok) throw new GitHubImportError(`GitHub fetch failed (${res.status})`, 502);

  const meta = await res.json() as { content?: string; encoding?: string; sha: string };
  if (!meta.content || meta.encoding !== "base64") {
    throw new GitHubImportError(`Unexpected response shape for ${path}`, 502);
  }
  const raw = Buffer.from(meta.content, "base64").toString("utf-8");

  let parsed: UpstreamSettings;
  try {
    parsed = JSON.parse(raw) as UpstreamSettings;
  } catch (e) {
    throw new GitHubImportError(`Invalid JSON in ${path}: ${(e as Error).message}`, 422);
  }

  const blobUrl = `https://github.com/${owner}/${repo}/blob/${ref}/${path}`;
  return { items: flattenHookBundle(blobUrl, parsed), sha: meta.sha };
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
    const blobMatch = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(trimmed);
    const treeMatch = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/i.exec(trimmed);
    const bareMatch = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/?$/i.exec(trimmed);

    // ── Mode 3: blob URL → parse just that file ─────────────────────
    if (blobMatch) {
      const owner = blobMatch[1];
      const repo  = blobMatch[2].replace(/\.git$/i, "");
      const ref   = blobMatch[3];
      const path  = blobMatch[4];
      const { items, sha } = await fetchAndParseJson(owner, repo, ref, path);
      return NextResponse.json({
        ok: true,
        mode: "single-file",
        source: { owner, repo, ref, path, sha, htmlUrl: trimmed },
        items,
      });
    }

    // ── Mode 2: tree URL → list .json in dir, parse each ────────────
    if (treeMatch) {
      const owner = treeMatch[1];
      const repo  = treeMatch[2].replace(/\.git$/i, "");
      const ref   = treeMatch[3];
      const path  = (treeMatch[4] ?? "").replace(/\/+$/g, "");
      const files = await listJsonInDir(owner, repo, ref, path);
      if (files === null) {
        return NextResponse.json({
          error: `Directory not found: ${path || "(root)"} on ${owner}/${repo}@${ref}`,
        }, { status: 404 });
      }
      const allItems: HookCuratedItem[] = [];
      for (const f of files) {
        try {
          const { items } = await fetchAndParseJson(owner, repo, ref, f.path);
          allItems.push(...items);
        } catch { /* per-file errors don't kill the batch */ }
      }
      return NextResponse.json({
        ok: true,
        mode: "directory-scan",
        source: { owner, repo, ref, path: path || "/", htmlUrl: trimmed },
        items: allItems,
      });
    }

    // ── Mode 1: bare repo → try /hooks/, fall back to root ──────────
    if (bareMatch) {
      const owner = bareMatch[1];
      const repo  = bareMatch[2].replace(/\.git$/i, "");
      const ref   = await resolveDefaultBranchSafe(owner, repo);

      const inSubdir = await listJsonInDir(owner, repo, ref, HOOKS_SUBDIR);
      if (inSubdir && inSubdir.length > 0) {
        const allItems: HookCuratedItem[] = [];
        for (const f of inSubdir) {
          try {
            const { items } = await fetchAndParseJson(owner, repo, ref, f.path);
            allItems.push(...items);
          } catch { /* skip */ }
        }
        return NextResponse.json({
          ok: true,
          mode: "directory-scan",
          source: { owner, repo, ref, path: HOOKS_SUBDIR, htmlUrl: `https://github.com/${owner}/${repo}/tree/${ref}/${HOOKS_SUBDIR}` },
          items: allItems,
        });
      }

      const atRoot = await listJsonInDir(owner, repo, ref, "");
      if (atRoot && atRoot.length > 0) {
        const allItems: HookCuratedItem[] = [];
        for (const f of atRoot) {
          try {
            const { items } = await fetchAndParseJson(owner, repo, ref, f.path);
            allItems.push(...items);
          } catch { /* skip */ }
        }
        return NextResponse.json({
          ok: true,
          mode: "directory-scan",
          source: { owner, repo, ref, path: "/", htmlUrl: `https://github.com/${owner}/${repo}/tree/${ref}` },
          items: allItems,
        });
      }

      return NextResponse.json({
        error: `No .json hook bundles found at /hooks/ or repo root on ${owner}/${repo}@${ref}.`,
      }, { status: 404 });
    }

    return NextResponse.json({
      error: "Unrecognised GitHub URL. Paste a blob, tree, or repo root URL.",
    }, { status: 400 });
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
