/**
 * GitHub command import — same shape as github-skill-import.ts but
 * for slash commands. Slash commands are markdown files with optional
 * YAML frontmatter (name + description); the body is the prompt
 * template the operator wants behind /{slug}.
 *
 * Reuses helpers from github-skill-import (parseGitHubUrl +
 * fetchMarkdownFromGitHub) so URL resolution, SHA pinning, and the
 * raw fetch are identical to the skill path.
 */

import { fetchMarkdownFromGitHub, parseGitHubUrl, type GitHubRef } from "@/lib/github-skill-import";
import { slugify } from "@/lib/slugify";

export type CommandFrontmatter = {
  name?:        string;
  description?: string;
};

export type CommandFetchResult = {
  ref:         GitHubRef;
  sha:         string;
  rawUrl:      string;
  htmlUrl:     string;
  body:        string;
  frontmatter: CommandFrontmatter;
};

/**
 * Strip a YAML frontmatter block off the top of the markdown and pull
 * the two fields slash commands care about. Anything else gets
 * ignored — operators can edit after import.
 */
export function parseCommandFrontmatter(markdown: string): { frontmatter: CommandFrontmatter; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: markdown.trim() };
  }
  const yaml = match[1];
  const rest = match[2].trim();

  const fm: CommandFrontmatter = {};
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const colonAt = line.indexOf(":");
    if (colonAt < 0) continue;
    const key   = line.slice(0, colonAt).trim().toLowerCase();
    const value = stripQuotes(line.slice(colonAt + 1).trim());
    if (key === "name")        fm.name        = value;
    if (key === "description") fm.description = value;
  }
  return { frontmatter: fm, body: rest };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export async function fetchCommandFromGitHub(rawUrl: string): Promise<CommandFetchResult> {
  // Default file name = the file at the URL is the command itself; if
  // the URL points at a directory, look for command.md (Claude Code's
  // convention is one file per command — slug derived from filename).
  const fetched = await fetchMarkdownFromGitHub(rawUrl, { defaultFile: "command.md" });
  const { frontmatter, body } = parseCommandFrontmatter(fetched.content);
  return {
    ref:         fetched.ref,
    sha:         fetched.sha,
    rawUrl:      fetched.rawUrl,
    htmlUrl:     fetched.htmlUrl,
    body,
    frontmatter,
  };
}

/**
 * Default slug from the filename (preferred) or the repo name.
 * commands/run-tests.md → run-tests
 * commands/{owner}/{repo}/lint.md → lint
 */
export function suggestSlug(ref: GitHubRef): string {
  const last = ref.filePath.split("/").pop() ?? ref.repo;
  const seed = last.replace(/\.md$/i, "");
  return slugify(seed, { keepDashes: true });
}

// Re-export so callers don't need to import from two modules.
export { parseGitHubUrl };
