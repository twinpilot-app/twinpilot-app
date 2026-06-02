"use client";

import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  memo,
} from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import GithubSlugger from "github-slugger";
import { HelpCircle, Search, Clock, ChevronRight } from "lucide-react";
import AppSidebar from "@/components/AppSidebar";
import { useAuth } from "@/lib/auth-context";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DocMeta {
  id: string;
  title: string;
  icon: string;
  category: string;
  order: number;
  color: string;
  parent?: string;
}

interface TocEntry {
  depth: number;
  text: string;
  slug: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const COLOR_MAP: Record<string, { main: string; soft: string }> = {
  b: { main: "var(--blue)",   soft: "rgba(20,99,255,0.08)" },
  g: { main: "var(--green)",  soft: "rgba(28,191,107,0.08)" },
  v: { main: "var(--mauve)",  soft: "rgba(203,166,247,0.08)" },
  a: { main: "var(--yellow)", soft: "rgba(249,226,175,0.08)" },
  r: { main: "var(--red)",    soft: "rgba(237,67,55,0.08)" },
  c: { main: "var(--teal)",   soft: "rgba(148,226,213,0.08)" },
};

const DEFAULT_COLOR = { main: "var(--blue)", soft: "rgba(20,99,255,0.08)" };

const REMARK_PLUGINS = [remarkGfm] as const;
const REHYPE_PLUGINS = [rehypeSlug] as const;

/* ------------------------------------------------------------------ */
/*  Frontmatter parser                                                 */
/* ------------------------------------------------------------------ */

function parseFrontmatter(raw: string): { content: string; meta: Record<string, string> } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { content: raw, meta: {} };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { content: raw.slice(match[0].length).trim(), meta };
}

/* ------------------------------------------------------------------ */
/*  TOC extractor                                                      */
/* ------------------------------------------------------------------ */

function extractToc(markdown: string): TocEntry[] {
  const slugger = new GithubSlugger();
  const entries: TocEntry[] = [];
  const re = /^(#{1,3})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const text = m[2].replace(/[*_`~\[\]]/g, "").trim();
    entries.push({ depth: m[1].length, text, slug: slugger.slug(text) });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/*  Reading time                                                       */
/* ------------------------------------------------------------------ */

function readingTime(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 200));
}

/* ------------------------------------------------------------------ */
/*  makeComponents — react-markdown custom renderers                   */
/* ------------------------------------------------------------------ */

