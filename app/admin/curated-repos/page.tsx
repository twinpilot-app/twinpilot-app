"use client";

/**
 * Admin → Curated Repos
 *
 * Platform-curated GitHub repos that ship reusable claude-code
 * artefacts. Operators see the enabled subset in Studio's Skills /
 * Commands / Hooks tabs, filtered by which kinds the repo declares
 * paths for. Admin edits live here.
 */
import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Library, Plus, Trash2, Pencil, ToggleLeft, ToggleRight, X, Save, AlertCircle, ExternalLink } from "lucide-react";
import { slugify } from "@/lib/slugify";

const KINDS = ["agents", "skills", "commands", "hooks"] as const;
type Kind = typeof KINDS[number];

interface CuratedRepo {
  id:             string;
  slug:           string;
  name:           string;
  description:    string;
  repo_owner:     string;
  repo_name:      string;
  default_branch: string | null;
  paths:          Partial<Record<Kind, string>>;
  homepage_url:   string | null;
  enabled:        boolean;
  created_at:     string;
  updated_at:     string;
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 12px", borderRadius: 7,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 13, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box",
};

export default function AdminCuratedReposPage() {
  const [rows, setRows]       = useState<CuratedRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [editing, setEditing] = useState<CuratedRepo | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setLoading(false); return; }
    const res = await fetch("/api/admin/curated-repos", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const body = await res.json() as { repos?: CuratedRepo[]; error?: string };
    setLoading(false);
    if (!res.ok) { setError(body.error ?? "Request failed"); return; }
    setRows(body.repos ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggleEnabled(row: CuratedRepo) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/admin/curated-repos/${row.id}`, {
      method:  "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ enabled: !row.enabled }),
    });
    if (!res.ok) { const b = await res.json() as { error?: string }; setError(b.error ?? "Toggle failed"); return; }
    setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, enabled: !r.enabled } : r));
  }

  async function deleteRow(row: CuratedRepo) {
    if (!confirm(`Delete curated repo "${row.name}"?`)) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const res = await fetch(`/api/admin/curated-repos/${row.id}`, {
      method:  "DELETE",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (!res.ok) { const b = await res.json() as { error?: string }; setError(b.error ?? "Delete failed"); return; }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  }

  return (
    <div style={{ padding: "28px 32px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <Library size={20} color="var(--blue)" />
            <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", margin: 0 }}>Curated repos</h1>
          </div>
          <div style={{ fontSize: 12, color: "var(--overlay0)", lineHeight: 1.6, maxWidth: 720 }}>
            Platform-curated GitHub repos that publish reusable claude-code artefacts.
            Operators see enabled rows in Studio&apos;s Skills / Commands / Hooks tabs, filtered by
            the kinds each repo&apos;s <code style={{ fontFamily: "var(--font-mono)" }}>paths</code> map declares.
          </div>
        </div>
        <button
          onClick={() => { setEditing(null); setShowNew(true); }}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}
        >
          <Plus size={13} /> New repo
        </button>
      </div>

      {error && (
        <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 16, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)", color: "var(--red)", fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle size={13} /> {error}
        </div>
      )}

      {loading && <div style={{ padding: 40, textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={{ padding: "32px 20px", borderRadius: 12, background: "var(--mantle)", border: "1px dashed var(--surface1)", textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>
          No curated repos yet. Click <strong>+ New repo</strong> to add one.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "var(--crust)", borderBottom: "1px solid var(--surface0)" }}>
                {["Name", "Repo", "Branch", "Kinds", "Status", ""].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "9px 12px", fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const kinds = KINDS.filter((k) => r.paths[k] && r.paths[k]!.length > 0);
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--surface0)", opacity: r.enabled ? 1 : 0.55 }}>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ fontWeight: 700, color: "var(--text)" }}>{r.name}</div>
                      <code style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{r.slug}</code>
                      {r.description && <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 3, lineHeight: 1.4 }}>{r.description}</div>}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>
                      <a href={r.homepage_url ?? `https://github.com/${r.repo_owner}/${r.repo_name}`} target="_blank" rel="noreferrer" style={{ color: "var(--blue)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>
                        {r.repo_owner}/{r.repo_name} <ExternalLink size={10} />
                      </a>
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--subtext0)" }}>
                      {r.default_branch ?? "auto"}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {kinds.length === 0 && <span style={{ fontSize: 10, color: "var(--overlay0)" }}>—</span>}
                        {kinds.map((k) => (
                          <span key={k} title={`${k}: ${r.paths[k]}`} style={{
                            fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                            background: "rgba(20,99,255,0.10)", color: "var(--blue)",
                            textTransform: "uppercase", letterSpacing: "0.04em",
                          }}>{k}</span>
                        ))}
                      </div>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: r.enabled ? "var(--green)" : "var(--overlay0)" }}>
                        {r.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <button onClick={() => toggleEnabled(r)} title={r.enabled ? "Disable" : "Enable"} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4 }}>
                        {r.enabled ? <ToggleRight size={20} color="var(--green)" /> : <ToggleLeft size={20} color="var(--overlay0)" />}
                      </button>
                      <button onClick={() => { setEditing(r); setShowNew(true); }} title="Edit" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4 }}>
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => deleteRow(r)} title="Delete" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4 }}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <CuratedRepoEditor
          row={editing}
          onClose={() => { setShowNew(false); setEditing(null); }}
          onSaved={() => { setShowNew(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function CuratedRepoEditor({ row, onClose, onSaved }: {
  row:     CuratedRepo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = !row;
  const [slug, setSlug]                   = useState(row?.slug ?? "");
  const [name, setName]                   = useState(row?.name ?? "");
  const [description, setDescription]     = useState(row?.description ?? "");
  const [repoOwner, setRepoOwner]         = useState(row?.repo_owner ?? "");
  const [repoName, setRepoName]           = useState(row?.repo_name ?? "");
  const [defaultBranch, setDefaultBranch] = useState(row?.default_branch ?? "");
  const [homepageUrl, setHomepageUrl]     = useState(row?.homepage_url ?? "");
  const [paths, setPaths]                 = useState<Partial<Record<Kind, string>>>(row?.paths ?? {});
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  function setPath(kind: Kind, value: string) {
    setPaths((prev) => {
      const next = { ...prev };
      if (value.trim()) next[kind] = value.trim();
      else delete next[kind];
      return next;
    });
  }

  async function save() {
    if (!slug.trim() || !name.trim() || !repoOwner.trim() || !repoName.trim()) {
      setError("Slug, Name, Repo owner, and Repo name are required.");
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      slug:           slugify(slug.trim(), { keepDashes: true }),
      name:           name.trim(),
      description:    description.trim().slice(0, 500),
      repo_owner:     repoOwner.trim(),
      repo_name:      repoName.trim(),
      default_branch: defaultBranch.trim() || null,
      paths,
      homepage_url:   homepageUrl.trim() || null,
    };
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const url = isNew ? "/api/admin/curated-repos" : `/api/admin/curated-repos/${row!.id}`;
      const res = await fetch(url, {
        method:  isNew ? "POST" : "PATCH",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `${res.status}`);
      }
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
            {isNew ? "New curated repo" : `Edit: ${row!.name}`}
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ padding: "16px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
            <div>
              <label style={lbl}>Slug</label>
              <input value={slug} onChange={(e) => setSlug(slugify(e.target.value, { keepDashes: true }))} placeholder="everything-claude-code" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} disabled={!isNew} />
            </div>
            <div>
              <label style={lbl}>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Everything Claude Code" style={inputStyle} />
            </div>
          </div>

          <div>
            <label style={lbl}>Description</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Curated collection of subagents, skills, commands, and hooks." style={inputStyle} maxLength={500} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <div>
              <label style={lbl}>Repo owner</label>
              <input value={repoOwner} onChange={(e) => setRepoOwner(e.target.value)} placeholder="affaan-m" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
            </div>
            <div>
              <label style={lbl}>Repo name</label>
              <input value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="everything-claude-code" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
            </div>
            <div>
              <label style={lbl}>Default branch (optional)</label>
              <input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} placeholder="main" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
            </div>
          </div>

          <div>
            <label style={lbl}>Homepage URL (optional)</label>
            <input value={homepageUrl} onChange={(e) => setHomepageUrl(e.target.value)} placeholder="https://github.com/..." style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }} />
          </div>

          <div>
            <label style={lbl}>Per-kind subdirectories</label>
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginBottom: 8, lineHeight: 1.5 }}>
              Path relative to the repo root (no leading slash). Leave blank when the repo doesn&apos;t expose that kind.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
              {KINDS.map((k) => (
                <div key={k}>
                  <label style={{ ...lbl, color: "var(--subtext0)" }}>{k}</label>
                  <input
                    value={paths[k] ?? ""}
                    onChange={(e) => setPath(k, e.target.value)}
                    placeholder={k}
                    style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
                  />
                </div>
              ))}
            </div>
          </div>

          {error && (
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)", color: "var(--red)", fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
              <AlertCircle size={12} /> {error}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--surface0)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid var(--surface1)", background: "transparent", color: "var(--text)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
            Cancel
          </button>
          <button onClick={save} disabled={saving} style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1, fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", gap: 5 }}>
            <Save size={12} /> {saving ? "Saving…" : isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const lbl: React.CSSProperties = {
  display: "block", fontSize: 10, fontWeight: 700,
  color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em",
  marginBottom: 4,
};
