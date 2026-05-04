/**
 * GET /api/helpdocs
 *
 * Lists all markdown files in public/helpdocs/ with their frontmatter metadata.
 * Used by the Help page to build the document navigation.
 */

import { NextResponse } from "next/server";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

interface DocMeta {
  id: string;
  title: string;
  icon: string;
  category: string;
  order: number;
  color: string;
  parent?: string;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) meta[key] = val;
  }
  return { meta, body: content.slice(match[0].length) };
}

export async function GET() {
  try {
    const docsDir = join(process.cwd(), "public", "helpdocs");
    let files: string[];
    try {
      files = readdirSync(docsDir).filter((f) => f.endsWith(".md"));
    } catch {
      return NextResponse.json({ docs: [] });
    }

    const docs: DocMeta[] = files.map((filename) => {
      const content = readFileSync(join(docsDir, filename), "utf-8");
      const { meta } = parseFrontmatter(content);
      return {
        id: filename.replace(".md", ""),
        title: meta.title || filename.replace(".md", ""),
        icon: meta.icon || "📄",
        category: meta.category || "General",
        order: parseInt(meta.order ?? "99", 10),
        color: meta.color || "b",
        ...(meta.parent ? { parent: meta.parent } : {}),
      };
    }).sort((a, b) => a.order - b.order);

    return NextResponse.json({ docs });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