function makeComponents(accent: { main: string; soft: string }) {
  return {
    h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h1
        {...props}
        style={{
          fontSize: 26,
          fontWeight: 800,
          fontFamily: "var(--font-sans)",
          color: "var(--text)",
          margin: "36px 0 16px",
          lineHeight: 1.3,
          borderBottom: `2px solid ${accent.main}`,
          paddingBottom: 8,
        }}
      >
        {children}
      </h1>
    ),
    h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h2
        {...props}
        style={{
          fontSize: 20,
          fontWeight: 700,
          fontFamily: "var(--font-sans)",
          color: "var(--text)",
          margin: "32px 0 12px",
          lineHeight: 1.35,
        }}
      >
        {children}
      </h2>
    ),
    h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h3
        {...props}
        style={{
          fontSize: 16,
          fontWeight: 600,
          fontFamily: "var(--font-sans)",
          color: "var(--text)",
          margin: "24px 0 8px",
          lineHeight: 1.4,
        }}
      >
        {children}
      </h3>
    ),
    p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
      <p
        {...props}
        style={{
          fontSize: 14,
          lineHeight: 1.75,
          color: "var(--subtext0)",
          margin: "0 0 14px",
        }}
      >
        {children}
      </p>
    ),
    ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
      <ul
        {...props}
        style={{
          paddingLeft: 20,
          margin: "0 0 14px",
          fontSize: 14,
          lineHeight: 1.75,
          color: "var(--subtext0)",
        }}
      >
        {children}
      </ul>
    ),
    ol: ({ children, ...props }: React.HTMLAttributes<HTMLOListElement>) => (
      <ol
        {...props}
        style={{
          paddingLeft: 20,
          margin: "0 0 14px",
          fontSize: 14,
          lineHeight: 1.75,
          color: "var(--subtext0)",
        }}
      >
        {children}
      </ol>
    ),
    li: ({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) => (
      <li {...props} style={{ marginBottom: 4 }}>
        {children}
      </li>
    ),
    a: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a
        {...props}
        href={href}
        target={href?.startsWith("http") ? "_blank" : undefined}
        rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
        style={{ color: accent.main, textDecoration: "none", fontWeight: 500 }}
      >
        {children}
      </a>
    ),
    blockquote: ({ children, ...props }: React.HTMLAttributes<HTMLQuoteElement>) => (
      <blockquote
        {...props}
        style={{
          borderLeft: `3px solid ${accent.main}`,
          background: accent.soft,
          margin: "0 0 14px",
          padding: "10px 16px",
          borderRadius: 6,
          fontSize: 13,
          color: "var(--subtext0)",
        }}
      >
        {children}
      </blockquote>
    ),
    code: ({ children, className, ...props }: React.HTMLAttributes<HTMLElement>) => {
      const isBlock = className?.startsWith("language-");
      if (isBlock) {
        return (
          <code
            {...props}
            className={className}
            style={{
              display: "block",
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              lineHeight: 1.6,
              color: "var(--text)",
            }}
          >
            {children}
          </code>
        );
      }
      return (
        <code
          {...props}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.88em",
            background: "var(--surface0)",
            padding: "2px 6px",
            borderRadius: 4,
            color: accent.main,
          }}
        >
          {children}
        </code>
      );
    },
    pre: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => (
      <pre
        {...props}
        style={{
          background: "var(--crust)",
          border: "1px solid var(--surface0)",
          borderRadius: 8,
          padding: 16,
          overflowX: "auto",
          margin: "0 0 14px",
        }}
      >
        {children}
      </pre>
    ),
    table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
      <div style={{ overflowX: "auto", margin: "0 0 14px" }}>
        <table
          {...props}
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
            fontFamily: "var(--font-sans)",
          }}
        >
          {children}
        </table>
      </div>
    ),
    th: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
      <th
        {...props}
        style={{
          textAlign: "left",
          padding: "8px 12px",
          borderBottom: "2px solid var(--surface0)",
          fontSize: 12,
          fontWeight: 700,
          color: "var(--text)",
          background: "var(--mantle)",
        }}
      >
        {children}
      </th>
    ),
    td: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
      <td
        {...props}
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--surface0)",
          color: "var(--subtext0)",
        }}
      >
        {children}
      </td>
    ),
    hr: (props: React.HTMLAttributes<HTMLHRElement>) => (
      <hr
        {...props}
        style={{
          border: "none",
          borderTop: "1px solid var(--surface0)",
          margin: "24px 0",
        }}
      />
    ),
    img: ({ alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        {...props}
        alt={alt ?? ""}
        style={{
          maxWidth: "100%",
          borderRadius: 8,
          border: "1px solid var(--surface0)",
          margin: "8px 0",
        }}
      />
    ),
  };
}

/* ------------------------------------------------------------------ */
/*  MarkdownContent (memoized)                                         */
/* ------------------------------------------------------------------ */

const MarkdownContent = memo(function MarkdownContent({
  content,
  accent,
}: {
  content: string;
  accent: { main: string; soft: string };
}) {
  const components = useMemo(() => makeComponents(accent), [accent]);

  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS as any}
      rehypePlugins={REHYPE_PLUGINS as any}
      components={components as any}
    >
      {content}
    </ReactMarkdown>
  );
});

/* ------------------------------------------------------------------ */
/*  TreeNav — collapsible sidebar navigation                           */
/* ------------------------------------------------------------------ */

interface TreeNode { doc: DocMeta; children: TreeNode[] }

