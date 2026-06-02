"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Wrench, Search } from "lucide-react";
import IntegrationsShell from "../../components/IntegrationsShell";
import { useAuth } from "../../lib/auth-context";
import { supabase } from "../../lib/supabase";

/* ─── MCP tool definitions ─────────────────────────────────────────────── */

const USER_SPACE_TOOLS = [
  { name: "write_sprint_workspace",  desc: "Write source code, tests, configs, scripts, or infrastructure files to _workspace/{agent}/ in the sprint staging area" },
  { name: "write_sprint_docs",       desc: "Write documentation, specifications, analyses, or reports to _docs/{agent}/ in the sprint staging area" },
  { name: "write_sprint_audit",      desc: "Write internal agent summaries, logs, or diagnostic data to _audit/{agent}/ (usually called by the runtime)" },
  { name: "write_cli_instructions",  desc: "Write CLI tool configuration files at the project root (CLAUDE.md, .claude/agents/, .gitignore, README.md)" },
  { name: "read_project_file",       desc: "Read a file from the project's artifact tree" },
  { name: "list_project_files",      desc: "List files in the project's artifact tree" },
  { name: "read_artifact",           desc: "Read a staging artifact produced by a previous pipeline agent" },
  { name: "list_artifacts",          desc: "List staging artifacts from the current and previous sprints" },
] as const;

const KNOWLEDGE_TOOLS = [
  { name: "search_knowledge",      desc: "Semantic search across linked knowledge instances (enabled only when the project has Knowledge Base sources)" },
  { name: "list_knowledge_sources", desc: "List Knowledge Base sources linked to this project" },
  { name: "fetch_url",             desc: "Fetch and parse a public https URL (cached per sprint, 500 KB cap, blocks private/reserved IPs)" },
] as const;

const PIPELINE_TOOLS = [
  { name: "escalate_to_human",    desc: "Pause the pipeline and request human input. Use only when a decision is outside agent authority or critical context is missing" },
  { name: "github_push_sprint",   desc: "Native tool: commit staged files to GitHub, create a branch, open a PR, and optionally tag the sprint (used by the Sprint Push agent)" },
  { name: "mark_sprint_saved",    desc: "Native tool: mark the current sprint as persisted/saved after artifacts are committed to an external destination" },
] as const;

/* ─── Tool catalog types ───────────────────────────────────────────────── */

interface ToolRow {
  id: string; slug: string; name: string; description: string | null;
  type: "native" | "mcp" | "rest"; status: "available" | "planned" | "deprecated";
  origin: "built-in" | "user";
}

const TYPE_COLOR: Record<string, string> = { native: "#10b981", mcp: "#6366f1", rest: "#f59e0b" };
const STATUS_COLOR: Record<string, string> = { available: "#10b981", planned: "#f59f00", deprecated: "#6b7a9e" };

/* ─── Styles ───────────────────────────────────────────────────────────── */

const cardStyle: React.CSSProperties = {
  background: "var(--mantle)", border: "1px solid var(--surface1)",
  borderRadius: 12, padding: "20px 24px", marginBottom: 20,
};
const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const thStyle: React.CSSProperties = { textAlign: "left", padding: "8px 12px", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--overlay0)", borderBottom: "1px solid var(--surface1)" };
const tdStyle: React.CSSProperties = { padding: "10px 12px", borderBottom: "1px solid var(--surface0)", color: "var(--subtext1)", lineHeight: 1.5 };
const codeStyle: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", background: "var(--surface0)", padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap" };
const inputStyle: React.CSSProperties = { padding: "7px 12px 7px 32px", borderRadius: 8, background: "var(--surface0)", border: "1px solid var(--surface1)", color: "var(--text)", fontSize: 13, outline: "none", fontFamily: "var(--font-sans)", width: 200 };

type PageTab = "tools" | "mcp";

/* ─── Component ────────────────────────────────────────────────────────── */

