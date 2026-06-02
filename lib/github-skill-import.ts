/**
 * GitHub skill import — Phase 5 Slice C.
 *
 * Operators paste a GitHub URL and we fetch the SKILL.md, parse its
 * YAML frontmatter, and resolve the branch/tag to a commit SHA so the
 * import is reproducible. Three URL forms are accepted:
 *
 *   blob: https://github.com/{owner}/{repo}/blob/{ref}/{path/to/SKILL.md}
 *   tree: https://github.com/{owner}/{repo}/tree/{ref}/{path/to/skill-dir}
 *   raw:  https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 *
 * For tree URLs we append "/SKILL.md" automatically. For blob URLs we
 * fetch the path as-is. We hit raw.githubusercontent.com for content
 * and api.github.com for SHA resolution — both unauthenticated by
 * default (60 req/hour). Setting GITHUB_TOKEN env raises the limit
 * to 5000 req/hour and unlocks private repos for tenants that want it.
 */

import { slugify } from "@/lib/slugify";

export type GitHubRef = {
  owner:    string;
  repo:     string;
  ref:      string;
  filePath: string;
};

export type ParsedFrontmatter = {
  name?:                       string;
  description?:                string;
  allowedTools:                string[];
  disableModelInvocation:      boolean;
  modelOverride:               string | null;
};

export type SkillFetchResult = {
  ref:        GitHubRef;
  sha:        string;
  rawUrl:     string;
  htmlUrl:    string;
  body:       string;
  frontmatter: ParsedFrontmatter;
};

export class GitHubImportError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
  }
}

/**
 * Parse one of the three accepted URL forms into a GitHubRef.
 * Throws GitHubImportError if the URL doesn't match any known shape.
 *
 * `defaultFile` is appended to tree URLs and used as the path for bare
 * repo URLs. SKILL.md by default; curated-index callers pass README.md.
 */
export function parseGitHubUrl(input: string, opts?: { defaultFile?: string }): GitHubRef {
  const defaultFile = opts?.defaultFile ?? "SKILL.md";
  const trimmed = input.trim();
  if (!trimmed) throw new GitHubImportError("URL is empty.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GitHubImportError("Not a valid URL.");
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);

  if (host === "raw.githubusercontent.com") {
    // /{owner}/{repo}/{ref}/{path...}
    if (segments.length < 4) {
      throw new GitHubImportError("Raw URL must include owner/repo/ref/path.");
    }
    const [owner, repo, ref, ...pathParts] = segments;
    return assembleRef(owner, repo, ref, pathParts.join("/"), false, defaultFile);
  }

  if (host === "github.com" || host === "www.github.com") {
    // /{owner}/{repo}/(blob|tree)/{ref}/{path...}
    // also accept bare /{owner}/{repo} → defaults to main + defaultFile at root
    if (segments.length < 2) {
      throw new GitHubImportError("URL must include owner and repo.");
    }
    const [owner, repo, kind, ref, ...pathParts] = segments;
    if (!kind) {
      // bare repo URL — assume main branch, defaultFile at root
      return assembleRef(owner, repo, "main", "", true, defaultFile);
    }
    if (kind !== "blob" && kind !== "tree") {
      throw new GitHubImportError(`Unsupported URL shape: /${kind}/. Use /blob/ or /tree/.`);
    }
    if (!ref) throw new GitHubImportError("URL is missing the branch/tag/sha.");
    return assembleRef(owner, repo, ref, pathParts.join("/"), kind === "tree", defaultFile);
  }

  throw new GitHubImportError(`Host not supported: ${host}. Use github.com or raw.githubusercontent.com.`);
}

function assembleRef(owner: string, repo: string, ref: string, rawPath: string, isDir: boolean, defaultFile: string): GitHubRef {
  if (!owner || !repo) throw new GitHubImportError("URL is missing owner or repo.");
  // Strip a trailing .git from cloned-style URLs.
  const cleanRepo = repo.replace(/\.git$/i, "");
  let filePath = rawPath.replace(/^\/+|\/+$/g, "");
  if (isDir || filePath === "") {
    filePath = filePath ? `${filePath}/${defaultFile}` : defaultFile;
  }
  return { owner, repo: cleanRepo, ref, filePath };
}

function authHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  return token
    ? { Authorization: `Bearer ${token}`, "User-Agent": "TwinPilot-skill-import" }
    : { "User-Agent": "TwinPilot-skill-import" };
}

