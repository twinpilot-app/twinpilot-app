"use client";

/**
 * Skills CRUD — shared between Factory Settings and Project Settings.
 *
 * Phase 5 Slice A. Custom skills (operator-authored markdown) only;
 * Built-In / GitHub-import / Marketplace browse buttons are placeholders
 * pointing at future slices. Cross-scope: factory-default when projectId
 * is omitted, project-specific when set.
 *
 * Token economics: each skill description (always loaded) is capped to
 * one screen-width of plain text in the editor. Bodies can be long —
 * Claude Code only loads them when the agent invokes the skill.
 */

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";
import { slugify } from "@/lib/slugify";

type Category = "guideline" | "playbook" | "reference";
type Origin   = "custom" | "built-in" | "marketplace" | "github-import";

interface UpdateCheckResult {
  skill_id:        string;
  origin:          string;
  has_update:      boolean;
  current_version: string | null;
  latest_version:  string | null;
  reason?:         string;
  error?:          string;
}

export interface SkillRow {
  id:                       string;
  factory_id:               string;
  project_id:               string | null;
  slug:                     string;
  name:                     string;
  description:              string;
  body:                     string;
  category:                 Category;
  origin:                   Origin;
  allowed_tools:            string[];
  disable_model_invocation: boolean;
  context_fork:             boolean;
  model_override:           string | null;
  source_url:               string | null;
  source_commit_sha:        string | null;
  source_version:           string | null;
  enabled:                  boolean;
  created_at:               string;
  updated_at:               string;
}

const CATEGORY_LABEL: Record<Category, string> = {
  guideline: "Guideline",
  playbook:  "Playbook",
  reference: "Reference",
};

const CATEGORY_DESC: Record<Category, string> = {
  guideline: "Code conventions, style rules, architectural principles. Apply during writing/review.",
  playbook:  "Operational procedures (deploy, code review, postmortem). Step-by-step instructions.",
  reference: "Pointer to an external doc — body is a brief summary + URL the agent can deep-dive.",
};