export default function ToolsPage() {
  const router = useRouter();
  const { session, loading: authLoading } = useAuth();
  const [tab, setTab] = useState<PageTab>("tools");

  // Tool catalog state
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "native" | "mcp" | "rest">("all");

  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  useEffect(() => {
    supabase.from("tools").select("id, slug, name, description, type, status, origin").order("status").order("name")
      .then(({ data }) => { if (data) setTools(data as ToolRow[]); setToolsLoading(false); });
  }, []);

  const q = search.toLowerCase();
  const filtered = tools.filter((t) =>
    (typeFilter === "all" || t.type === typeFilter) &&
    (!q || t.name.toLowerCase().includes(q) || t.slug.includes(q) || (t.description ?? "").toLowerCase().includes(q))
  );
  const available  = filtered.filter((t) => t.status === "available");
  const planned    = filtered.filter((t) => t.status === "planned");
  const deprecated = filtered.filter((t) => t.status === "deprecated");

  return (
    <IntegrationsShell
      active="mcp-servers"
      title="Tools"
      description="Tool catalog and MCP server configuration for AI agents."
      maxWidth={800}
    >

          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid var(--surface0)", marginBottom: 24 }}>
            {([
              { id: "tools" as PageTab, label: "Tool Catalog" },
              { id: "mcp" as PageTab, label: "MCP Servers" },
            ]).map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                padding: "9px 20px", border: "none", background: "transparent",
                color: tab === t.id ? "var(--text)" : "var(--overlay0)",
                fontSize: 13, fontWeight: tab === t.id ? 700 : 500,
                cursor: "pointer", fontFamily: "var(--font-sans)",
                borderBottom: tab === t.id ? "2px solid var(--blue)" : "2px solid transparent",
                marginBottom: -1,
              }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── Tool Catalog tab ── */}
          {tab === "tools" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <p style={{ fontSize: 13, color: "var(--subtext0)", margin: 0 }}>
                  {tools.filter(t => t.status === "available").length} available · {tools.filter(t => t.status === "planned").length} planned
                </p>
                <div style={{ position: "relative" }}>
                  <Search size={14} color="var(--overlay0)" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter tools…" style={inputStyle} />
                </div>
              </div>

              <div style={{ display: "flex", gap: 5, marginBottom: 20 }}>
                {(["all", "native", "mcp", "rest"] as const).map((f) => (
                  <button key={f} onClick={() => setTypeFilter(f)} style={{
                    padding: "4px 12px", borderRadius: 6,
                    border: `1px solid ${typeFilter === f ? (f === "all" ? "#1463ff" : TYPE_COLOR[f]) : "var(--surface1)"}`,
                    background: typeFilter === f ? `${f === "all" ? "#1463ff" : TYPE_COLOR[f]}12` : "transparent",
                    color: typeFilter === f ? (f === "all" ? "#1463ff" : TYPE_COLOR[f]) : "var(--overlay0)",
                    fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
                    textTransform: "uppercase", letterSpacing: "0.04em",
                  }}>
                    {f}
                  </button>
                ))}
              </div>

              {toolsLoading ? (
                <div style={{ color: "var(--overlay0)", fontSize: 13 }}>Loading tools…</div>
              ) : (
                <>
                  {[
                    { title: "Available", items: available },
                    { title: "Planned", items: planned },
                    { title: "Deprecated", items: deprecated },
                  ].map(({ title, items }) => items.length > 0 && (
                    <div key={title} style={{ marginBottom: 24 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--overlay0)", marginBottom: 10 }}>
                        {title} ({items.length})
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 10 }}>
                        {items.map((tool) => (
                          <div key={tool.id} style={{ background: "var(--surface0)", border: "1px solid var(--surface1)", borderRadius: 10, padding: "12px 14px" }}>
                            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                              <div style={{ width: 32, height: 32, borderRadius: 8, background: `${TYPE_COLOR[tool.type]}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                                <Wrench size={14} color={TYPE_COLOR[tool.type]} />
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                  <span style={{ fontSize: 13, fontWeight: 700 }}>{tool.name}</span>
                                  <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: `${TYPE_COLOR[tool.type]}18`, color: TYPE_COLOR[tool.type], textTransform: "uppercase", letterSpacing: "0.05em" }}>{tool.type}</span>
                                  <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: `${STATUS_COLOR[tool.status]}18`, color: STATUS_COLOR[tool.status], textTransform: "uppercase", letterSpacing: "0.05em" }}>{tool.status}</span>
                                </div>
                                <div style={{ fontSize: 11, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{tool.slug}</div>
                                {tool.description && <div style={{ fontSize: 12, color: "var(--subtext0)", marginTop: 4, lineHeight: 1.5 }}>{tool.description}</div>}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  {!filtered.length && <div style={{ color: "var(--overlay0)", fontSize: 13 }}>No tools match &quot;{search}&quot;.</div>}
                </>
              )}
            </div>
          )}

          {/* ── MCP Servers tab ── */}
          {tab === "mcp" && (
            <div>
              <p style={{ fontSize: 13, color: "var(--subtext0)", margin: "0 0 24px", lineHeight: 1.6 }}>
                Tools exposed to AI agents via the Model Context Protocol. Available tools depend on project configuration and orchestration mode.
              </p>

              {/* User Space Tools */}
              <div style={cardStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>User Space Tools</h2>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: "rgba(166,227,161,0.12)", color: "var(--green)", textTransform: "uppercase" }}>Local</span>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: "rgba(20,99,255,0.12)", color: "var(--blue)", textTransform: "uppercase" }}>Cloud</span>
                </div>
                <p style={{ fontSize: 12, color: "var(--subtext0)", margin: "0 0 14px", lineHeight: 1.6 }}>
                  File operations on the sprint staging tree. Exposed via MCP (stdio) to CLI agents in <strong style={{ color: "var(--text)" }}>Local mode</strong>, and via the native tool protocol to tsx-spawned agents in <strong style={{ color: "var(--text)" }}>Cloud mode</strong>. The tool names are identical either way.
                </p>
                <table style={tableStyle}>
                  <thead><tr><th style={thStyle}>Tool</th><th style={thStyle}>Description</th></tr></thead>
                  <tbody>{USER_SPACE_TOOLS.map((t) => <tr key={t.name}><td style={tdStyle}><code style={codeStyle}>{t.name}</code></td><td style={tdStyle}>{t.desc}</td></tr>)}</tbody>
                </table>
              </div>

              {/* Knowledge Base Tools */}
              <div style={cardStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Knowledge Base Tools</h2>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: "rgba(166,227,161,0.12)", color: "var(--green)", textTransform: "uppercase" }}>Local</span>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: "rgba(20,99,255,0.12)", color: "var(--blue)", textTransform: "uppercase" }}>Cloud</span>
                </div>
                <p style={{ fontSize: 12, color: "var(--subtext0)", margin: "0 0 14px", lineHeight: 1.6 }}>
                  Semantic search across project knowledge. Automatically registered when Knowledge Base instances are linked.
                </p>
                <table style={tableStyle}>
                  <thead><tr><th style={thStyle}>Tool</th><th style={thStyle}>Description</th></tr></thead>
                  <tbody>{KNOWLEDGE_TOOLS.map((t) => <tr key={t.name}><td style={tdStyle}><code style={codeStyle}>{t.name}</code></td><td style={tdStyle}>{t.desc}</td></tr>)}</tbody>
                </table>
              </div>

              {/* Pipeline Tools */}
              <div style={cardStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Pipeline Tools</h2>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: "rgba(166,227,161,0.12)", color: "var(--green)", textTransform: "uppercase" }}>Local</span>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: "rgba(20,99,255,0.12)", color: "var(--blue)", textTransform: "uppercase" }}>Cloud</span>
                </div>
                <p style={{ fontSize: 12, color: "var(--subtext0)", margin: "0 0 14px", lineHeight: 1.6 }}>
                  Sprint lifecycle and GitHub operations. In CLI routing, the pipeline orchestrator handles them.
                </p>
                <table style={tableStyle}>
                  <thead><tr><th style={thStyle}>Tool</th><th style={thStyle}>Description</th></tr></thead>
                  <tbody>{PIPELINE_TOOLS.map((t) => <tr key={t.name}><td style={tdStyle}><code style={codeStyle}>{t.name}</code></td><td style={tdStyle}>{t.desc}</td></tr>)}</tbody>
                </table>
              </div>

              {/* How it works */}
              <div style={{ height: 1, background: "var(--surface1)", margin: "28px 0" }} />
              <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 14px" }}>How it works</h2>
              <div style={cardStyle}>
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 10 }}>
                  <li style={{ fontSize: 13, color: "var(--subtext1)", lineHeight: 1.6 }}>Same tool names in both modes. The transport differs: MCP (stdio) for CLI agents in <strong style={{ color: "var(--text)" }}>Local mode</strong>; native tool protocol for tsx-spawned agents in <strong style={{ color: "var(--text)" }}>Cloud mode</strong>.</li>
                  <li style={{ fontSize: 13, color: "var(--subtext1)", lineHeight: 1.6 }}>In Local mode the MCP server runs as a subprocess alongside the CLI. Config is written to <code style={codeStyle}>.mcp.json</code>; credentials (including the tenant-scoped JWT) live in <code style={codeStyle}>.tp/mcp-secrets.json</code>.</li>
                  <li style={{ fontSize: 13, color: "var(--subtext1)", lineHeight: 1.6 }}>All DB and storage calls use the tenant-scoped JWT. The MCP server refuses to boot if a service-role key is present — RLS is the single boundary between tenants.</li>
                  <li style={{ fontSize: 13, color: "var(--subtext1)", lineHeight: 1.6 }}>MCP-capable CLIs: <strong style={{ color: "var(--text)" }}>Claude Code</strong>, <strong style={{ color: "var(--text)" }}>Goose</strong>, <strong style={{ color: "var(--text)" }}>Plandex</strong>. Non-MCP CLIs (<strong style={{ color: "var(--text)" }}>Aider</strong>, <strong style={{ color: "var(--text)" }}>Codex</strong>) receive context via pre-loaded files instead of tools.</li>
                  <li style={{ fontSize: 13, color: "var(--subtext1)", lineHeight: 1.6 }}>Knowledge Base tools appear only when the project has Knowledge Base sources linked (controlled by the <code style={codeStyle}>TIRSA_KNOWLEDGE_ENABLED</code> env var passed to the subprocess).</li>
                </ul>
              </div>
            </div>
          )}
    </IntegrationsShell>
  );
}
