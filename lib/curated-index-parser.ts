/**
 * Curated-index parser — Phase 5 Slice D.
 *
 * Parses an "awesome-X" style markdown index (e.g. awesome-claude-skills)
 * into a list of skill candidates the operator can batch-install. We
 * look for bullet lines containing a markdown link to a GitHub URL.
 * Headings (H2/H3) become section labels so the UI can group items.
 *
 * Description rules: anything after the link, separated by an em-dash
 * (—), en-dash (–), hyphen (-), or colon (:) is taken as the description.
 *
 * The parser is intentionally forgiving — these lists are operator-
 * curated wikis, not strictly-formatted data. Missing/garbled lines
 * are skipped, not errors.
 */

export type CuratedItem = {
  title:       string;
  url:         string;       // GitHub URL pointing at SKILL.md or skill dir
  description: string;
  section:     string;
};

const HEADING_RE = /^#{2,4}\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^\s*[-*+]\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*(?:[——–\-:]\s*(.*))?$/;

const NON_SKILL_HOST_HINTS = [
  "stars",       // shields.io badges
  "img.shields", // badges
  "/blob/master/CONTRIBUTING",
  "/blob/main/CONTRIBUTING",
  "/blob/main/CODE_OF_CONDUCT",
  "/blob/master/CODE_OF_CONDUCT",
  "/blob/main/LICENSE",
  "/blob/master/LICENSE",
];

export function parseCuratedIndex(markdown: string): CuratedItem[] {
  const items: CuratedItem[] = [];
  const seen  = new Set<string>();
  let currentSection = "Skills";
  let inFencedBlock  = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    // Skip code fences — bullet-looking content inside ``` shouldn't be
    // treated as skills.
    if (/^\s*```/.test(rawLine)) {
      inFencedBlock = !inFencedBlock;
      continue;
    }
    if (inFencedBlock) continue;

    const heading = rawLine.match(HEADING_RE);
    if (heading) {
      const title = heading[1].trim();
      // Filter out fluff sections that never carry skill links.
      if (!/^(table of contents|toc|contents|contributing|license|legend|introduction)$/i.test(title)) {
        currentSection = title;
      }
      continue;
    }

    const bullet = rawLine.match(BULLET_RE);
    if (!bullet) continue;
    const [, title, urlRaw, descRaw] = bullet;
    const url = urlRaw.trim();

    // Only keep links into github.com (covers blob, tree, raw, repo root).
    if (!/^https?:\/\/(www\.)?github\.com\//i.test(url)) continue;
    if (NON_SKILL_HOST_HINTS.some((h) => url.includes(h))) continue;

    // Drop links to other awesome-X master lists (recursive lists are
    // pointers to lists, not skills).
    if (/\/awesome-[^/]+\/?$/i.test(url) && !/\/(blob|tree)\//.test(url)) continue;

    const dedupeKey = url.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    items.push({
      title:       stripMd(title.trim()),
      url,
      description: stripMd((descRaw ?? "").trim()),
      section:     currentSection,
    });
  }

  return items;
}

function stripMd(s: string): string {
  // Strip surrounding bold/italic markers and inline images so the UI
  // doesn't render leftover markdown.
  return s
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\*+|\*+$/g, "")
    .replace(/^_+|_+$/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