function buildTree(docs: DocMeta[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const map = new Map<string, TreeNode>();
  for (const d of docs) map.set(d.id, { doc: d, children: [] });
  for (const d of docs) {
    const node = map.get(d.id)!;
    if (d.parent && map.has(d.parent)) {
      map.get(d.parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort children by order
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.doc.order - b.doc.order);
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);
  return roots;
}

function TreeNav({
  docs,
  activeId,
  onSelect,
  search,
  onSearch,
}: {
  docs: DocMeta[];
  activeId: string;
  onSelect: (id: string) => void;
  search: string;
  onSearch: (v: string) => void;
}) {
  const tree = useMemo(() => buildTree(docs), [docs]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Auto-expand parents of active doc
    const s = new Set<string>();
    const findParents = (id: string) => {
      const doc = docs.find((d) => d.id === id);
      if (doc?.parent) { s.add(doc.parent); findParents(doc.parent); }
    };
    findParents(activeId);
    // Also expand all root nodes by default
    for (const d of docs) if (!d.parent) s.add(d.id);
    return s;
  });

  // Expand parent when active changes
  useEffect(() => {
    const doc = docs.find((d) => d.id === activeId);
    if (doc?.parent) {
      setExpanded((prev) => {
        const next = new Set(prev);
        let id: string | undefined = doc.parent;
        while (id) {
          next.add(id);
          id = docs.find((d) => d.id === id)?.parent;
        }
        return next;
      });
    }
  }, [activeId, docs]);

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const q = search.toLowerCase();

  function matchesSearch(node: TreeNode): boolean {
    if (!q) return true;
    if (node.doc.title.toLowerCase().includes(q)) return true;
    return node.children.some(matchesSearch);
  }

  function renderNode(node: TreeNode, depth: number): React.ReactNode {
    if (!matchesSearch(node)) return null;
    const hasChildren = node.children.length > 0;
    const isActive = node.doc.id === activeId;
    const isExpanded = expanded.has(node.doc.id);
    const c = COLOR_MAP[node.doc.color] ?? DEFAULT_COLOR;

    return (
      <div key={node.doc.id}>
        <button
          onClick={() => {
            if (hasChildren) toggle(node.doc.id);
            onSelect(node.doc.id);
          }}
          style={{
            display: "flex", alignItems: "center", gap: 6, width: "100%",
            padding: `4px 8px 4px ${8 + depth * 14}px`,
            fontSize: 12, fontWeight: isActive ? 700 : 500,
            fontFamily: "var(--font-sans)",
            color: isActive ? c.main : "var(--subtext0)",
            background: isActive ? c.soft : "transparent",
            border: "none", borderRadius: 6, cursor: "pointer",
            textAlign: "left", transition: "all 0.12s",
          }}
        >
          {hasChildren ? (
            <ChevronRight size={11} style={{ transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0, color: "var(--overlay0)" }} />
          ) : (
            <span style={{ width: 11, flexShrink: 0 }} />
          )}
          <span style={{ fontSize: 13, flexShrink: 0 }}>{node.doc.icon}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.doc.title}</span>
        </button>
        {hasChildren && isExpanded && (
          <div>{node.children.map((c) => renderNode(c, depth + 1))}</div>
        )}
      </div>
    );
  }

  return (
    <nav style={{ width: 240, minWidth: 240, flexShrink: 0, borderRight: "1px solid var(--surface0)", overflowY: "auto", padding: "16px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
      {/* Search */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 6, padding: "5px 10px", marginBottom: 12 }}>
        <Search size={12} color="var(--overlay0)" />
        <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search..." style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--text)" }} />
      </div>
      {tree.map((n) => renderNode(n, 0))}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/*  TOC Sidebar                                                        */
/* ------------------------------------------------------------------ */

function TocSidebar({
  entries,
  accent,
}: {
  entries: TocEntry[];
  accent: { main: string; soft: string };
}) {
  const [activeSlug, setActiveSlug] = useState("");

  useEffect(() => {
    if (entries.length === 0) return;

    const observer = new IntersectionObserver(
      (items) => {
        for (const item of items) {
          if (item.isIntersecting) {
            setActiveSlug(item.target.id);
          }
        }
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0.1 },
    );

    const ids = entries.map((e) => e.slug);
    const elements: Element[] = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        observer.observe(el);
        elements.push(el);
      }
    }

    return () => {
      for (const el of elements) observer.unobserve(el);
    };
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <nav
      style={{
        position: "sticky",
        top: 24,
        width: 200,
        flexShrink: 0,
        alignSelf: "flex-start",
        paddingLeft: 20,
        borderLeft: "1px solid var(--surface0)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--overlay0)",
          marginBottom: 10,
        }}
      >
        On this page
      </div>
      {entries.map((e) => {
        const isActive = e.slug === activeSlug;
        return (
          <a
            key={e.slug}
            href={`#${e.slug}`}
            onClick={(ev) => {
              ev.preventDefault();
              document.getElementById(e.slug)?.scrollIntoView({ behavior: "smooth" });
            }}
            style={{
              display: "block",
              paddingLeft: (e.depth - 1) * 12,
              fontSize: 12,
              lineHeight: 1.5,
              padding: "3px 0 3px " + (e.depth - 1) * 12 + "px",
              color: isActive ? accent.main : "var(--overlay0)",
              fontWeight: isActive ? 600 : 400,
              textDecoration: "none",
              fontFamily: "var(--font-sans)",
              transition: "color 0.15s",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {e.text}
          </a>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function HelpPage() {
  const router = useRouter();
  const { session, loading: authLoading } = useAuth();

  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [activeDocId, setActiveDocId] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [mdLoading, setMdLoading] = useState(false);
  const [search, setSearch] = useState("");

  const contentRef = useRef<HTMLDivElement>(null);

  /* Auth guard */
  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  /* Fetch doc list */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/helpdocs")
      .then((r) => r.json())
      .then((body: { docs: DocMeta[] }) => {
        if (cancelled) return;
        const sorted = (body.docs ?? []).sort((a, b) => a.order - b.order);
        setDocs(sorted);
        if (sorted.length > 0) setActiveDocId(sorted[0].id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /* Fetch active doc markdown */
  useEffect(() => {
    if (!activeDocId) return;
    let cancelled = false;
    setMdLoading(true);
    fetch(`/helpdocs/${activeDocId}.md`)
      .then((r) => r.text())
      .then((raw) => {
        if (cancelled) return;
        setMarkdown(raw);
        setMdLoading(false);
        contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      })
      .catch(() => {
        if (!cancelled) {
          setMarkdown("");
          setMdLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeDocId]);

  /* Derived state */
  const { content, meta } = useMemo(() => parseFrontmatter(markdown), [markdown]);
  const toc = useMemo(() => extractToc(content), [content]);
  const activeDoc = docs.find((d) => d.id === activeDocId);
  const accent = COLOR_MAP[activeDoc?.color ?? "b"] ?? DEFAULT_COLOR;
  const minutes = useMemo(() => readingTime(content), [content]);

  const handleSelect = useCallback((id: string) => {
    setActiveDocId(id);
    setSearch("");
  }, []);

  if (authLoading || !session) return null;

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        fontFamily: "var(--font-sans)",
        color: "var(--text)",
        background: "var(--base)",
      }}
    >
      <AppSidebar active={"help" as any} />

      {/* Tree navigation sidebar */}
      {docs.length > 0 && (
        <TreeNav
          docs={docs}
          activeId={activeDocId}
          onSelect={handleSelect}
          search={search}
          onSearch={setSearch}
        />
      )}

      {/* Content area */}
      <div
        ref={contentRef}
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 0,
            maxWidth: 900,
            width: "100%",
            padding: "36px 24px 80px",
          }}
        >
          {/* Main column */}
          <div style={{ flex: 1, minWidth: 0 }}>

            {/* Active doc header */}
            {activeDoc && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 8,
                }}
              >
                <span style={{ fontSize: 20 }}>{activeDoc.icon}</span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: accent.main,
                  }}
                >
                  {activeDoc.category}
                </span>
                <ChevronRight size={12} color="var(--overlay0)" />
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--text)",
                  }}
                >
                  {activeDoc.title}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 11,
                    color: "var(--overlay0)",
                    marginLeft: "auto",
                  }}
                >
                  <Clock size={11} />
                  {minutes} min read
                </span>
              </div>
            )}

            {/* Markdown body */}
            <div
              style={{
                background: "var(--mantle)",
                border: "1px solid var(--surface0)",
                borderRadius: 12,
                padding: "28px 32px",
                minHeight: 300,
              }}
            >
              {mdLoading ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: 200,
                    color: "var(--overlay0)",
                    fontSize: 13,
                  }}
                >
                  Loading...
                </div>
              ) : content ? (
                <MarkdownContent content={content} accent={accent} />
              ) : docs.length === 0 ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    height: 200,
                    gap: 8,
                    color: "var(--overlay0)",
                    fontSize: 13,
                  }}
                >
                  <HelpCircle size={28} strokeWidth={1.2} />
                  No documentation available yet.
                </div>
              ) : null}
            </div>
          </div>

          {/* TOC sidebar */}
          {toc.length > 0 && !mdLoading && (
            <div
              style={{
                width: 220,
                flexShrink: 0,
                paddingTop: 140,
              }}
            >
              <TocSidebar entries={toc} accent={accent} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