export function SkillsSection({ factoryId, projectId, canWrite, hideTitle }: {
  factoryId:  string;
  projectId?: string;
  canWrite:   boolean;
  hideTitle?: boolean;
}) {
  const { session } = useAuth();
  const [rows,           setRows]           = useState<SkillRow[]>([]);
  const [inheritedRows,  setInheritedRows]  = useState<SkillRow[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState<string | null>(null);
  const [editing, setEditing] = useState<SkillRow | "new" | null>(null);
  const [browseBuiltIn, setBrowseBuiltIn] = useState(false);
  const [githubImport, setGithubImport] = useState(false);
  const [curatedIndex, setCuratedIndex] = useState(false);
  const [browseMarketplace, setBrowseMarketplace] = useState(false);
  const [publishing, setPublishing] = useState<SkillRow | null>(null);
  const [updates, setUpdates] = useState<Map<string, UpdateCheckResult>>(new Map());
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const reload = useCallback(async () => {
    if (!factoryId) {
      // Caller hasn't resolved the factory yet (e.g. project still loading).
      // Stay quiet until factoryId arrives — running the supabase query
      // with "" triggers a "invalid input syntax for type uuid" error.
      setRows([]);
      setInheritedRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Main list: project-specific rows in project context, factory-default
      // rows in factory context. Each surface owns its primary scope.
      let mainQ = supabase
        .from("factory_skills")
        .select("*")
        .eq("factory_id", factoryId)
        .order("category", { ascending: true })
        .order("created_at", { ascending: true });
      if (projectId) mainQ = mainQ.eq("project_id", projectId);
      else           mainQ = mainQ.is("project_id", null);
      const { data: mainData, error: mainErr } = await mainQ;
      if (mainErr) throw new Error(mainErr.message);
      setRows((mainData ?? []) as SkillRow[]);

      // Inherited: factory-default rows visible when in project context.
      // Operator sees them with "active / disabled-here / overridden" state
      // and can opt out per project without leaving Project Settings.
      if (projectId) {
        const { data: inhData, error: inhErr } = await supabase
          .from("factory_skills")
          .select("*")
          .eq("factory_id", factoryId)
          .is("project_id", null)
          .eq("enabled", true)
          .order("category", { ascending: true })
          .order("created_at", { ascending: true });
        if (inhErr) throw new Error(inhErr.message);
        setInheritedRows((inhData ?? []) as SkillRow[]);
      } else {
        setInheritedRows([]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [factoryId, projectId]);

  useEffect(() => { void reload(); }, [reload]);

  async function deleteSkill(row: SkillRow) {
    if (!confirm(`Delete skill "${row.name}"? This cannot be undone.`)) return;
    const { error: err } = await supabase
      .from("factory_skills")
      .delete()
      .eq("id", row.id);
    if (err) { setError(err.message); return; }
    void reload();
  }

  async function toggleEnabled(row: SkillRow) {
    const { error: err } = await supabase
      .from("factory_skills")
      .update({ enabled: !row.enabled })
      .eq("id", row.id);
    if (err) { setError(err.message); return; }
    void reload();
  }

  /**
   * Disable an inherited factory-default skill for this project. Inserts
   * a project-specific row with the same slug and enabled=false. The
   * worker dedupes-by-slug *before* filtering enabled, so this row wins
   * the dedup and then gets dropped — net effect: factory-default doesn't
   * materialise in this project.
   */
  async function disableInherited(inh: SkillRow) {
    if (!projectId) return;
    const { error: err } = await supabase.from("factory_skills").insert({
      factory_id:               factoryId,
      project_id:               projectId,
      slug:                     inh.slug,
      name:                     inh.name,
      description:              inh.description,
      body:                     inh.body,
      category:                 inh.category,
      allowed_tools:            inh.allowed_tools,
      disable_model_invocation: inh.disable_model_invocation,
      origin:                   "custom",
      enabled:                  false,
    });
    if (err) { setError(err.message); return; }
    void reload();
  }

  /** Remove a project-specific override row, restoring inherited behaviour. */
  async function reEnableInherited(inh: SkillRow) {
    const override = rows.find((r) => r.slug === inh.slug);
    if (!override) return;
    const { error: err } = await supabase.from("factory_skills").delete().eq("id", override.id);
    if (err) { setError(err.message); return; }
    void reload();
  }

  async function checkUpdates() {
    if (!session) return;
    setCheckingUpdates(true);
    setError(null);
    try {
      const res = await fetch("/api/skills/updates/check", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ factory_id: factoryId, project_id: projectId ?? null }),
      });
      const b = await res.json().catch(() => ({})) as { results?: UpdateCheckResult[]; error?: string };
      if (!res.ok) throw new Error(b.error ?? `Check failed (${res.status})`);
      const next = new Map<string, UpdateCheckResult>();
      for (const r of b.results ?? []) next.set(r.skill_id, r);
      setUpdates(next);
      setLastChecked(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function applyUpdate(row: SkillRow) {
    if (!session) return;
    // Warn when the body has been edited after install — apply overwrites it.
    const editedSinceInstall = new Date(row.updated_at).getTime() - new Date(row.created_at).getTime() > 60_000;
    if (editedSinceInstall) {
      if (!confirm(`"${row.name}" has local edits. Updating overwrites the body. Continue?`)) return;
    }
    setApplyingId(row.id);
    setError(null);
    try {
      const res = await fetch("/api/skills/updates/apply", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ skill_id: row.id }),
      });
      const b = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(b.error ?? `Apply failed (${res.status})`);
      setUpdates((cur) => { const next = new Map(cur); next.delete(row.id); return next; });
      void reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplyingId(null);
    }
  }

  if (!session) return null;
  if (!factoryId) {
    return (
      <div style={{ marginTop: 8 }}>
        <div style={muted}>Loading factory…</div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: 12, marginBottom: 8, flexWrap: "wrap",
      }}>
        <div style={{ flex: "1 1 240px", minWidth: 200 }}>
          {!hideTitle && (
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Skills
            </div>
          )}
          <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: hideTitle ? 0 : 2 }}>
            {projectId
              ? "Project-specific skills. Add factory-default skills in Factory Settings."
              : "Factory-default skills — apply to every project in this factory unless overridden."}
            {" "}Materialised at sprint dispatch into <code>.claude/skills/</code>.
          </div>
          {lastChecked && (
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
              Last update check: {lastChecked.toLocaleTimeString()}
              {(() => {
                const n = Array.from(updates.values()).filter((u) => u.has_update).length;
                return n > 0 ? <> · <span style={{ color: "var(--peach)", fontWeight: 600 }}>{n} update{n === 1 ? "" : "s"} available</span></> : <> · all current</>;
              })()}
            </div>
          )}
        </div>
        {canWrite && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button onClick={() => setEditing("new")} style={btnPrimary}>+ New skill</button>
            <button onClick={() => setBrowseBuiltIn(true)} style={btnGhost}>Browse Built-In</button>
            <button onClick={() => setGithubImport(true)} style={btnGhost}>Import from GitHub</button>
            <button onClick={() => setCuratedIndex(true)} style={btnGhost}>Curated Index</button>
            <button onClick={() => setBrowseMarketplace(true)} style={btnGhost}>Marketplace</button>
            <button onClick={() => void checkUpdates()} disabled={checkingUpdates} style={btnGhost} title="Check upstream for newer versions of installed skills">
              {checkingUpdates ? "Checking…" : "Check updates"}
            </button>
          </div>
        )}
      </div>

      {error && <div style={errBanner}>{error}</div>}

      {(() => {
        // A project-specific row that exists *only* to disable an inherited
        // skill (enabled=false, slug matches an inherited one) is rendered
        // inside the Inherited section, not as a project-specific entry.
        const inheritedSlugs = new Set(inheritedRows.map((i) => i.slug));
        const projectSpecificVisible = rows.filter((r) => {
          if (r.enabled) return true;
          return !inheritedSlugs.has(r.slug);
        });
        const overrideBySlug = new Map(rows.map((r) => [r.slug, r] as const));

        if (loading) return <div style={muted}>Loading…</div>;

        const isEmpty = projectSpecificVisible.length === 0 && inheritedRows.length === 0;
        if (isEmpty) {
          return (
            <div style={muted}>
              No skills yet. {canWrite && "Click \"+ New skill\" to create one."}
            </div>
          );
        }

        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* ── Inherited from factory (project context only) ───────── */}
            {projectId && inheritedRows.length > 0 && (
              <div>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: "var(--overlay0)",
                  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6,
                }}>
                  Inherited from factory ({inheritedRows.length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {inheritedRows.map((inh) => {
                    const override = overrideBySlug.get(inh.slug);
                    const state: "active" | "disabled-here" | "overridden" =
                      !override                 ? "active" :
                      override.enabled === false ? "disabled-here" :
                                                   "overridden";
                    return (
                      <InheritedRowView
                        key={inh.id}
                        row={inh}
                        state={state}
                        canWrite={canWrite}
                        onDisableHere={() => void disableInherited(inh)}
                        onReEnable={() => void reEnableInherited(inh)}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Project-specific (or factory-default in factory ctx) ── */}
            {projectSpecificVisible.length > 0 && (
              <div>
                {projectId && inheritedRows.length > 0 && (
                  <div style={{
                    fontSize: 10, fontWeight: 700, color: "var(--overlay0)",
                    textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6,
                  }}>
                    Project-specific ({projectSpecificVisible.length})
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {projectSpecificVisible.map((r) => (
                    <SkillRowView
                      key={r.id}
                      row={r}
                      canWrite={canWrite}
                      update={updates.get(r.id)}
                      applying={applyingId === r.id}
                      overrides={Boolean(projectId) && inheritedSlugs.has(r.slug)}
                      onEdit={() => setEditing(r)}
                      onDelete={() => void deleteSkill(r)}
                      onToggle={() => void toggleEnabled(r)}
                      onPublish={() => setPublishing(r)}
                      onApplyUpdate={() => void applyUpdate(r)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {editing && (
        <SkillEditor
          factoryId={factoryId}
          projectId={projectId}
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void reload(); }}
        />
      )}

      {browseBuiltIn && (
        <BuiltInBrowser
          factoryId={factoryId}
          projectId={projectId}
          installedSlugs={new Set(rows.map((r) => r.slug))}
          authToken={session.access_token}
          onClose={() => setBrowseBuiltIn(false)}
          onInstalled={() => { void reload(); }}
        />
      )}

      {githubImport && (
        <GitHubImportModal
          factoryId={factoryId}
          projectId={projectId}
          installedSlugs={new Set(rows.map((r) => r.slug))}
          authToken={session.access_token}
          onClose={() => setGithubImport(false)}
          onInstalled={() => { setGithubImport(false); void reload(); }}
        />
      )}

      {curatedIndex && (
        <CuratedIndexBrowser
          factoryId={factoryId}
          projectId={projectId}
          installedSlugs={new Set(rows.map((r) => r.slug))}
          authToken={session.access_token}
          onClose={() => setCuratedIndex(false)}
          onAfterBatch={() => void reload()}
        />
      )}

      {browseMarketplace && (
        <MarketplaceBrowser
          factoryId={factoryId}
          projectId={projectId}
          installedSlugs={new Set(rows.map((r) => r.slug))}
          authToken={session.access_token}
          onClose={() => setBrowseMarketplace(false)}
          onInstalled={() => { void reload(); }}
        />
      )}

      {publishing && (
        <PublishSkillModal
          skill={publishing}
          authToken={session.access_token}
          onClose={() => setPublishing(null)}
          onDone={() => setPublishing(null)}
        />
      )}
    </div>
  );
}

/* ── Built-In browser modal — Phase 5 Slice B ─────────────────────────── */

interface BuiltInRow {
  id:                 string;
  slug:               string;
  name:               string;
  description:        string;
  category:           Category;
  domain:             string;
  tags:               string[];
  source_url:         string | null;
  source_attribution: string | null;
  version:            string;
}

function BuiltInBrowser({ factoryId, projectId, installedSlugs, authToken, onClose, onInstalled }: {
  factoryId:      string;
  projectId?:     string;
  installedSlugs: Set<string>;
  authToken:      string;
  onClose:        () => void;
  onInstalled:    () => void;
}) {
  const [list,    setList]    = useState<BuiltInRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Category>("all");

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/skills/built-in", {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const body = await res.json() as { skills: BuiltInRow[] };
        setList(body.skills ?? []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [authToken]);

  async function install(skill: BuiltInRow) {
    setInstallingId(skill.id);
    setError(null);
    try {
      const res = await fetch("/api/skills/built-in/install", {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          built_in_skill_id: skill.id,
          factory_id:        factoryId,
          project_id:        projectId ?? null,
        }),
      });
      const b = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(b.error ?? `Install failed (${res.status})`);
      onInstalled();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstallingId(null);
    }
  }

  const filtered = filter === "all" ? list : list.filter((s) => s.category === filter);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16,
    }}>
      <div style={{
        background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14,
        width: "min(720px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
      }}>
        <div style={{ padding: "14px 20px 10px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Built-In skills</div>
            <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
              {brand.name}-curated. Click Install — copy lands in your skills, fully editable.
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ padding: "10px 20px", borderBottom: "1px solid var(--surface0)", display: "flex", gap: 6 }}>
          {(["all", "guideline", "playbook", "reference"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: "5px 10px", borderRadius: 5,
                border: filter === f ? "1px solid var(--blue)" : "1px solid var(--surface1)",
                background: filter === f ? "rgba(20,99,255,0.10)" : "transparent",
                color: filter === f ? "var(--blue)" : "var(--subtext0)",
                fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
                textTransform: "capitalize",
              }}
            >
              {f === "all" ? "All" : CATEGORY_LABEL[f as Category]}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}>
          {error && <div style={errBanner}>{error}</div>}
          {loading ? (
            <div style={muted}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={muted}>No skills match the filter.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filtered.map((s) => {
                const isInstalled = installedSlugs.has(s.slug);
                const isBusy      = installingId === s.id;
                return (
                  <div key={s.id} style={{
                    padding: "10px 12px", borderRadius: 6,
                    border: "1px solid var(--surface0)", background: "var(--mantle)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                        background:
                          s.category === "guideline" ? "rgba(20,99,255,0.10)" :
                          s.category === "playbook"  ? "rgba(28,191,107,0.10)" :
                                                       "rgba(124,92,252,0.10)",
                        color:
                          s.category === "guideline" ? "var(--blue)" :
                          s.category === "playbook"  ? "var(--green)" :
                                                       "var(--mauve)",
                        textTransform: "uppercase", letterSpacing: "0.04em",
                      }}>{CATEGORY_LABEL[s.category]}</span>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</span>
                      <code style={{ fontSize: 10, color: "var(--overlay0)" }}>{s.slug}</code>
                      <span style={{ fontSize: 9, color: "var(--overlay0)" }}>v{s.version}</span>
                      <div style={{ flex: 1 }} />
                      {isInstalled ? (
                        <span style={{ fontSize: 10, color: "var(--green)", fontWeight: 600 }}>✓ installed</span>
                      ) : (
                        <button
                          onClick={() => void install(s)}
                          disabled={isBusy}
                          style={{ ...btnPrimary, padding: "4px 10px", fontSize: 10 }}
                        >
                          {isBusy ? "Installing…" : "Install"}
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4, marginBottom: 4 }}>
                      {s.description}
                    </div>
                    {(s.tags.length > 0 || s.source_attribution) && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "var(--overlay0)" }}>
                        {s.tags.map((t) => (
                          <span key={t} style={{ padding: "1px 5px", borderRadius: 3, background: "var(--surface0)" }}>
                            {t}
                          </span>
                        ))}
                        {s.source_attribution && <span style={{ marginLeft: "auto", fontStyle: "italic" }}>by {s.source_attribution}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── GitHub import modal — Phase 5 Slice C ────────────────────────────── */

interface GitHubPreview {
  slug:                     string;
  name:                     string;
  description:              string;
  body:                     string;
  allowed_tools:            string[];
  disable_model_invocation: boolean;
  model_override:           string | null;
  source: {
    owner:   string;
    repo:    string;
    ref:     string;
    path:    string;
    sha:     string;
    rawUrl:  string;
    htmlUrl: string;
  };
}

function GitHubImportModal({ factoryId, projectId, installedSlugs, authToken, onClose, onInstalled }: {
  factoryId:      string;
  projectId?:     string;
  installedSlugs: Set<string>;
  authToken:      string;
  onClose:        () => void;
  onInstalled:    () => void;
}) {
  const [url,        setUrl]        = useState("");
  const [preview,    setPreview]    = useState<GitHubPreview | null>(null);
  const [busy,       setBusy]       = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  // Operator-editable fields (seeded from preview, then editable).
  const [slug,        setSlug]        = useState("");
  const [name,        setName]        = useState("");
  const [description, setDescription] = useState("");
  const [category,    setCategory]    = useState<Category>("guideline");

  async function loadPreview() {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch("/api/skills/github-import/preview", {
        method:  "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ url }),
      });
      const b = await res.json().catch(() => ({})) as { preview?: GitHubPreview; error?: string };
      if (!res.ok) throw new Error(b.error ?? `Preview failed (${res.status})`);
      if (!b.preview) throw new Error("Preview returned no data.");
      setPreview(b.preview);
      setSlug(b.preview.slug);
      setName(b.preview.name);
      setDescription(b.preview.description);
      // Default category to guideline; operator can switch.
      setCategory("guideline");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    if (!preview) return;
    if (!slug.trim() || !name.trim() || !description.trim()) {
      setError("Slug, Name, and Description are required.");
      return;
    }
    if (installedSlugs.has(slug)) {
      setError(`A skill with slug "${slug}" is already installed in this scope.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/skills/github-import", {
        method:  "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body:    JSON.stringify({
          url,
          factory_id:               factoryId,
          project_id:               projectId ?? null,
          slug:                     slugify(slug.trim(), { keepDashes: true }),
          name:                     name.trim(),
          description:              description.trim().slice(0, 500),
          category,
          allowed_tools:            preview.allowed_tools,
          disable_model_invocation: preview.disable_model_invocation,
        }),
      });
      const b = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(b.error ?? `Install failed (${res.status})`);
      onInstalled();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16,
    }}>
      <div style={{
        background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14,
        width: "min(720px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
      }}>
        <div style={{ padding: "14px 20px 10px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Import from GitHub</div>
            <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
              Paste a URL to a SKILL.md file or a directory containing one.
              We resolve the ref to a commit SHA so the import is reproducible.
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px 18px" }}>
          {error && <div style={errBanner}>{error}</div>}

          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>GitHub URL</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo/tree/main/path/to/skill"
                style={{ ...inp, flex: 1 }}
                disabled={busy}
              />
              <button onClick={() => void loadPreview()} disabled={busy || !url.trim()} style={btnPrimary}>
                {busy && !preview ? "Loading…" : "Preview"}
              </button>
            </div>
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
              Accepts <code>github.com/.../blob/.../SKILL.md</code>,{" "}
              <code>github.com/.../tree/.../skill-dir</code>, or raw URLs.
            </div>
          </div>

          {preview && (
            <>
              <div style={{
                padding: "8px 10px", borderRadius: 6, background: "var(--surface0)",
                fontSize: 10, color: "var(--subtext0)", marginBottom: 12, lineHeight: 1.5,
              }}>
                <div><strong style={{ color: "var(--text)" }}>Source:</strong> {preview.source.owner}/{preview.source.repo}</div>
                <div><strong style={{ color: "var(--text)" }}>Path:</strong> {preview.source.path}</div>
                <div><strong style={{ color: "var(--text)" }}>Ref:</strong> {preview.source.ref} <span style={{ color: "var(--overlay0)" }}>(sha: <code>{preview.source.sha.slice(0, 7)}</code>)</span></div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={lbl}>Slug</label>
                  <input value={slug} onChange={(e) => setSlug(e.target.value)} style={inp} />
                </div>
                <div>
                  <label style={lbl}>Name</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} style={inp} />
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={lbl}>Category</label>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["guideline", "playbook", "reference"] as Category[]).map((c) => (
                    <button
                      key={c}
                      onClick={() => setCategory(c)}
                      title={CATEGORY_DESC[c]}
                      style={{
                        flex: 1, padding: "8px 10px", borderRadius: 6,
                        border: category === c ? "1px solid var(--blue)" : "1px solid var(--surface1)",
                        background: category === c ? "rgba(20,99,255,0.10)" : "transparent",
                        color: category === c ? "var(--blue)" : "var(--subtext0)",
                        fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
                      }}
                    >
                      {CATEGORY_LABEL[c]}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={lbl}>Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  style={{ ...inp, resize: "vertical", lineHeight: 1.4 }}
                />
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2 }}>{description.length}/500</div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={lbl}>Body preview ({preview.body.length} chars — read-only)</label>
                <textarea
                  value={preview.body.length > 4000 ? preview.body.slice(0, 4000) + "\n\n… (truncated for preview)" : preview.body}
                  readOnly
                  rows={12}
                  style={{ ...inp, resize: "vertical", lineHeight: 1.5, fontFamily: "var(--font-mono, monospace)", fontSize: 11, opacity: 0.9 }}
                />
              </div>

              {(preview.allowed_tools.length > 0 || preview.disable_model_invocation || preview.model_override) && (
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginBottom: 8 }}>
                  Detected frontmatter:{" "}
                  {preview.allowed_tools.length > 0 && <span>tools=<code>{preview.allowed_tools.join(",")}</code> · </span>}
                  {preview.disable_model_invocation && <span>operator-only · </span>}
                  {preview.model_override && <span>model=<code>{preview.model_override}</code></span>}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--surface0)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={busy} style={btnGhost}>Cancel</button>
          {preview && (
            <button onClick={() => void install()} disabled={busy} style={btnPrimary}>
              {busy ? "Installing…" : "Install"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Curated index browser — Phase 5 Slice D ──────────────────────────── */

interface CuratedItem {
  title:       string;
  url:         string;
  description: string;
  section:     string;
}

interface CuratedSource {
  owner:   string;
  repo:    string;
  ref:     string;
  path:    string;
  sha:     string;
  htmlUrl: string;
}

type ItemStatus = "idle" | "installing" | "ok" | "skipped" | { error: string };

function deriveSlugFromUrl(item: CuratedItem): string {
  let seed = item.title;
  try {
    const u = new URL(item.url);
    const segs = u.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    // /{owner}/{repo}/(blob|tree)/{ref}/{...path} OR /{owner}/{repo}
    const pathSegs = segs.length >= 4 && (segs[2] === "blob" || segs[2] === "tree")
      ? segs.slice(4)
      : [];
    if (pathSegs.length > 0) {
      const last = pathSegs[pathSegs.length - 1].replace(/\.md$/i, "");
      const parent = pathSegs.length > 1 ? pathSegs[pathSegs.length - 2] : "";
      seed = parent && parent !== "skills" ? `${parent}-${last}` : last;
    } else if (segs.length >= 2) {
      seed = segs[1].replace(/\.git$/i, "");
    }
  } catch { /* fall through to title */ }
  return slugify(seed, { keepDashes: true });
}

const CURATED_SUGGESTIONS = [
  "https://github.com/ComposioHQ/awesome-claude-skills",
  "https://github.com/anthropics/skills",
];

function CuratedIndexBrowser({ factoryId, projectId, installedSlugs, authToken, onClose, onAfterBatch }: {
  factoryId:      string;
  projectId?:     string;
  installedSlugs: Set<string>;
  authToken:      string;
  onClose:        () => void;
  onAfterBatch:   () => void;
}) {
  const [url,        setUrl]        = useState(CURATED_SUGGESTIONS[0]);
  const [source,     setSource]     = useState<CuratedSource | null>(null);
  const [items,      setItems]      = useState<CuratedItem[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [selected,   setSelected]   = useState<Set<string>>(new Set());
  const [defaultCategory, setDefaultCategory] = useState<Category>("guideline");
  const [search,     setSearch]     = useState("");
  const [installing, setInstalling] = useState(false);
  const [statusByUrl, setStatusByUrl] = useState<Record<string, ItemStatus>>({});

  async function loadIndex() {
    setLoading(true);
    setError(null);
    setItems([]);
    setSource(null);
    setSelected(new Set());
    setStatusByUrl({});
    try {
      const res = await fetch("/api/skills/curated-index/preview", {
        method:  "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ url }),
      });
      const b = await res.json().catch(() => ({})) as { items?: CuratedItem[]; source?: CuratedSource; error?: string };
      if (!res.ok) throw new Error(b.error ?? `Load failed (${res.status})`);
      setSource(b.source ?? null);
      setItems(b.items ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function toggle(itemUrl: string) {
    const next = new Set(selected);
    if (next.has(itemUrl)) next.delete(itemUrl); else next.add(itemUrl);
    setSelected(next);
  }

  function toggleSection(sectionItems: CuratedItem[]) {
    const next = new Set(selected);
    const allSelected = sectionItems.every((i) => next.has(i.url));
    for (const it of sectionItems) {
      if (allSelected) next.delete(it.url);
      else next.add(it.url);
    }
    setSelected(next);
  }

  async function installSelected() {
    setInstalling(true);
    setError(null);
    const toInstall = items.filter((i) => selected.has(i.url));
    const usedSlugs = new Set(installedSlugs);
    const status: Record<string, ItemStatus> = {};
    for (const it of toInstall) status[it.url] = "idle";
    setStatusByUrl(status);

    for (const item of toInstall) {
      let slug = deriveSlugFromUrl(item);
      if (!slug) slug = `gh-${Math.random().toString(36).slice(2, 7)}`;
      // Local de-dupe — installer also reports 409 but we save a roundtrip.
      let suffix = 0;
      while (usedSlugs.has(slug)) {
        suffix += 1;
        const base = slug.replace(/-\d+$/, "");
        slug = `${base}-${suffix}`;
      }
      usedSlugs.add(slug);

      setStatusByUrl((prev) => ({ ...prev, [item.url]: "installing" }));
      try {
        const res = await fetch("/api/skills/github-import", {
          method:  "POST",
          headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
          body:    JSON.stringify({
            url:         item.url,
            factory_id:  factoryId,
            project_id:  projectId ?? null,
            slug,
            name:        item.title.slice(0, 200),
            description: (item.description || item.title).slice(0, 500),
            category:    defaultCategory,
          }),
        });
        const b = await res.json().catch(() => ({})) as { error?: string };
        if (res.status === 409) {
          setStatusByUrl((prev) => ({ ...prev, [item.url]: "skipped" }));
        } else if (!res.ok) {
          setStatusByUrl((prev) => ({ ...prev, [item.url]: { error: b.error ?? `HTTP ${res.status}` } }));
        } else {
          setStatusByUrl((prev) => ({ ...prev, [item.url]: "ok" }));
        }
      } catch (e) {
        setStatusByUrl((prev) => ({ ...prev, [item.url]: { error: (e as Error).message } }));
      }
    }

    setInstalling(false);
    onAfterBatch();
  }

  // Group filtered items by section.
  const filtered = items.filter((i) => {
    if (!search.trim()) return true;
    const needle = search.toLowerCase();
    return i.title.toLowerCase().includes(needle)
        || i.description.toLowerCase().includes(needle)
        || i.section.toLowerCase().includes(needle);
  });
  const grouped = new Map<string, CuratedItem[]>();
  for (const it of filtered) {
    const arr = grouped.get(it.section) ?? [];
    arr.push(it);
    grouped.set(it.section, arr);
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16,
    }}>
      <div style={{
        background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14,
        width: "min(820px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
      }}>
        <div style={{ padding: "14px 20px 10px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Curated index</div>
            <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
              Paste an awesome-X style markdown index. We extract every GitHub link and let you batch-install.
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--surface0)" }}>
          {error && <div style={errBanner}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/ComposioHQ/awesome-claude-skills"
              style={{ ...inp, flex: 1 }}
              disabled={loading || installing}
            />
            <button onClick={() => void loadIndex()} disabled={loading || !url.trim()} style={btnPrimary}>
              {loading ? "Loading…" : "Load"}
            </button>
          </div>
          <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span>Try:</span>
            {CURATED_SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setUrl(s)}
                style={{ background: "transparent", border: "none", color: "var(--blue)", cursor: "pointer", padding: 0, fontSize: 10, fontFamily: "var(--font-mono, monospace)" }}
                disabled={loading || installing}
              >
                {s.replace("https://github.com/", "")}
              </button>
            ))}
          </div>
        </div>

        {source && items.length > 0 && (
          <div style={{
            padding: "10px 20px", borderBottom: "1px solid var(--surface0)",
            display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
          }}>
            <div style={{ fontSize: 11, color: "var(--subtext0)" }}>
              <strong style={{ color: "var(--text)" }}>{items.length}</strong> skills in {source.owner}/{source.repo}
              <span style={{ color: "var(--overlay0)" }}> · sha {source.sha.slice(0, 7)}</span>
            </div>
            <div style={{ flex: 1 }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter…"
              style={{ ...inp, width: 180, padding: "5px 8px", fontSize: 11 }}
            />
            <div style={{ display: "flex", gap: 4 }}>
              {(["guideline", "playbook", "reference"] as Category[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setDefaultCategory(c)}
                  title={`Set category for batch: ${CATEGORY_DESC[c]}`}
                  style={{
                    padding: "5px 10px", borderRadius: 5,
                    border: defaultCategory === c ? "1px solid var(--blue)" : "1px solid var(--surface1)",
                    background: defaultCategory === c ? "rgba(20,99,255,0.10)" : "transparent",
                    color: defaultCategory === c ? "var(--blue)" : "var(--subtext0)",
                    fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
                  }}
                >
                  {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}>
          {!source && !loading && items.length === 0 && (
            <div style={muted}>Load an index above to see its skills here.</div>
          )}
          {source && filtered.length === 0 && !loading && (
            <div style={muted}>No items match the filter.</div>
          )}
          {Array.from(grouped.entries()).map(([section, sectionItems]) => {
            const allSelected = sectionItems.every((i) => selected.has(i.url));
            return (
              <div key={section} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {section}
                  </div>
                  <div style={{ fontSize: 9, color: "var(--overlay0)" }}>({sectionItems.length})</div>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={() => toggleSection(sectionItems)}
                    disabled={installing}
                    style={{ ...btnGhost, padding: "2px 8px", fontSize: 9 }}
                  >
                    {allSelected ? "Unselect all" : "Select all"}
                  </button>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {sectionItems.map((it) => {
                    const slug = deriveSlugFromUrl(it);
                    const alreadyInstalled = installedSlugs.has(slug);
                    const isChecked = selected.has(it.url);
                    const status = statusByUrl[it.url];
                    return (
                      <label
                        key={it.url}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 8,
                          padding: "6px 8px", borderRadius: 5,
                          border: "1px solid var(--surface0)",
                          background: isChecked ? "rgba(20,99,255,0.05)" : "var(--mantle)",
                          cursor: installing || alreadyInstalled ? "not-allowed" : "pointer",
                          opacity: alreadyInstalled ? 0.5 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggle(it.url)}
                          disabled={installing || alreadyInstalled}
                          style={{ marginTop: 3 }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 12, fontWeight: 600 }}>{it.title}</span>
                            <code style={{ fontSize: 9, color: "var(--overlay0)" }}>{slug}</code>
                            {alreadyInstalled && <span style={{ fontSize: 9, color: "var(--green)", fontWeight: 600 }}>✓ installed</span>}
                            {status === "ok"       && <span style={{ fontSize: 9, color: "var(--green)", fontWeight: 600 }}>✓ added</span>}
                            {status === "skipped"  && <span style={{ fontSize: 9, color: "var(--peach)", fontWeight: 600 }}>↷ slug exists</span>}
                            {status === "installing" && <span style={{ fontSize: 9, color: "var(--blue)" }}>installing…</span>}
                            {typeof status === "object" && "error" in status && (
                              <span style={{ fontSize: 9, color: "var(--red)" }} title={status.error}>✗ {status.error.slice(0, 40)}</span>
                            )}
                          </div>
                          {it.description && (
                            <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4, marginTop: 2 }}>
                              {it.description}
                            </div>
                          )}
                          <div style={{ fontSize: 9, color: "var(--overlay0)", marginTop: 2, fontFamily: "var(--font-mono, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {it.url.replace("https://github.com/", "")}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--surface0)", display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ fontSize: 11, color: "var(--overlay0)" }}>
            {selected.size > 0 ? `${selected.size} selected — category: ${CATEGORY_LABEL[defaultCategory]}` : "Select skills to install"}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={installing} style={btnGhost}>Close</button>
          <button onClick={() => void installSelected()} disabled={installing || selected.size === 0} style={btnPrimary}>
            {installing ? "Installing…" : `Install ${selected.size || ""}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Inherited skill row (project context only) ───────────────────────── */

function InheritedRowView({ row, state, canWrite, onDisableHere, onReEnable }: {
  row:           SkillRow;
  state:         "active" | "disabled-here" | "overridden";
  canWrite:      boolean;
  onDisableHere: () => void;
  onReEnable:    () => void;
}) {
  const palette: Record<Category, { bg: string; fg: string }> = {
    guideline: { bg: "rgba(20,99,255,0.10)",   fg: "var(--blue)"  },
    playbook:  { bg: "rgba(28,191,107,0.10)",  fg: "var(--green)" },
    reference: { bg: "rgba(124,92,252,0.10)",  fg: "var(--mauve)" },
  };
  const p = palette[row.category];

  const isDimmed = state !== "active";
  return (
    <div style={{
      padding: "8px 12px", borderRadius: 6,
      background: state === "disabled-here" ? "var(--surface0)" : "var(--mantle)",
      border: "1px dashed var(--surface1)",
      opacity: isDimmed ? 0.7 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
          background: p.bg, color: p.fg,
          textTransform: "uppercase", letterSpacing: "0.04em",
        }}>{CATEGORY_LABEL[row.category]}</span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{row.name}</span>
        <code style={{ fontSize: 10, color: "var(--overlay0)" }}>{row.slug}</code>
        {row.origin !== "custom" && (
          <span style={{ fontSize: 9, color: "var(--overlay0)", fontStyle: "italic" }}>{row.origin}</span>
        )}
        {state === "active" && (
          <span style={{ fontSize: 9, color: "var(--green)", fontWeight: 600 }} title="Materialised in this project">
            active
          </span>
        )}
        {state === "disabled-here" && (
          <span style={{ fontSize: 9, color: "var(--peach)", fontWeight: 600 }} title="Suppressed for this project">
            disabled here
          </span>
        )}
        {state === "overridden" && (
          <span style={{ fontSize: 9, color: "var(--mauve)", fontWeight: 600 }} title="Replaced by your project-specific version below">
            overridden by project
          </span>
        )}
        <div style={{ flex: 1 }} />
        {canWrite && state === "active" && (
          <button onClick={onDisableHere} style={btnGhost} title="Suppress this skill for this project only — factory-default still applies elsewhere">
            Disable here
          </button>
        )}
        {canWrite && state === "disabled-here" && (
          <button onClick={onReEnable} style={btnGhost} title="Restore the inherited factory-default for this project">
            Re-enable
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4 }}>
        {row.description}
      </div>
    </div>
  );
}

function SkillRowView({ row, canWrite, update, applying, overrides, onEdit, onDelete, onToggle, onPublish, onApplyUpdate }: {
  row:           SkillRow;
  canWrite:      boolean;
  update?:       UpdateCheckResult;
  applying:      boolean;
  /** True when this project-specific row shadows a factory-default with the same slug. */
  overrides?:    boolean;
  onEdit:        () => void;
  onDelete:      () => void;
  onToggle:      () => void;
  onPublish:     () => void;
  onApplyUpdate: () => void;
}) {
  const palette: Record<Category, { bg: string; fg: string }> = {
    guideline: { bg: "rgba(20,99,255,0.10)",   fg: "var(--blue)"  },
    playbook:  { bg: "rgba(28,191,107,0.10)",  fg: "var(--green)" },
    reference: { bg: "rgba(124,92,252,0.10)",  fg: "var(--mauve)" },
  };
  const p = palette[row.category];

  return (
    <div style={{
      padding: "8px 12px", borderRadius: 6,
      background: row.enabled ? "var(--mantle)" : "var(--surface0)",
      border: "1px solid var(--surface0)",
      opacity: row.enabled ? 1 : 0.6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
          background: p.bg, color: p.fg,
          textTransform: "uppercase", letterSpacing: "0.04em",
        }}>{CATEGORY_LABEL[row.category]}</span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{row.name}</span>
        <code style={{ fontSize: 10, color: "var(--overlay0)" }}>{row.slug}</code>
        {row.origin !== "custom" && (
          <span style={{ fontSize: 9, color: "var(--overlay0)", fontStyle: "italic" }}>{row.origin}</span>
        )}
        {!row.enabled && (
          <span style={{ fontSize: 9, color: "var(--overlay0)", fontStyle: "italic" }}>disabled</span>
        )}
        {overrides && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
            background: "rgba(124,92,252,0.10)", color: "var(--mauve)",
            textTransform: "uppercase", letterSpacing: "0.04em",
          }} title="This project-specific skill replaces the factory-default of the same slug.">
            overrides factory
          </span>
        )}
        {update?.has_update && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
            background: "rgba(254,166,73,0.12)", color: "var(--peach)",
            textTransform: "uppercase", letterSpacing: "0.04em",
          }} title={`${update.current_version ?? "?"} → ${update.latest_version ?? "?"}`}>
            update available
          </span>
        )}
        {update?.error && (
          <span style={{ fontSize: 9, color: "var(--red)" }} title={update.error}>check failed</span>
        )}
        <div style={{ flex: 1 }} />
        {canWrite && (
          <>
            {update?.has_update && (
              <button onClick={onApplyUpdate} disabled={applying} style={{ ...btnGhost, color: "var(--peach)", borderColor: "var(--peach)" }} title={`Apply ${update.latest_version ?? "latest"} — overwrites the body`}>
                {applying ? "Updating…" : "Update"}
              </button>
            )}
            {row.origin === "custom" && (
              <button onClick={onPublish} style={btnGhost} title="Publish this skill to the marketplace so other tenants can install it">
                Publish
              </button>
            )}
            <button onClick={onToggle} style={btnGhost} title={row.enabled ? "Disable (skip materialisation)" : "Enable (materialise on dispatch)"}>
              {row.enabled ? "Disable" : "Enable"}
            </button>
            <button onClick={onEdit} style={btnGhost}>Edit</button>
            <button onClick={onDelete} style={{ ...btnGhost, color: "var(--red)" }}>Delete</button>
          </>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4 }}>
        {row.description}
      </div>
    </div>
  );
}

function SkillEditor({ factoryId, projectId, row, onClose, onSaved }: {
  factoryId: string;
  projectId?: string;
  row:       SkillRow | null;
  onClose:   () => void;
  onSaved:   () => void;
}) {
  const isNew = !row;
  const [slug,        setSlug]        = useState(row?.slug ?? "");
  const [name,        setName]        = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [body,        setBody]        = useState(row?.body ?? "");
  const [category,    setCategory]    = useState<Category>(row?.category ?? "guideline");
  const [allowedTools, setAllowedTools] = useState((row?.allowed_tools ?? []).join(", "));
  const [disableModelInvocation, setDisableModelInvocation] = useState(row?.disable_model_invocation ?? false);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  async function save() {
    if (!slug.trim() || !name.trim() || !description.trim() || !body.trim()) {
      setError("Slug, Name, Description, and Body are required.");
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      factory_id:               factoryId,
      project_id:               projectId ?? null,
      slug:                     slugify(slug.trim(), { keepDashes: true }),
      name:                     name.trim(),
      description:              description.trim().slice(0, 500),
      body:                     body.trim(),
      category,
      allowed_tools:            allowedTools.split(",").map((s) => s.trim()).filter(Boolean),
      disable_model_invocation: disableModelInvocation,
      origin:                   "custom" as const,
    };
    try {
      const { error: err } = isNew
        ? await supabase.from("factory_skills").insert(payload)
        : await supabase.from("factory_skills").update(payload).eq("id", row!.id);
      if (err) throw new Error(err.message);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16,
    }}>
      <div style={{
        background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14,
        width: "min(720px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
      }}>
        <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{isNew ? "New skill" : `Edit: ${row!.name}`}</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px 18px" }}>
          {error && <div style={errBanner}>{error}</div>}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={lbl}>Slug</label>
              <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="clean-code" style={inp} disabled={!isNew} />
            </div>
            <div>
              <label style={lbl}>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Clean Code" style={inp} />
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Category</label>
            <div style={{ display: "flex", gap: 6 }}>
              {(["guideline", "playbook", "reference"] as Category[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  title={CATEGORY_DESC[c]}
                  style={{
                    flex: 1, padding: "8px 10px", borderRadius: 6,
                    border: category === c ? "1px solid var(--blue)" : "1px solid var(--surface1)",
                    background: category === c ? "rgba(20,99,255,0.10)" : "transparent",
                    color: category === c ? "var(--blue)" : "var(--subtext0)",
                    fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
                  }}
                >
                  {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>{CATEGORY_DESC[category]}</div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Description (always loaded — keep it concise)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="One sentence the agent reads at session start. Triggers when to invoke this skill. Cap ~500 chars."
              style={{ ...inp, resize: "vertical", lineHeight: 1.4 }}
            />
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2 }}>{description.length}/500</div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Body (loaded only when the agent invokes this skill)</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              placeholder="Markdown content. Principles, steps, references, examples. The agent reads this when it decides the skill is relevant to the current task."
              style={{ ...inp, resize: "vertical", lineHeight: 1.5, fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Allowed MCP tools (comma-separated, optional)</label>
            <input
              value={allowedTools}
              onChange={(e) => setAllowedTools(e.target.value)}
              placeholder="read_artifact, write_sprint_workspace"
              style={inp}
            />
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2 }}>
              Restricts the skill to a specific MCP toolset. Leave empty to inherit the agent&apos;s allowlist.
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={disableModelInvocation} onChange={(e) => setDisableModelInvocation(e.target.checked)} />
            <span style={{ fontSize: 11, color: "var(--subtext0)" }}>
              <strong>Operator-only invocation</strong> — model can&apos;t auto-invoke (you call it via /slash)
            </span>
          </label>
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--surface0)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={saving} style={btnGhost}>Cancel</button>
          <button onClick={() => void save()} disabled={saving} style={btnPrimary}>
            {saving ? "Saving…" : isNew ? "Create skill" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Publish-skill modal — Phase 5 Slice E ────────────────────────────── */

function PublishSkillModal({ skill, authToken, onClose, onDone }: {
  skill:     SkillRow;
  authToken: string;
  onClose:   () => void;
  onDone:    () => void;
}) {
  const [name,        setName]        = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [success,     setSuccess]     = useState<string | null>(null);

  async function publish() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/marketplace/skills/publish", {
        method:  "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body:    JSON.stringify({
          skill_id:    skill.id,
          name:        name.trim(),
          description: description.trim(),
        }),
      });
      const b = await res.json().catch(() => ({})) as { error?: string; listingId?: string };
      if (!res.ok) throw new Error(b.error ?? `Publish failed (${res.status})`);
      setSuccess("Published to marketplace. Other tenants can now install this skill.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unpublish() {
    if (!confirm("Unpublish this skill? Existing installs keep working — only new installs are blocked.")) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/marketplace/skills/publish?action=unpublish", {
        method:  "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ skill_id: skill.id }),
      });
      const b = await res.json().catch(() => ({})) as { error?: string; archived?: boolean };
      if (!res.ok) throw new Error(b.error ?? `Unpublish failed (${res.status})`);
      setSuccess(b.archived ? "Skill listing archived." : "No active listing — nothing to unpublish.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16,
    }}>
      <div style={{
        background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14,
        width: "min(560px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
      }}>
        <div style={{ padding: "14px 20px 10px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Publish to marketplace</div>
            <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
              Snapshots this skill into a public listing. Other tenants install a copy — your future edits don&apos;t auto-update theirs.
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px 18px" }}>
          {error   && <div style={errBanner}>{error}</div>}
          {success && (
            <div style={{ ...errBanner, color: "var(--green)", background: "rgba(28,191,107,0.08)", border: "1px solid rgba(28,191,107,0.25)" }}>
              {success}
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Listing name (browsers see this)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} style={inp} disabled={busy} />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={lbl}>Listing description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{ ...inp, resize: "vertical", lineHeight: 1.4 }}
              disabled={busy}
            />
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2 }}>{description.length}/500</div>
          </div>

          <div style={{ padding: "8px 10px", borderRadius: 6, background: "var(--surface0)", fontSize: 10, color: "var(--subtext0)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--text)" }}>Slug:</strong> <code>{skill.slug}</code> · <strong style={{ color: "var(--text)" }}>Category:</strong> {skill.category}
            {skill.allowed_tools.length > 0 && <> · <strong style={{ color: "var(--text)" }}>Tools:</strong> <code>{skill.allowed_tools.join(",")}</code></>}
          </div>
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--surface0)", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => void unpublish()} disabled={busy} style={{ ...btnGhost, color: "var(--red)" }}>Unpublish</button>
          <div style={{ flex: 1 }} />
          <button onClick={success ? onDone : onClose} disabled={busy} style={btnGhost}>
            {success ? "Done" : "Cancel"}
          </button>
          <button onClick={() => void publish()} disabled={busy || !name.trim() || !description.trim()} style={btnPrimary}>
            {busy ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Marketplace browser — Phase 5 Slice E ────────────────────────────── */

interface MarketplaceSkillRow {
  id:          string;
  name:        string;
  description: string;
  price_cents: number;
  currency:    string;
  category:    Category;
  slug:        string;
  store:       { slug: string; name: string; verified: boolean } | null;
  installed:   boolean;
  created_at:  string;
}

function MarketplaceBrowser({ factoryId, projectId, installedSlugs, authToken, onClose, onInstalled }: {
  factoryId:      string;
  projectId?:     string;
  installedSlugs: Set<string>;
  authToken:      string;
  onClose:        () => void;
  onInstalled:    () => void;
}) {
  const [list,    setList]    = useState<MarketplaceSkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [filter,  setFilter]  = useState<"all" | Category>("all");

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/marketplace/skills", {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const body = await res.json() as { skills: MarketplaceSkillRow[] };
        setList(body.skills ?? []);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [authToken]);

  async function install(row: MarketplaceSkillRow) {
    setInstallingId(row.id);
    setError(null);
    try {
      const res = await fetch("/api/marketplace/install", {
        method:  "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body:    JSON.stringify({
          listingId:       row.id,
          targetFactoryId: factoryId,
          targetProjectId: projectId ?? undefined,
        }),
      });
      const b = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(b.error ?? `Install failed (${res.status})`);
      onInstalled();
      // Optimistically mark as installed in this modal too.
      setList((cur) => cur.map((r) => r.id === row.id ? { ...r, installed: true } : r));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstallingId(null);
    }
  }

  const filtered = filter === "all" ? list : list.filter((s) => s.category === filter);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16,
    }}>
      <div style={{
        background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14,
        width: "min(720px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
      }}>
        <div style={{ padding: "14px 20px 10px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Marketplace skills</div>
            <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
              Public skill listings published by other tenants. Install copies a snapshot — publisher edits won&apos;t silently update yours.
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ padding: "10px 20px", borderBottom: "1px solid var(--surface0)", display: "flex", gap: 6 }}>
          {(["all", "guideline", "playbook", "reference"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: "5px 10px", borderRadius: 5,
                border: filter === f ? "1px solid var(--blue)" : "1px solid var(--surface1)",
                background: filter === f ? "rgba(20,99,255,0.10)" : "transparent",
                color: filter === f ? "var(--blue)" : "var(--subtext0)",
                fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
                textTransform: "capitalize",
              }}
            >
              {f === "all" ? "All" : CATEGORY_LABEL[f as Category]}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}>
          {error && <div style={errBanner}>{error}</div>}
          {loading ? (
            <div style={muted}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={muted}>
              No skills published yet for this filter. Be the first — click Publish on a custom skill above.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {filtered.map((s) => {
                const isInstalled  = s.installed || installedSlugs.has(s.slug);
                const isBusy       = installingId === s.id;
                const palette =
                  s.category === "guideline" ? { bg: "rgba(20,99,255,0.10)",   fg: "var(--blue)"  } :
                  s.category === "playbook"  ? { bg: "rgba(28,191,107,0.10)",  fg: "var(--green)" } :
                                                { bg: "rgba(124,92,252,0.10)",  fg: "var(--mauve)" };
                return (
                  <div key={s.id} style={{
                    padding: "10px 12px", borderRadius: 6,
                    border: "1px solid var(--surface0)", background: "var(--mantle)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                        background: palette.bg, color: palette.fg,
                        textTransform: "uppercase", letterSpacing: "0.04em",
                      }}>{CATEGORY_LABEL[s.category]}</span>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</span>
                      <code style={{ fontSize: 10, color: "var(--overlay0)" }}>{s.slug}</code>
                      {s.store && (
                        <span style={{ fontSize: 9, color: "var(--overlay0)" }}>
                          by {s.store.name}{s.store.verified && " ✓"}
                        </span>
                      )}
                      {s.price_cents > 0 && (
                        <span style={{ fontSize: 9, color: "var(--peach)", fontWeight: 600 }}>
                          {(s.price_cents / 100).toFixed(2)} {s.currency}
                        </span>
                      )}
                      <div style={{ flex: 1 }} />
                      {isInstalled ? (
                        <span style={{ fontSize: 10, color: "var(--green)", fontWeight: 600 }}>✓ installed</span>
                      ) : (
                        <button
                          onClick={() => void install(s)}
                          disabled={isBusy}
                          style={{ ...btnPrimary, padding: "4px 10px", fontSize: 10 }}
                        >
                          {isBusy ? "Installing…" : "Install"}
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4 }}>
                      {s.description}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
const lbl: React.CSSProperties = {
  display: "block", fontSize: 10, fontWeight: 700,
  color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em",
  marginBottom: 4,
};
const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 12,
  background: "var(--base)", color: "var(--text)",
  border: "1px solid var(--surface1)", borderRadius: 6,
  fontFamily: "var(--font-sans)",
};
