"use client";

/**
 * Slash Commands CRUD — Studio > Commands tab.
 *
 * Mirrors SkillsSection's shape, stripped down:
 *   · list factory_slash_commands rows for the active factory
 *   · create / edit modal (slug, name, description, body)
 *   · enable / disable toggle, delete
 *
 * Marketplace browsing + GitHub import live in their own paths
 * (Marketplace listing detail + future). This component is the
 * operator-authored editor — equivalent to "+ New skill" + edit list.
 *
 * Materialisation happens worker-side in writeCommandFiles
 * (services/control-plane/lib/cli-executor.ts) at sprint dispatch.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Pencil, ToggleLeft, ToggleRight, X, Save, AlertCircle, Eye, GitBranch, ListChecks, Download, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { slugify } from "@/lib/slugify";

interface CommandRow {
  id:           string;
  factory_id:   string;
  project_id:   string | null;
  slug:         string;
  name:         string;
  description:  string;
  body:         string;
  enabled:      boolean;
  origin:       "custom" | "marketplace" | "github-import" | "built-in";
  origin_id:    string | null;
  created_at:   string;
  updated_at:   string;
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 12px", borderRadius: 7,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 13, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box",
};

// Shared button styles — keep visual parity with SkillsSection so the
// Studio tabs read as one family.
const btnPrimary: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6,
  border: "none", background: "var(--blue)", color: "#fff",
  fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
};
const btnGhost: React.CSSProperties = {
  padding: "4px 10px", borderRadius: 5,
  border: "1px solid var(--surface1)", background: "transparent",
  color: "var(--subtext0)", fontSize: 10, fontWeight: 600,
  cursor: "pointer", fontFamily: "var(--font-sans)",
};
const errBanner: React.CSSProperties = {
  fontSize: 11, color: "var(--red)", padding: "6px 10px",
  background: "rgba(255,77,77,0.08)", border: "1px solid rgba(255,77,77,0.25)",
  borderRadius: 6, marginBottom: 10, fontWeight: 600,
};
const muted: React.CSSProperties = { fontSize: 11, color: "var(--overlay0)", padding: "8px 0" };

export function CommandsSection({ factoryId, canWrite }: {
  factoryId: string;
  canWrite:  boolean;
}) {
  const [rows,    setRows]    = useState<CommandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal,    setShowModal]    = useState(false);
  const [editing,      setEditing]      = useState<CommandRow | null>(null);
  const [error,        setError]        = useState<string | null>(null);
  const [showGhImport, setShowGhImport] = useState(false);
  const [showCurated,  setShowCurated]  = useState(false);

  const load = useCallback(async () => {
    if (!factoryId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("factory_slash_commands")
      .select("*")
      .eq("factory_id", factoryId)
      .is("project_id", null)
      .order("slug");
    setLoading(false);
    if (error) { setError(error.message); return; }
    setRows((data ?? []) as CommandRow[]);
  }, [factoryId]);

  useEffect(() => { void load(); }, [load]);

  async function toggleEnabled(row: CommandRow) {
    if (!canWrite) return;
    const { error } = await supabase
      .from("factory_slash_commands")
      .update({ enabled: !row.enabled })
      .eq("id", row.id);
    if (error) { setError(error.message); return; }
    setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, enabled: !r.enabled } : r));
  }

  async function deleteRow(row: CommandRow) {
    if (!canWrite) return;
    if (!confirm(`Delete /${row.slug}?`)) return;
    const { error } = await supabase.from("factory_slash_commands").delete().eq("id", row.id);
    if (error) { setError(error.message); return; }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  }

  if (!factoryId) {
    return <div style={{ padding: 20, color: "var(--overlay0)", fontSize: 13 }}>Select a factory first.</div>;
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: 12, marginBottom: 8, flexWrap: "wrap",
      }}>
        <div style={{ flex: "1 1 240px", minWidth: 200 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Slash Commands
          </div>
          <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2 }}>
            Factory-default commands materialised at sprint dispatch into <code style={{ fontFamily: "var(--font-mono)" }}>.claude/commands/{`{slug}`}.md</code>. Type <code style={{ fontFamily: "var(--font-mono)" }}>/{`{slug}`}</code> in claude-code to invoke.
          </div>
        </div>
        {canWrite && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button onClick={() => { setEditing(null); setShowModal(true); }} style={btnPrimary}>+ New command</button>
            <button onClick={() => setShowGhImport(true)} style={btnGhost}>Import from GitHub</button>
            <button onClick={() => setShowCurated(true)} style={btnGhost}>Curated Index</button>
          </div>
        )}
      </div>

      {error && <div style={errBanner}>{error}</div>}

      {loading && <div style={muted}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={muted}>
          No slash commands yet. {canWrite && "Click \"+ New command\" to create one."}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
          {rows.map((row) => {
            const isRef = row.origin === "marketplace" && !!row.origin_id;
            return (
              <div
                key={row.id}
                style={{
                  background: isRef ? "rgba(20,99,255,0.04)" : "var(--surface0)",
                  border: `1px solid ${isRef ? "rgba(20,99,255,0.3)" : "var(--surface1)"}`,
                  borderRadius: 9, padding: "11px 13px",
                  opacity: row.enabled ? 1 : 0.55, transition: "opacity 0.15s",
                  display: "flex", flexDirection: "column", gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{row.name}</div>
                    <code style={{ fontSize: 11, color: "var(--blue)", fontFamily: "var(--font-mono)" }}>/{row.slug}</code>
                  </div>
                  {canWrite && (
                    <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                      {isRef ? (
                        <button onClick={() => { setEditing(row); setShowModal(true); }} title="View (marketplace ref — read-only)" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--blue)", padding: 2 }}><Eye size={12} /></button>
                      ) : (
                        <button onClick={() => { setEditing(row); setShowModal(true); }} title="Edit" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2 }}><Pencil size={12} /></button>
                      )}
                      {!isRef && (
                        <button onClick={() => deleteRow(row)} title="Delete" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2 }}><Trash2 size={12} /></button>
                      )}
                      <button onClick={() => toggleEnabled(row)} title={row.enabled ? "Disable" : "Enable"} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 2 }}>
                        {row.enabled ? <ToggleRight size={20} color="var(--green)" /> : <ToggleLeft size={20} color="var(--overlay0)" />}
                      </button>
                    </div>
                  )}
                </div>
                {row.description && (
                  <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5 }}>{row.description}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <CommandEditor
          factoryId={factoryId}
          row={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); void load(); }}
        />
      )}

      {showGhImport && (
        <GitHubImportModal
          factoryId={factoryId}
          onClose={() => setShowGhImport(false)}
          onSaved={() => { setShowGhImport(false); void load(); }}
        />
      )}

      {showCurated && (
        <CuratedIndexModal
          factoryId={factoryId}
          onClose={() => setShowCurated(false)}
          onSaved={() => { setShowCurated(false); void load(); }}
        />
      )}
    </div>
  );
}

function CommandEditor({ factoryId, row, onClose, onSaved }: {
  factoryId: string;
  row:       CommandRow | null;
  onClose:   () => void;
  onSaved:   () => void;
}) {
  const isNew = !row;
  const isRef = !isNew && row.origin === "marketplace" && !!row.origin_id;
  const [slug, setSlug]               = useState(row?.slug ?? "");
  const [name, setName]               = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [body, setBody]               = useState(row?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  async function save() {
    if (!slug.trim() || !name.trim() || !body.trim()) {
      setError("Slug, Name, and Body are required.");
      return;
    }
    setSaving(true);
    setError(null);
    const cleanSlug = slugify(slug.trim(), { keepDashes: true });
    const payload = {
      factory_id:  factoryId,
      project_id:  null,
      slug:        cleanSlug,
      name:        name.trim(),
      description: description.trim().slice(0, 500),
      body:        body.trim(),
      origin:      "custom" as const,
    };
    try {
      const { error: err } = isNew
        ? await supabase.from("factory_slash_commands").insert(payload)
        : await supabase.from("factory_slash_commands").update(payload).eq("id", row!.id);
      if (err) throw new Error(err.message);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, width: "min(720px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {isNew ? "New slash command" : isRef ? `View: /${row!.slug}` : `Edit: /${row!.slug}`}
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ padding: "16px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Slug</label>
              <input
                value={slug}
                onChange={(e) => setSlug(slugify(e.target.value, { keepDashes: true }))}
                placeholder="run-tests"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                disabled={isRef || !isNew}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Run all tests"
                style={inputStyle}
                disabled={isRef}
              />
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One-line description shown in claude-code's /command picker."
              style={inputStyle}
              disabled={isRef}
              maxLength={500}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Body (markdown — the prompt claude expands)</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="# Run all tests&#10;&#10;Run the full test suite, report failures with file + line numbers, and propose minimal fixes."
              rows={14}
              style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, fontFamily: "var(--font-mono)", fontSize: 12 }}
              disabled={isRef}
            />
          </div>

          {error && (
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)", color: "var(--red)", fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
              <AlertCircle size={12} /> {error}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--surface0)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid var(--surface1)", background: "transparent", color: "var(--text)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
            {isRef ? "Close" : "Cancel"}
          </button>
          {!isRef && (
            <button onClick={save} disabled={saving} style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1, fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", gap: 5 }}>
              <Save size={12} /> {saving ? "Saving…" : isNew ? "Create" : "Save"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * GitHub URL → preview → import. Two-step flow: paste URL, fetch
 * preview from /api/commands/github-import/preview, then operator
 * confirms slug + name + description and we POST to the apply
 * endpoint. Same shape as the equivalent skill flow.
 */
