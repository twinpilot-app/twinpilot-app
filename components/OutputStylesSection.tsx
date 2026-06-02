"use client";

/**
 * Output Styles CRUD — Studio > Advanced > Claude Code > Output Styles.
 *
 * Operator-authored Claude Code output styles materialised at sprint
 * dispatch into .claude/output-styles/{slug}.md plus a settings.json
 * outputStyle key that picks the active one.
 *
 * Same scope conventions as Skills/Commands/Hooks: factory-default
 * (project_id IS NULL) ∪ project-specific overrides; slug uniqueness
 * within scope; only ONE row may be active at a time per scope (a
 * partial unique index on the table enforces this — the UI cooperates
 * by deactivating peers before activating a new one).
 *
 * Materialisation lives in writeOutputStylesFile (services/control-
 * plane/lib/cli-executor.ts).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Pencil, X, Save, AlertCircle, Eye, Star } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { slugify } from "@/lib/slugify";
import {
  studioSectionContainer,
  studioBtnPrimary,
  studioInputStyle,
  studioErrBanner,
  studioMuted,
  StudioSectionHeader,
} from "@/components/StudioSectionChrome";

interface OutputStyleRow {
  id:                      string;
  factory_id:              string;
  project_id:              string | null;
  slug:                    string;
  name:                    string;
  description:             string;
  body:                    string;
  keep_coding_instructions: boolean;
  is_active:               boolean;
  origin:                  "custom" | "marketplace" | "github-import" | "built-in";
  origin_id:               string | null;
  created_at:              string;
  updated_at:              string;
}

export function OutputStylesSection({ factoryId, canWrite }: {
  factoryId: string;
  canWrite:  boolean;
}) {
  const [rows,    setRows]    = useState<OutputStyleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing,   setEditing]   = useState<OutputStyleRow | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!factoryId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("factory_output_styles")
      .select("*")
      .eq("factory_id", factoryId)
      .is("project_id", null)
      .order("name");
    setLoading(false);
    if (error) { setError(error.message); return; }
    setRows((data ?? []) as OutputStyleRow[]);
  }, [factoryId]);

  useEffect(() => { void load(); }, [load]);

  /** Activate one row. Deactivates any other active row in the same
   *  (factory_id, project_id IS NULL) scope so the partial unique index
   *  doesn't reject the update. */
  async function activate(row: OutputStyleRow) {
    if (!canWrite) return;
    const others = rows.filter((r) => r.is_active && r.id !== row.id);
    for (const o of others) {
      const { error: e1 } = await supabase
        .from("factory_output_styles")
        .update({ is_active: false })
        .eq("id", o.id);
      if (e1) { setError(e1.message); return; }
    }
    const { error: e2 } = await supabase
      .from("factory_output_styles")
      .update({ is_active: true })
      .eq("id", row.id);
    if (e2) { setError(e2.message); return; }
    setRows((prev) => prev.map((r) => ({ ...r, is_active: r.id === row.id })));
  }

  async function deactivate(row: OutputStyleRow) {
    if (!canWrite) return;
    const { error: e } = await supabase
      .from("factory_output_styles")
      .update({ is_active: false })
      .eq("id", row.id);
    if (e) { setError(e.message); return; }
    setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, is_active: false } : r));
  }

  async function deleteRow(row: OutputStyleRow) {
    if (!canWrite) return;
    if (!confirm(`Delete output style "${row.name}"?`)) return;
    const { error } = await supabase.from("factory_output_styles").delete().eq("id", row.id);
    if (error) { setError(error.message); return; }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  }

  if (!factoryId) {
    return (
      <div style={studioSectionContainer}>
        <div style={studioMuted}>Select a factory first.</div>
      </div>
    );
  }

  return (
    <div style={studioSectionContainer}>
      <StudioSectionHeader
        title="Output Styles"
        subtitle={
          <>
            Customise Claude Code's session system prompt — only one style is active at a time.
            Materialised at sprint dispatch into <code style={{ fontFamily: "var(--font-mono)" }}>.claude/output-styles/</code>.
          </>
        }
        actions={canWrite && (
          <button onClick={() => { setEditing(null); setShowModal(true); }} style={studioBtnPrimary}>
            <Plus size={14} /> New output style
          </button>
        )}
      />

      {error && <div style={studioErrBanner}>{error}</div>}

      {loading && <div style={studioMuted}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={studioMuted}>
          No output styles yet. {canWrite && "Click \"+ New output style\" to author a persona (e.g. data-engineering, learning-mode)."}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((row) => {
            const isRef = row.origin === "marketplace" && !!row.origin_id;
            const active = row.is_active;
            return (
              <div
                key={row.id}
                style={{
                  background: active ? "rgba(245,194,107,0.05)" : isRef ? "rgba(20,99,255,0.04)" : "var(--surface0)",
                  border: `1px solid ${active ? "rgba(245,194,107,0.45)" : isRef ? "rgba(20,99,255,0.3)" : "var(--surface1)"}`,
                  borderRadius: 10, padding: "12px 14px",
                  display: "flex", alignItems: "center", gap: 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{row.name}</span>
                    <code style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{row.slug}</code>
                    {active && (
                      <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(245,194,107,0.15)", color: "var(--peach)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        Active
                      </span>
                    )}
                    {row.keep_coding_instructions && (
                      <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(20,99,255,0.12)", color: "var(--blue)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        Keeps coding
                      </span>
                    )}
                  </div>
                  {row.description && (
                    <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4 }}>{row.description}</div>
                  )}
                </div>
                {canWrite && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                    {isRef ? (
                      <button
                        onClick={() => { setEditing(row); setShowModal(true); }}
                        title="View (marketplace ref — read-only)"
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--blue)", padding: 3 }}
                      ><Eye size={13} /></button>
                    ) : (
                      <button
                        onClick={() => { setEditing(row); setShowModal(true); }}
                        title="Edit"
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 3 }}
                      ><Pencil size={13} /></button>
                    )}
                    {!isRef && (
                      <button
                        onClick={() => deleteRow(row)}
                        title="Delete"
                        style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 3 }}
                      ><Trash2 size={13} /></button>
                    )}
                    <button
                      onClick={() => active ? deactivate(row) : activate(row)}
                      title={active ? "Deactivate" : "Activate (deactivates current active style)"}
                      style={{ background: "transparent", border: "none", cursor: "pointer", padding: 3, color: active ? "var(--peach)" : "var(--overlay0)" }}
                    >
                      <Star size={16} fill={active ? "var(--peach)" : "transparent"} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <OutputStyleEditor
          factoryId={factoryId}
          row={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function OutputStyleEditor({ factoryId, row, onClose, onSaved }: {
  factoryId: string;
  row:       OutputStyleRow | null;
  onClose:   () => void;
  onSaved:   () => void;
}) {
  const isNew = !row;
  const isRef = !isNew && row.origin === "marketplace" && !!row.origin_id;
  const [slug, setSlug]               = useState(row?.slug ?? "");
  const [name, setName]               = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [body, setBody]               = useState(row?.body ?? "");
  const [keepCoding, setKeepCoding]   = useState(row?.keep_coding_instructions ?? false);
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
      factory_id:               factoryId,
      project_id:               null,
      slug:                     cleanSlug,
      name:                     name.trim(),
      description:              description.trim().slice(0, 500),
      body:                     body.trim(),
      keep_coding_instructions: keepCoding,
      origin:                   "custom" as const,
    };
    try {
      const { error: err } = isNew
        ? await supabase.from("factory_output_styles").insert(payload)
        : await supabase.from("factory_output_styles").update(payload).eq("id", row!.id);
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
            {isNew ? "New output style" : isRef ? `View: ${row!.name}` : `Edit: ${row!.name}`}
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
                placeholder="data-engineering"
                style={{ ...studioInputStyle, fontFamily: "var(--font-mono)" }}
                disabled={isRef || !isNew}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Data Engineering"
                style={studioInputStyle}
                disabled={isRef}
              />
              <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
                The name written into frontmatter; this is what Claude Code matches when activating the style.
              </div>
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Description (optional)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line shown in /config picker"
              style={studioInputStyle}
              disabled={isRef}
              maxLength={500}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Body (markdown — the persona prompt)</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={"# Style Instructions\n\nYou are a data engineer. Prefer SQL-first thinking. When tasks involve transformations, output dbt models with explicit dependencies."}
              rows={12}
              style={{ ...studioInputStyle, resize: "vertical", lineHeight: 1.5, fontFamily: "var(--font-mono)", fontSize: 12 }}
              disabled={isRef}
            />
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4, lineHeight: 1.5 }}>
              Replaces Claude Code's built-in coding system prompt by default. Toggle "Keep coding instructions" to layer on top of it instead.
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--subtext0)", cursor: isRef ? "default" : "pointer" }}>
            <input
              type="checkbox"
              checked={keepCoding}
              onChange={(e) => setKeepCoding(e.target.checked)}
              disabled={isRef}
            />
            Keep Claude Code's built-in coding instructions
          </label>

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