async function resolveDefaultBranch(owner: string, repo: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { ...authHeaders(), Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return null;
  const body = await res.json() as { default_branch?: string };
  return body.default_branch ?? null;
}

/**
 * Resolve a ref to a commit SHA. When the URL was bare (no /blob/, no
 * /tree/) we synthesize ref="main", which fails with 422 on repos whose
 * default branch is "master" (or anything else). On 404/422 with the
 * synthesized "main" ref, fetch the repo's actual default branch and
 * retry. The resolved ref name is returned so source_version is stamped
 * truthfully.
 */
async function resolveRefToSha(ref: GitHubRef): Promise<{ sha: string; resolvedRef: string }> {
  const attempt = async (refName: string) => {
    const apiUrl = `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${refName}`;
    return fetch(apiUrl, { headers: { ...authHeaders(), Accept: "application/vnd.github+json" } });
  };

  let res = await attempt(ref.ref);
  let resolvedRef = ref.ref;

  if ((res.status === 404 || res.status === 422) && ref.ref === "main") {
    const fallback = await resolveDefaultBranch(ref.owner, ref.repo);
    if (fallback && fallback !== "main") {
      res = await attempt(fallback);
      resolvedRef = fallback;
    }
  }

  if (res.status === 404) throw new GitHubImportError("Repo or ref not found (or repo is private — set GITHUB_TOKEN to access private repos).", 404);
  if (res.status === 422) throw new GitHubImportError(`Branch/tag "${ref.ref}" not found in ${ref.owner}/${ref.repo}.`, 404);
  if (res.status === 403) throw new GitHubImportError("GitHub rate limit hit. Set GITHUB_TOKEN env to raise it to 5000 req/hour.", 429);
  if (!res.ok) throw new GitHubImportError(`GitHub API error: ${res.status}`, 502);
  const body = await res.json() as { sha?: string };
  if (!body.sha) throw new GitHubImportError("GitHub API did not return a SHA.", 502);
  return { sha: body.sha, resolvedRef };
}

async function fetchRawContent(ref: GitHubRef, sha: string): Promise<string> {
  // Use the resolved SHA so the body and provenance line up exactly.
  const rawUrl = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${sha}/${ref.filePath}`;
  const res = await fetch(rawUrl, { headers: authHeaders() });
  if (res.status === 404) throw new GitHubImportError(`File not found: ${ref.filePath}`, 404);
  if (!res.ok) throw new GitHubImportError(`GitHub raw fetch error: ${res.status}`, 502);
  return res.text();
}

/**
 * Strip a YAML frontmatter block off the top of the markdown and parse
 * the handful of fields TwinPilot cares about. Anything else is
 * ignored — operators can edit the imported skill afterwards.
 */
export function parseFrontmatter(markdown: string): { frontmatter: ParsedFrontmatter; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: { allowedTools: [], disableModelInvocation: false, modelOverride: null },
      body: markdown.trim(),
    };
  }
  const yaml = match[1];
  const rest = match[2].trim();

  const fm: ParsedFrontmatter = {
    allowedTools: [],
    disableModelInvocation: false,
    modelOverride: null,
  };

  // Naive line-by-line parser. Handles "key: value" and inline arrays
  // [a, b]. Multi-line block arrays are not supported — operators are
  // expected to flatten them or edit after import.
  const lines = yaml.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/^\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const colonAt = line.indexOf(":");
    if (colonAt < 0) continue;
    const key = line.slice(0, colonAt).trim().toLowerCase();
    const valueRaw = line.slice(colonAt + 1).trim();
    const value = stripQuotes(valueRaw);
    switch (key) {
      case "name":
        fm.name = value;
        break;
      case "description":
        fm.description = value;
        break;
      case "allowed-tools":
      case "allowed_tools":
        fm.allowedTools = parseInlineArray(valueRaw);
        break;
      case "disable-model-invocation":
      case "disable_model_invocation":
        fm.disableModelInvocation = value === "true" || value === "yes" || value === "1";
        break;
      case "model":
        fm.modelOverride = value || null;
        break;
    }
  }

  return { frontmatter: fm, body: rest };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseInlineArray(raw: string): string[] {
  // Accept either "[a, b, c]" or "a, b, c" or "Read,Write".
  const inner = raw.replace(/^\[|\]$/g, "");
  return inner.split(",").map((s) => stripQuotes(s.trim())).filter(Boolean);
}

/**
 * Fetch a markdown file (typically a curated-index README) without
 * frontmatter parsing. Used by the curated-index endpoint.
 */
export async function fetchMarkdownFromGitHub(input: string, opts?: { defaultFile?: string }): Promise<{
  ref:     GitHubRef;
  sha:     string;
  rawUrl:  string;
  htmlUrl: string;
  content: string;
}> {
  const initialRef = parseGitHubUrl(input, opts);
  const { sha, resolvedRef } = await resolveRefToSha(initialRef);
  const ref: GitHubRef = { ...initialRef, ref: resolvedRef };
  const content = await fetchRawContent(ref, sha);
  return {
    ref,
    sha,
    rawUrl:  `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${sha}/${ref.filePath}`,
    htmlUrl: `https://github.com/${ref.owner}/${ref.repo}/blob/${sha}/${ref.filePath}`,
    content,
  };
}

export async function fetchSkillFromGitHub(rawUrl: string): Promise<SkillFetchResult> {
  const initialRef = parseGitHubUrl(rawUrl);
  const { sha, resolvedRef } = await resolveRefToSha(initialRef);
  const ref: GitHubRef = { ...initialRef, ref: resolvedRef };
  const md  = await fetchRawContent(ref, sha);
  const { frontmatter, body } = parseFrontmatter(md);
  return {
    ref,
    sha,
    rawUrl: `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${sha}/${ref.filePath}`,
    htmlUrl: `https://github.com/${ref.owner}/${ref.repo}/blob/${sha}/${ref.filePath}`,
    body,
    frontmatter,
  };
}

/**
 * Default slug from the repo + skill directory. e.g.
 * anthropics/skills/document-skills/pdf → document-skills-pdf
 * If the file is at root, fall back to the repo name.
 */
export function suggestSlug(ref: GitHubRef): string {
  const dir = ref.filePath.replace(/\/SKILL\.md$/i, "").replace(/\.md$/i, "");
  const seed = dir || ref.repo;
  return slugify(seed, { keepDashes: true });
}