function GitHubImportModal({ factoryId, onClose, onSaved }: {
  factoryId: string;
  onClose:   () => void;
  onSaved:   () => void;
}) {
  const [url, setUrl]               = useState("");
  const [preview, setPreview]       = useState<{ rawUrl: string; suggestedSlug: string; suggestedName: string; suggestedDesc: string; body: string; sha: string } | null>(null);
  const [slug, setSlug]             = useState("");
  const [name, setName]             = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading]       = useState(false);
  const [error,   setError]         = useState<string | null>(null);

  async function loadPreview() {
    if (!url.trim()) { setError("Paste a GitHub URL first."); return; }
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch("/api/commands/github-import/preview", {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ url: url.trim() }),
      });
      const body = await res.json() as { ok?: boolean; preview?: { rawUrl: string; suggestedSlug: string; suggestedName: string; suggestedDesc: string; body: string; sha: string }; error?: string };
      if (!res.ok || !body.preview) throw new Error(body.error ?? "Preview failed");
      setPreview(body.preview);
      setSlug(body.preview.suggestedSlug);
      setName(body.preview.suggestedName);
      setDescription(body.preview.suggestedDesc);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function apply() {
    if (!preview) return;
    if (!slug.trim() || !name.trim()) { setError("Slug and name are required."); return; }
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch("/api/commands/github-import", {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({
          url:         url.trim(),
          factory_id:  factoryId,
          slug:        slugify(slug.trim(), { keepDashes: true }),
          name:        name.trim(),
          description: description.trim().slice(0, 500),
        }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? "Import failed");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, width: "min(720px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}><GitBranch size={14} /> Import command from GitHub</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ padding: "16px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>GitHub URL</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/{owner}/{repo}/blob/{ref}/path/to/command.md"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
              <button
                onClick={() => void loadPreview()}
                disabled={loading || !url.trim()}
                style={{ padding: "8px 14px", borderRadius: 7, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1, fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", gap: 5 }}
              >
                {loading ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={12} />}
                Preview
              </button>
            </div>
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4, lineHeight: 1.5 }}>
              blob, tree, raw, or bare repo URL. SHA is pinned at import time so the body doesn&apos;t shift if upstream changes.
            </div>
          </div>

          {preview && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Slug</label>
                  <input value={slug} onChange={(e) => setSlug(slugify(e.target.value, { keepDashes: true }))} style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Name</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
                </div>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Description</label>
                <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} maxLength={500} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Body preview (read-only)</label>
                <pre style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", margin: 0 }}>
                  {preview.body.slice(0, 3000)}{preview.body.length > 3000 ? "\n…" : ""}
                </pre>
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>SHA: <code style={{ fontFamily: "var(--font-mono)" }}>{preview.sha.slice(0, 12)}</code></div>
              </div>
            </>
          )}

          {error && (
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)", color: "var(--red)", fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
              <AlertCircle size={12} /> {error}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--surface0)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid var(--surface1)", background: "transparent", color: "var(--text)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Cancel</button>
          {preview && (
            <button onClick={apply} disabled={loading} style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1, fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", gap: 5 }}>
              <Save size={12} /> {loading ? "Importing…" : "Import"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Curated-index modal — operator points us at an awesome-style markdown
 * index, we parse out GitHub links per section, operator picks N
 * candidates and we batch-call /api/commands/github-import for each.
 * Errors per item are non-fatal so a partial install completes.
 */
function CuratedIndexModal({ factoryId, onClose, onSaved }: {
  factoryId: string;
  onClose:   () => void;
  onSaved:   () => void;
}) {
  const [url, setUrl]                 = useState("");
  const [items, setItems]             = useState<Array<{ title: string; url: string; description: string; section: string }>>([]);
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const [loading, setLoading]         = useState(false);
  const [installing, setInstalling]   = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [progress, setProgress]       = useState<{ done: number; total: number; failed: string[] }>({ done: 0, total: 0, failed: [] });

  async function loadIndex() {
    if (!url.trim()) { setError("Paste a curated-index URL first."); return; }
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch("/api/commands/curated-index/preview", {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ url: url.trim() }),
      });
      const body = await res.json() as { ok?: boolean; items?: Array<{ title: string; url: string; description: string; section: string }>; error?: string };
      if (!res.ok || !body.items) throw new Error(body.error ?? "Index parse failed");
      setItems(body.items);
      setSelected(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function batchInstall() {
    if (selected.size === 0) return;
    setInstalling(true);
    setError(null);
    const targets = items.filter((it) => selected.has(it.url));
    setProgress({ done: 0, total: targets.length, failed: [] });
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setError("Not signed in"); setInstalling(false); return; }
    const failed: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      try {
        const previewRes = await fetch("/api/commands/github-import/preview", {
          method:  "POST",
          headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
          body:    JSON.stringify({ url: item.url }),
        });
        const previewBody = await previewRes.json() as { preview?: { suggestedSlug: string; suggestedName: string; suggestedDesc: string }; error?: string };
        if (!previewRes.ok || !previewBody.preview) throw new Error(previewBody.error ?? "preview failed");
        const applyRes = await fetch("/api/commands/github-import", {
          method:  "POST",
          headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
          body:    JSON.stringify({
            url:         item.url,
            factory_id:  factoryId,
            slug:        previewBody.preview.suggestedSlug,
            name:        item.title || previewBody.preview.suggestedName,
            description: item.description || previewBody.preview.suggestedDesc,
          }),
        });
        if (!applyRes.ok) {
          const ab = await applyRes.json().catch(() => ({})) as { error?: string };
          throw new Error(ab.error ?? `${applyRes.status}`);
        }
      } catch (e) {
        failed.push(`${item.title}: ${(e as Error).message}`);
      }
      setProgress({ done: i + 1, total: targets.length, failed });
    }
    setInstalling(false);
    if (failed.length === 0) onSaved();
    else setError(`Imported ${targets.length - failed.length}/${targets.length}. Failed: ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? "…" : ""}`);
  }

  // Group by section for the picker UI.
  const sections = new Map<string, typeof items>();
  for (const it of items) {
    if (!sections.has(it.section)) sections.set(it.section, []);
    sections.get(it.section)!.push(it);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, width: "min(820px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}><ListChecks size={14} /> Curated index — slash commands</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ padding: "16px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Curated-index URL</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/affaan-m/everything-claude-code"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
              <button
                onClick={() => void loadIndex()}
                disabled={loading || !url.trim()}
                style={{ padding: "8px 14px", borderRadius: 7, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1, fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", gap: 5 }}
              >
                {loading ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={12} />}
                Load
              </button>
            </div>
          </div>

          {items.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "var(--overlay1)" }}>
                <span>{items.length} candidate{items.length === 1 ? "" : "s"} · {selected.size} selected</span>
                <button
                  onClick={() => setSelected(new Set(items.map((i) => i.url)))}
                  style={{ padding: "4px 9px", borderRadius: 5, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 10, fontWeight: 600, cursor: "pointer" }}
                >
                  Select all
                </button>
                <button
                  onClick={() => setSelected(new Set())}
                  style={{ padding: "4px 9px", borderRadius: 5, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 10, fontWeight: 600, cursor: "pointer" }}
                >
                  Clear
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {[...sections.entries()].map(([section, group]) => (
                  <div key={section}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                      {section} ({group.length})
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {group.map((it) => {
                        const checked = selected.has(it.url);
                        return (
                          <label key={it.url} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "7px 9px", borderRadius: 6, background: checked ? "rgba(20,99,255,0.06)" : "var(--surface0)", border: `1px solid ${checked ? "rgba(20,99,255,0.25)" : "var(--surface1)"}`, cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setSelected((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(it.url)) next.delete(it.url); else next.add(it.url);
                                  return next;
                                });
                              }}
                              style={{ marginTop: 3, accentColor: "var(--blue)" }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{it.title}</div>
                              {it.description && <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 2, lineHeight: 1.4 }}>{it.description}</div>}
                              <code style={{ fontSize: 9, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{it.url}</code>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {installing && (
            <div style={{ padding: "10px 12px", borderRadius: 7, background: "rgba(20,99,255,0.06)", border: "1px solid rgba(20,99,255,0.25)", color: "var(--blue)", fontSize: 12 }}>
              Importing {progress.done}/{progress.total}…
            </div>
          )}

          {error && (
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)", color: "var(--red)", fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
              <AlertCircle size={12} /> {error}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--surface0)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid var(--surface1)", background: "transparent", color: "var(--text)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Close</button>
          {selected.size > 0 && (
            <button onClick={() => void batchInstall()} disabled={installing} style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: installing ? "not-allowed" : "pointer", opacity: installing ? 0.6 : 1, fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", gap: 5 }}>
              <Download size={12} /> {installing ? "Importing…" : `Import ${selected.size}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
