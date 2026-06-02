"use client";

/**
 * PIP Manager — Studio's home for the Project Inception Pack feature.
 *
 * Sub-navs:
 *   - Run Inception   — form to dispatch a pip-reverse-engineering sprint
 *                       against a local directory + optional refs
 *   - Browse          — list inception projects with sprint status
 *   - Import          — paste/upload PIP JSON, validate, review, apply
 *   - Export          — pick a project, emit PIP JSON
 *   - Internals       — RE pipeline detail / debug
 *   - Settings        — CLI/LLM defaults for the RE agents
 *
 * v1.0 is DB-only — see lib/pip-spec.ts and the project_pip_*.md memos.
 */
import React, { useEffect, useRef, useState } from "react";
import { Wand2, FileInput, FileOutput, SlidersHorizontal, Plus, Trash2, AlertCircle, Loader2, Rocket, Upload, CheckCircle2, Download, History, ExternalLink, Send, Workflow } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { brand } from "@/lib/brand";
import { PipSchema, type Pip } from "@/lib/pip-spec";
import {
  studioSectionContainer,
  studioBtnGhost,
  studioBtnPrimary,
  studioMuted,
  studioErrBanner,
  studioInputStyle,
  StudioSectionHeader,
} from "@/components/StudioSectionChrome";

export type PipManagerSubTab = "run" | "browse" | "import" | "export" | "internals" | "settings";

const SUBTABS: { id: PipManagerSubTab; label: string; icon: React.FC<{ size?: number }> }[] = [
  { id: "run",       label: "Run Inception", icon: Wand2                },
  { id: "browse",    label: "Browse",        icon: History              },
  { id: "import",    label: "Import",        icon: FileInput            },
  { id: "export",    label: "Export",        icon: FileOutput           },
  { id: "internals", label: "Internals",     icon: Workflow             },
  { id: "settings",  label: "Settings",      icon: SlidersHorizontal    },
];

export function PipManagerSection({ factoryId, canWrite }: {
  factoryId: string;
  canWrite:  boolean;
}) {
  const [sub, setSub] = useState<PipManagerSubTab>("run");

  if (!factoryId) {
    return (
      <div style={studioSectionContainer}>
        <div style={studioMuted}>Select a factory first.</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Sub-nav strip — matches Advanced's pattern. */}
      <div style={{ borderBottom: "1px solid var(--surface0)", background: "var(--mantle)", padding: "8px 24px", display: "flex", gap: 4, flexShrink: 0 }}>
        {SUBTABS.map(({ id, label, icon: Icon }) => {
          const active = sub === id;
          return (
            <button
              key={id}
              onClick={() => setSub(id)}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "5px 12px", borderRadius: 7, border: "none",
                background: active ? "var(--surface0)" : "transparent",
                color:      active ? "var(--text)"     : "var(--overlay0)",
                fontSize: 12, fontWeight: active ? 700 : 500,
                cursor: "pointer", fontFamily: "var(--font-sans)",
                transition: "all 0.15s",
              }}
            >
              <Icon size={13} />
              {label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        {sub === "run"       && <PipRunPane       factoryId={factoryId} canWrite={canWrite} />}
        {sub === "browse"    && <PipBrowsePane    factoryId={factoryId} canWrite={canWrite} />}
        {sub === "import"    && <PipImportPane    factoryId={factoryId} canWrite={canWrite} />}
        {sub === "export"    && <PipExportPane    factoryId={factoryId} canWrite={canWrite} />}
        {sub === "internals" && <PipInternalsPane factoryId={factoryId} canWrite={canWrite} />}
        {sub === "settings"  && <PipSettingsPane  factoryId={factoryId} canWrite={canWrite} />}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Sub-panes
 * ───────────────────────────────────────────────────────────────── */

interface PipRef {
  name:        string;
  source:      string;
  description: string;
}

interface PipelineStatus {
  state: "loading" | "installed" | "missing";
  /** Marketplace store slug to deep-link to when state==="missing".
   *  Always "built-in" today; kept on the response shape so a future
   *  third-party publisher of pip-reverse-engineering can override.
   *  We deep-link to the store (not the listing detail page) because
   *  pipeline-typed listings don't have a standalone detail view — they
   *  surface inside the parent factory listing. */
  storeSlug: string;
}

function PipRunPane({ factoryId, canWrite }: { factoryId: string; canWrite: boolean }) {
  const [localPath, setLocalPath]     = useState("");
  const [remoteUrl, setRemoteUrl]     = useState("");
  const [projectName, setProjectName] = useState("");
  const [refs, setRefs]               = useState<PipRef[]>([]);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [result, setResult]           = useState<{ projectId: string; projectSlug: string; sprintId: string } | null>(null);
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>({
    state: "loading", storeSlug: "built-in",
  });
  // Per-inception auto-apply. Default off — operator opts in per
  // dispatch via the checkbox next to the source path.
  const [autoApply, setAutoApply] = useState<boolean>(false);

  // Detection follows the canonical ref pattern (CLAUDE.md rule 7): the
  // status endpoint checks for a marketplace_installs row pointing at
  // the canonical pipeline listing. After mig 196 widened the worker's
  // tenants RLS to expose the built-in row, the worker resolver finds
  // the 7 RE agents via canonical fallback — no clone required, the
  // ref-mode marketplace install is enough.
  const checkPipelineInstalled = async () => {
    setPipelineStatus((s) => ({ ...s, state: "loading" }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch(
        `/api/factory/pip/inception/status?factoryId=${encodeURIComponent(factoryId)}`,
        { headers: { Authorization: `Bearer ${session.access_token}` } },
      );
      const body = (await res.json().catch(() => ({}))) as {
        installed?: boolean; storeSlug?: string;
      };
      if (!res.ok) throw new Error("status check failed");
      setPipelineStatus({
        state:     body.installed ? "installed" : "missing",
        storeSlug: body.storeSlug ?? "built-in",
      });
    } catch {
      setPipelineStatus({ state: "missing", storeSlug: "built-in" });
    }
  };

  useEffect(() => {
    void checkPipelineInstalled();
  }, [factoryId]);


  function addRef()                                        { setRefs((p) => [...p, { name: "", source: "", description: "" }]); }
  function updateRef(idx: number, patch: Partial<PipRef>)  { setRefs((p) => p.map((r, i) => i === idx ? { ...r, ...patch } : r)); }
  function removeRef(idx: number)                          { setRefs((p) => p.filter((_, i) => i !== idx)); }

  function buildSource(): { ok: true; source: Record<string, unknown> } | { ok: false; error: string } {
    if (!localPath.trim()) return { ok: false, error: "Local path is required." };
    const out: Record<string, unknown> = { local_path: localPath.trim() };
    if (remoteUrl.trim()) {
      try { new URL(remoteUrl.trim()); } catch { return { ok: false, error: "Remote URL is not a valid URL." }; }
      out.remote_url = remoteUrl.trim();
    }
    return { ok: true, source: out };
  }

  // Default project name derived from local_path basename — operator
  // sees the auto-derived value and can override.
  const derivedProjectName = (() => {
    const last = localPath.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    if (!last) return "";
    return last.split(/[-_]/).filter(Boolean).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
  })();

  async function dispatch() {
    if (!canWrite) return;
    const built = buildSource();
    if (!built.ok) { setError(built.error); return; }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const cleanRefs = refs
        .filter((r) => r.name.trim() && r.source.trim())
        .map((r) => ({
          name:        r.name.trim(),
          source:      r.source.trim(),
          description: r.description.trim() || undefined,
        }));
      const res = await fetch("/api/factory/pip/inception", {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          factoryId,
          source:      built.source,
          projectName: projectName.trim() || undefined,
          refs:        cleanRefs.length > 0 ? cleanRefs : undefined,
          autoApply,
        }),
      });
      const body = await res.json().catch(() => ({})) as { projectId?: string; projectSlug?: string; sprintId?: string; error?: string; hint?: string };
      if (!res.ok || !body.projectId) {
        throw new Error(`${body.error ?? `Dispatch failed (${res.status})`}${body.hint ? ` — ${body.hint}` : ""}`);
      }
      setResult({ projectId: body.projectId, projectSlug: body.projectSlug ?? "", sprintId: body.sprintId ?? "" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const submitDisabled =
    busy ||
    pipelineStatus.state !== "installed" ||
    !localPath.trim();

  return (
    <div style={studioSectionContainer}>
      <StudioSectionHeader
        title="Run Inception"
        subtitle={
          <>
            Dispatch a sprint of the <code style={{ fontFamily: "var(--font-mono)" }}>pip-reverse-engineering</code> pipeline against an existing codebase.
            A temporary project is created to hold the run; pip-composer calls apply_pip at the end to materialise the real project + components.
          </>
        }
      />

      {!canWrite ? (
        <div style={studioMuted}>Read-only — your role can't dispatch sprints.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Install-prerequisite banner — operator must install the
              pip-reverse-engineering pipeline listing once via the
              Marketplace. Default install mode is ref (creates a
              marketplace_installs row pointing at the canonical
              pipeline); after mig 196 widened the worker tenants RLS,
              ref-mode is enough — the worker resolves the 7 RE agents
              via canonical fallback without cloning. */}
          {pipelineStatus.state === "loading" && (
            <div style={{ padding: "10px 14px", background: "var(--surface0)", border: "1px solid var(--surface1)", borderRadius: 8, color: "var(--overlay0)", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
              Checking PIP pipeline install status…
            </div>
          )}
          {pipelineStatus.state === "missing" && (
            <div style={{ padding: "12px 16px", background: "rgba(245,194,107,0.06)", border: "1px solid rgba(245,194,107,0.4)", borderRadius: 8, color: "var(--peach)", fontSize: 12, lineHeight: 1.5 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, marginBottom: 6 }}>
                <AlertCircle size={14} /> PIP Reverse-Engineering pipeline not installed in this tenant
              </div>
              <div style={{ color: "var(--subtext0)", marginBottom: 8 }}>
                Install the canonical <code style={{ fontFamily: "var(--font-mono)" }}>pip-reverse-engineering</code> pipeline from the <code style={{ fontFamily: "var(--font-mono)" }}>built-in</code> Marketplace store. Default install (reference) is enough — the 5 RE agents (<code style={{ fontFamily: "var(--font-mono)" }}>pip-scout</code>, <code style={{ fontFamily: "var(--font-mono)" }}>pip-product-manager</code>, <code style={{ fontFamily: "var(--font-mono)" }}>pip-architect</code>, <code style={{ fontFamily: "var(--font-mono)" }}>pip-components-builder</code>, <code style={{ fontFamily: "var(--font-mono)" }}>pip-composer</code>) resolve via canonical fallback, no clone needed.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <a
                  href={`/marketplace/stores/${pipelineStatus.storeSlug}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ ...studioBtnPrimary, padding: "6px 12px", fontSize: 12, textDecoration: "none" }}
                >
                  Open built-in Marketplace store
                </a>
                <button onClick={() => void checkPipelineInstalled()} style={{ ...studioBtnGhost, padding: "6px 12px", fontSize: 12 }}>
                  I just installed it — refresh
                </button>
              </div>
            </div>
          )}
          {pipelineStatus.state === "installed" && (
            <div style={{ padding: "8px 14px", background: "rgba(126,190,114,0.06)", border: "1px solid rgba(126,190,114,0.25)", borderRadius: 6, color: "var(--green)", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
              <CheckCircle2 size={12} /> PIP pipeline installed in this tenant — ready to dispatch.
            </div>
          )}

          {/* Source — single Local mode. Operator passes a directory;
              worker auto-inits a git repo on the new project's first
              sprint if .git is absent. Clone-from-URL was retired —
              operators clone externally and pass the path. */}
          <div style={{ padding: "8px 12px", background: "rgba(245,194,107,0.06)", border: "1px solid rgba(245,194,107,0.3)", borderRadius: 6, color: "var(--peach)", fontSize: 11, lineHeight: 1.5 }}>
            <strong>Heads up:</strong> requires a local worker on this machine. Run <code style={{ fontFamily: "var(--font-mono)" }}>tp workers dev</code> before dispatching.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Local path (absolute)</label>
              <input
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/Users/me/code/my-project   or   C:\Users\me\code\my-project"
                style={{ ...studioInputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
                disabled={busy}
              />
              <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
                After apply, this becomes the project&apos;s working directory. The worker auto-inits a git repo at the first sprint dispatch if <code style={{ fontFamily: "var(--font-mono)" }}>.git</code> is absent.
              </div>
            </div>
            <label style={{ marginTop: 22, display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 12px", borderRadius: 8, background: "var(--surface0)", border: "1px solid var(--surface1)", cursor: busy ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={autoApply}
                disabled={busy}
                onChange={(e) => setAutoApply(e.target.checked)}
                style={{ marginTop: 2, accentColor: "var(--blue)" }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                  Auto-apply
                </div>
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2 }}>
                  Skip the human gate after pip-composer.
                </div>
              </div>
            </label>
          </div>
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Remote URL (optional)</label>
            <input
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://github.com/owner/repo (optional)"
              style={{ ...studioInputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
              disabled={busy}
            />
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
              Persisted to <code>projects.repo_url</code>. Operator can also set later via Project Settings.
            </div>
          </div>

          {/* Common: project name + refs */}
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Project name (optional)</label>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={derivedProjectName ? `auto: ${derivedProjectName}` : "auto-derived from local path"}
              style={studioInputStyle}
              disabled={busy}
              maxLength={200}
            />
          </div>

          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em" }}>References (optional)</label>
              <button onClick={addRef} disabled={busy} style={{ ...studioBtnGhost, padding: "4px 10px", fontSize: 11 }}>
                <Plus size={12} /> Add ref
              </button>
            </div>
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginBottom: 8 }}>
              URLs or paths the RE agents should read for additional context (design docs, ADRs, specs). Treated as authoritative.
            </div>
            {refs.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--overlay0)", fontStyle: "italic" }}>No references yet — source content alone is fine for most cases.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {refs.map((r, idx) => (
                  <div key={idx} style={{ padding: "10px 12px", background: "var(--surface0)", border: "1px solid var(--surface1)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        value={r.name}
                        onChange={(e) => updateRef(idx, { name: e.target.value })}
                        placeholder="Name (e.g. ADR-007)"
                        style={{ ...studioInputStyle, flex: "0 0 200px", fontSize: 12 }}
                        disabled={busy}
                      />
                      <input
                        value={r.source}
                        onChange={(e) => updateRef(idx, { source: e.target.value })}
                        placeholder="https://… or /path/to/file"
                        style={{ ...studioInputStyle, flex: 1, fontFamily: "var(--font-mono)", fontSize: 12 }}
                        disabled={busy}
                      />
                      <button onClick={() => removeRef(idx)} disabled={busy} title="Remove ref" style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: busy ? "not-allowed" : "pointer", padding: 6 }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <input
                      value={r.description}
                      onChange={(e) => updateRef(idx, { description: e.target.value })}
                      placeholder="Description (optional) — what is this ref about?"
                      style={{ ...studioInputStyle, fontSize: 11 }}
                      disabled={busy}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div style={studioErrBanner}>
              <AlertCircle size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {error}
            </div>
          )}

          {result && (
            <div style={{ padding: "10px 14px", background: "rgba(126,190,114,0.08)", border: "1px solid rgba(126,190,114,0.3)", borderRadius: 8, color: "var(--green)", fontSize: 12 }}>
              <strong>Inception dispatched.</strong> Temp project <code style={{ fontFamily: "var(--font-mono)" }}>{result.projectSlug}</code> is running the pip-reverse-engineering pipeline.
              {" "}
              <a href={`/pip/projects/${result.projectId}`} style={{ color: "var(--blue)", textDecoration: "underline" }}>Open inception →</a>
            </div>
          )}

          <div>
            <button
              onClick={dispatch}
              disabled={submitDisabled}
              style={{ ...studioBtnPrimary, padding: "10px 20px", fontSize: 13, opacity: submitDisabled ? 0.6 : 1 }}
            >
              {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Rocket size={14} />}
              {busy ? "Dispatching…" : "Dispatch Inception"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ImportReport {
  project_id:    string;
  project_slug:  string;
  inserted: {
    agents:           number;
    pipelines:        number;
    skills:           number;
    commands:         number;
    hooks:            number;
    output_styles:    number;
    permission_rules: number;
  };
  refs_validated: {
    agents:           number;
    pipelines:        number;
    skills:           number;
    commands:         number;
    hooks:            number;
    output_styles:    number;
    permission_rules: number;
  };
}

function PipImportPane({ factoryId, canWrite }: { factoryId: string; canWrite: boolean }) {
  const [text, setText]               = useState("");
  const [busy, setBusy]               = useState(false);
  const [validation, setValidation]   = useState<{ ok: boolean; pip?: Pip; errors?: { path: string; message: string }[] } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [report, setReport]           = useState<ImportReport | null>(null);
  const fileInputRef                  = useRef<HTMLInputElement>(null);

  function validate(rawText: string) {
    setReport(null);
    setServerError(null);
    if (!rawText.trim()) {
      setValidation(null);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      setValidation({ ok: false, errors: [{ path: "(root)", message: `Invalid JSON: ${(e as Error).message}` }] });
      return;
    }
    const result = PipSchema.safeParse(parsed);
    if (!result.success) {
      const errors = result.error.issues.slice(0, 25).map((iss) => ({
        path:    iss.path.length === 0 ? "(root)" : iss.path.map((p) => String(p)).join("."),
        message: iss.message,
      }));
      setValidation({ ok: false, errors });
      return;
    }
    setValidation({ ok: true, pip: result.data });
  }

  function handleTextChange(value: string) {
    setText(value);
    validate(value);
  }

  async function handleFile(file: File) {
    if (file.size > 5 * 1024 * 1024) {
      setValidation({ ok: false, errors: [{ path: "(file)", message: `File is ${file.size} bytes; max is 5 MB.` }] });
      return;
    }
    const content = await file.text();
    setText(content);
    validate(content);
  }

  async function applyImport() {
    if (!canWrite || !validation?.ok || !validation.pip) return;
    setBusy(true);
    setServerError(null);
    setReport(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch("/api/factory/pip/import", {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ factoryId, pip: validation.pip }),
      });
      const body = await res.json().catch(() => ({})) as Partial<ImportReport> & { error?: string; hint?: string };
      if (!res.ok || !body.project_id) {
        throw new Error(`${body.error ?? `Import failed (${res.status})`}${body.hint ? ` — ${body.hint}` : ""}`);
      }
      setReport(body as ImportReport);
    } catch (e) {
      setServerError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function counts(p: Pip): { label: string; n: number }[] {
    return [
      { label: "agents",        n: p.agents.length },
      { label: "pipelines",     n: p.pipelines.length },
      { label: "skills",        n: p.skills.length },
      { label: "commands",      n: p.commands.length },
      { label: "hooks",         n: p.hooks.length },
      { label: "output styles", n: p.output_styles.length },
      { label: "permissions",   n: p.permission_rules.length },
    ];
  }

  return (
    <div style={studioSectionContainer}>
      <StudioSectionHeader
        title="Import PIP"
        subtitle={
          <>
            Paste a PIP JSON or upload a file. We validate against <code style={{ fontFamily: "var(--font-mono)" }}>lib/pip-spec.ts</code>, resolve refs in scope order
            (project → factory → tenant → platform → marketplace), and report missing slugs before any row is written. Import is all-or-nothing — partial state never persists.
          </>
        }
        actions={canWrite && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
              style={{ display: "none" }}
            />
            <button onClick={() => fileInputRef.current?.click()} disabled={busy} style={studioBtnGhost}>
              <Upload size={13} /> Upload file
            </button>
          </>
        )}
      />

      {!canWrite ? (
        <div style={studioMuted}>Read-only — your role can't import.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>PIP JSON</label>
            <textarea
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              placeholder='Paste a PIP JSON here, or click Upload file above. Schema: lib/pip-spec.ts (schema_version "1.0").'
              rows={16}
              style={{ ...studioInputStyle, fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5, resize: "vertical" }}
              disabled={busy}
            />
          </div>

          {validation && !validation.ok && (
            <div style={{ padding: "10px 12px", background: "rgba(228,75,95,0.06)", border: "1px solid rgba(228,75,95,0.25)", borderRadius: 8, color: "var(--red)", fontSize: 11, lineHeight: 1.5 }}>
              <div style={{ fontWeight: 700, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <AlertCircle size={13} /> Validation failed ({validation.errors?.length} issue{(validation.errors?.length ?? 0) === 1 ? "" : "s"})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--subtext0)" }}>
                {validation.errors?.map((err, i) => (
                  <div key={i}><strong style={{ color: "var(--red)" }}>{err.path}</strong> — {err.message}</div>
                ))}
                {(validation.errors?.length ?? 0) >= 25 && <div style={{ color: "var(--overlay0)" }}>(showing first 25)</div>}
              </div>
            </div>
          )}

          {validation && validation.ok && validation.pip && (
            <div style={{ padding: "10px 14px", background: "rgba(126,190,114,0.06)", border: "1px solid rgba(126,190,114,0.25)", borderRadius: 8, color: "var(--green)", fontSize: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontWeight: 700 }}>
                <CheckCircle2 size={13} /> Schema valid · project: <code style={{ fontFamily: "var(--font-mono)" }}>{validation.pip.project.name}</code>
              </div>
              <div style={{ fontSize: 11, color: "var(--subtext0)", display: "flex", flexWrap: "wrap", gap: 12 }}>
                {counts(validation.pip).map((c) => (
                  <span key={c.label}>{c.label}: <strong>{c.n}</strong></span>
                ))}
              </div>
            </div>
          )}

          {serverError && (
            <div style={studioErrBanner}>
              <AlertCircle size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />
              {serverError}
            </div>
          )}

          {report && (
            <div style={{ padding: "12px 14px", background: "rgba(20,99,255,0.06)", border: "1px solid rgba(20,99,255,0.3)", borderRadius: 8, color: "var(--blue)", fontSize: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Import complete</div>
              <div style={{ fontSize: 11, color: "var(--subtext0)" }}>
                Project <code style={{ fontFamily: "var(--font-mono)" }}>{report.project_slug}</code> created.
                {" "}
                Inserted: agents {report.inserted.agents}, pipelines {report.inserted.pipelines}, skills {report.inserted.skills}, commands {report.inserted.commands}, hooks {report.inserted.hooks}, output styles {report.inserted.output_styles}, permissions {report.inserted.permission_rules}.
                {" "}
                <a href={`/projects/${report.project_id}`} style={{ color: "var(--blue)", textDecoration: "underline" }}>Open project →</a>
              </div>
            </div>
          )}

          <div>
            <button
              onClick={applyImport}
              disabled={busy || !validation?.ok}
              style={{ ...studioBtnPrimary, padding: "10px 20px", fontSize: 13, opacity: (busy || !validation?.ok) ? 0.6 : 1 }}
            >
              {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <FileInput size={14} />}
              {busy ? "Applying…" : "Apply PIP"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ExportableProject {
  id:       string;
  slug:     string;
  name:     string;
  status:   string;
  settings: Record<string, unknown> | null;
}

function PipExportPane({ factoryId }: { factoryId: string; canWrite: boolean }) {
  const [projects, setProjects] = useState<ExportableProject[]>([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState("");
  const [busy, setBusy]         = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from("projects")
        .select("id, slug, name, status, settings")
        .eq("factory_id", factoryId)
        .order("name");
      if (error) {
        setError(error.message);
        setProjects([]);
      } else {
        // Hide PIP-inception temp projects — they're managed in Browse.
        const filtered = (data ?? []).filter((p) => {
          const settings = (p.settings ?? {}) as { kind?: string };
          return settings.kind !== "pip-inception";
        }) as ExportableProject[];
        setProjects(filtered);
      }
      setLoading(false);
    })();
  }, [factoryId]);

  async function exportProject(project: ExportableProject) {
    setBusy(project.id);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch(`/api/projects/${project.id}/pip/export`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${project.slug}.pip.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const visible = filter.trim()
    ? projects.filter((p) => {
        const f = filter.toLowerCase();
        return p.name.toLowerCase().includes(f) || p.slug.toLowerCase().includes(f);
      })
    : projects;

  return (
    <div style={studioSectionContainer}>
      <StudioSectionHeader
        title="Export PIP"
        subtitle={
          <>
            Pick a project; we read its components from the DB and emit a PIP JSON. Inline customs are inlined verbatim;
            refs to canonicals stay as refs (with version pinning when available). PIP-inception temp projects are hidden — manage them under Browse.
          </>
        }
      />

      {error && (
        <div style={studioErrBanner}>
          <AlertCircle size={12} style={{ marginRight: 6, verticalAlign: "middle" }} /> {error}
        </div>
      )}

      {loading ? (
        <div style={studioMuted}>Loading projects…</div>
      ) : projects.length === 0 ? (
        <div style={studioMuted}>No projects in this factory yet.</div>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or slug…"
              style={{ ...studioInputStyle, fontSize: 12 }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {visible.map((p) => {
              const isBusy = busy === p.id;
              return (
                <div
                  key={p.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 14px", borderRadius: 8,
                    background: "var(--surface0)", border: "1px solid var(--surface1)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{p.name}</div>
                    <code style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>
                      {p.slug} · status: {p.status}
                    </code>
                  </div>
                  <button
                    onClick={() => void exportProject(p)}
                    disabled={isBusy}
                    style={{ ...studioBtnPrimary, padding: "6px 12px", fontSize: 12, opacity: isBusy ? 0.6 : 1 }}
                  >
                    {isBusy ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={12} />}
                    Export PIP
                  </button>
                </div>
              );
            })}
            {visible.length === 0 && (
              <div style={studioMuted}>No projects match &ldquo;{filter}&rdquo;.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface InceptionRow {
  id:                 string;
  slug:               string;
  name:               string;
  status:             string;
  created_at:         string;
  target_repo_url:    string | null;
  /** Operator-supplied source path (settings.pip_inception.workdir_setup.local_path). */
  source_path:        string | null;
  /** Worker-staged scratch tempdir for the latest dispatch. May not
   *  exist on disk anymore — it's auto-cleaned at sprint termination. */
  tempdir:            string | null;
  refs_count:         number;
  /** Latest sprint of this inception. */
  sprint_status:      string | null;
  sprint_id:          string | null;
  /** True iff the latest sprint stashed a pip.json into outcome. Drives
   *  the Apply / Download affordances in the row. */
  has_pip_json:       boolean;
}

const PIP_STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  running:      { bg: "rgba(20,99,255,0.10)",   fg: "var(--blue)"  },
  queued:       { bg: "rgba(245,194,107,0.12)", fg: "var(--peach)" },
  completed:    { bg: "rgba(126,190,114,0.10)", fg: "var(--green)" },
  pending_save: { bg: "rgba(245,194,107,0.12)", fg: "var(--peach)" },
  failed:       { bg: "rgba(228,75,95,0.10)",   fg: "var(--red)"   },
  waiting:      { bg: "rgba(245,194,107,0.12)", fg: "var(--peach)" },
};

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span style={{ fontSize: 10, color: "var(--overlay0)" }}>no sprint</span>;
  const c = PIP_STATUS_COLORS[status] ?? { bg: "var(--surface0)", fg: "var(--subtext0)" };
  return (
    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: c.bg, color: c.fg, textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: "var(--font-mono)" }}>
      {status}
    </span>
  );
}

function PipBrowsePane({ factoryId, canWrite }: { factoryId: string; canWrite: boolean }) {
  const [rows, setRows]     = useState<InceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  const [applyingId, setApplyingId]     = useState<string | null>(null);
  const [refreshTick, setRefreshTick]   = useState(0);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      // Inception projects in this factory.
      const { data: projects, error: projErr } = await supabase
        .from("projects")
        .select("id, slug, name, status, created_at, settings")
        .eq("factory_id", factoryId)
        .filter("settings->>kind", "eq", "pip-inception")
        .order("created_at", { ascending: false });
      if (projErr) {
        setError(projErr.message);
        setLoading(false);
        return;
      }
      const inceptionIds = (projects ?? []).map((p) => p.id as string);
      // Latest sprint per inception. Group client-side after fetching all.
      // Pull outcome too so we can detect a stashed pip.json — that
      // signal drives the Apply / Download affordances on the row.
      const sprintsByProject = new Map<string, {
        id: string; status: string; created_at: string; has_pip: boolean;
      }>();
      if (inceptionIds.length > 0) {
        const { data: sprintRows, error: sprintErr } = await supabase
          .from("sprints")
          .select("id, project_id, status, created_at, outcome")
          .in("project_id", inceptionIds)
          .order("created_at", { ascending: false });
        if (sprintErr) {
          setError(sprintErr.message);
          setLoading(false);
          return;
        }
        for (const s of sprintRows ?? []) {
          const pid = s.project_id as string;
          if (!sprintsByProject.has(pid)) {
            const outcome = (s.outcome ?? {}) as Record<string, unknown>;
            sprintsByProject.set(pid, {
              id:         s.id as string,
              status:     s.status as string,
              created_at: s.created_at as string,
              has_pip:    !!outcome.pip_json,
            });
          }
        }
      }
      const merged: InceptionRow[] = (projects ?? []).map((p) => {
        const settings = (p.settings ?? {}) as {
          pip_inception?: {
            target_repo_url?: string;
            refs?:            unknown[];
            tempdir?:         string;
            workdir_setup?:   { local_path?: string };
          };
        };
        const sprint = sprintsByProject.get(p.id as string);
        return {
          id:              p.id          as string,
          slug:            p.slug        as string,
          name:            p.name        as string,
          status:          p.status      as string,
          created_at:      p.created_at  as string,
          target_repo_url: settings.pip_inception?.target_repo_url ?? null,
          source_path:     settings.pip_inception?.workdir_setup?.local_path ?? null,
          tempdir:         settings.pip_inception?.tempdir ?? null,
          refs_count:      Array.isArray(settings.pip_inception?.refs) ? settings.pip_inception!.refs!.length : 0,
          sprint_status:   sprint?.status ?? null,
          sprint_id:       sprint?.id     ?? null,
          has_pip_json:    sprint?.has_pip ?? false,
        };
      });
      setRows(merged);
      setLoading(false);
    })();
  }, [factoryId, refreshTick]);

  async function discard(row: InceptionRow) {
    if (!canWrite) return;
    if (row.sprint_status === "running" || row.sprint_status === "queued") {
      alert("Can't discard while the inception sprint is still running. Wait or cancel the sprint first.");
      return;
    }
    if (!confirm(`Discard inception "${row.name}"? This deletes the temp project + sprints from the DB. The scratch tempdir on disk is auto-cleaned by the worker when the sprint terminates (success, gate-pause, or failure); the pip.json (if generated) survives in audit storage and you can still re-import it via PIP > Import.`)) return;
    setDiscardingId(row.id);
    setError(null);
    const { error: err } = await supabase.from("projects").delete().eq("id", row.id);
    setDiscardingId(null);
    if (err) {
      setError(err.message);
      return;
    }
    setRefreshTick((t) => t + 1);
  }

  // Apply — server-side endpoint reads sprints.outcome.pip_json, calls
  // pip_import RPC, deletes the temp project. On success the operator
  // jumps to the new real project's page.
  async function apply(row: InceptionRow) {
    if (!canWrite) return;
    if (!row.has_pip_json) {
      alert("This inception hasn't produced a pip.json yet. Wait for pip-composer to finish.");
      return;
    }
    if (!confirm(`Apply inception "${row.name}"? Creates the real project + components in this factory and discards the temp inception.`)) return;
    setApplyingId(row.id);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch("/api/factory/pip/inception/apply", {
        method:  "POST",
        headers: {
          Authorization:  `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inceptionProjectId: row.id }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        projectId?: string; projectSlug?: string; warnings?: string[]; error?: string;
      };
      if (!res.ok || !body.projectId) {
        throw new Error(body.error ?? `Apply failed (${res.status})`);
      }
      const warn = (body.warnings ?? []).filter(Boolean);
      const summary = `Applied — created /projects/${body.projectId}` + (warn.length > 0 ? `\n\nWarnings:\n${warn.map((w) => `• ${w}`).join("\n")}` : "");
      alert(summary);
      // Navigate to the new real project.
      window.location.href = `/projects/${body.projectId}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplyingId(null);
    }
  }

  // Download pip.json — fetch with the Bearer token (window.open won't
  // carry it), then trigger a blob download. Auth is API-route-required;
  // operators get 401 on raw URL navigation.
  async function downloadPipJson(row: InceptionRow) {
    if (!row.has_pip_json) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch(
        `/api/factory/pip/inception/pip-json?inceptionId=${encodeURIComponent(row.id)}`,
        { headers: { Authorization: `Bearer ${session.access_token}` } },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${row.slug}.pip.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div style={studioSectionContainer}>
      <StudioSectionHeader
        title="Browse inceptions"
        subtitle={
          <>
            Temporary scratch projects created by Run Inception. Each one ran the <code style={{ fontFamily: "var(--font-mono)" }}>pip-reverse-engineering</code> pipeline against a target repo and produced a <code style={{ fontFamily: "var(--font-mono)" }}>pip.json</code>.
            When ready, click <strong>Apply</strong> to materialise the real project + components in this factory (or <strong>pip.json</strong> to download for offline review / import via PIP &gt; Import). Discard removes the temp project without applying.
          </>
        }
        actions={(
          <button onClick={() => setRefreshTick((t) => t + 1)} style={studioBtnGhost}>Refresh</button>
        )}
      />

      {error && (
        <div style={studioErrBanner}>
          <AlertCircle size={12} style={{ marginRight: 6, verticalAlign: "middle" }} /> {error}
        </div>
      )}

      {loading ? (
        <div style={studioMuted}>Loading inceptions…</div>
      ) : rows.length === 0 ? (
        <div style={studioMuted}>
          No inceptions yet. Use <strong>Run Inception</strong> to scout an existing repo and generate a PIP.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((r) => {
            const isBusy = discardingId === r.id;
            return (
              <div
                key={r.id}
                style={{
                  padding: "12px 14px", borderRadius: 9,
                  background: "var(--surface0)", border: "1px solid var(--surface1)",
                  display: "flex", alignItems: "flex-start", gap: 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{r.name}</span>
                    <StatusBadge status={r.sprint_status} />
                    {r.has_pip_json && (
                      <span
                        title="pip.json is ready — click Apply to materialise the project, or Download for offline review"
                        style={{
                          fontSize: 9, fontWeight: 700,
                          padding: "2px 6px", borderRadius: 4,
                          background: "rgba(126,190,114,0.10)", color: "var(--green)",
                          textTransform: "uppercase", letterSpacing: "0.04em",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        Apply ready
                      </span>
                    )}
                  </div>
                  <code style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)", display: "block", marginBottom: 4 }}>
                    {r.slug}
                  </code>
                  {r.target_repo_url && (
                    <div style={{ fontSize: 11, color: "var(--subtext0)", display: "flex", alignItems: "center", gap: 4 }}>
                      <ExternalLink size={11} />
                      <a href={r.target_repo_url} target="_blank" rel="noreferrer" style={{ color: "var(--blue)", textDecoration: "none" }}>
                        {r.target_repo_url.replace(/^https:\/\/(www\.)?github\.com\//, "")}
                      </a>
                      {r.refs_count > 0 && (
                        <span style={{ color: "var(--overlay0)", marginLeft: 8 }}>+ {r.refs_count} ref{r.refs_count === 1 ? "" : "s"}</span>
                      )}
                    </div>
                  )}
                  {r.source_path && (
                    <div style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)", marginTop: 4, wordBreak: "break-all" }}>
                      <span style={{ color: "var(--overlay0)", fontFamily: "var(--font-sans)", marginRight: 4 }}>source:</span>
                      {r.source_path}
                    </div>
                  )}
                  {r.tempdir && (
                    <div style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)", marginTop: 2, wordBreak: "break-all" }} title="Scratch tempdir staged by the worker for the latest dispatch — auto-cleaned at sprint termination.">
                      <span style={{ color: "var(--overlay0)", fontFamily: "var(--font-sans)", marginRight: 4 }}>tempdir:</span>
                      {r.tempdir}
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
                    started {new Date(r.created_at).toLocaleString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {r.has_pip_json && (
                    <>
                      {canWrite && (
                        <button
                          onClick={() => void apply(r)}
                          disabled={isBusy || applyingId === r.id}
                          title="Apply the PIP — create the real project + components in this factory, then discard this temp inception"
                          style={{ ...studioBtnPrimary, padding: "6px 12px", fontSize: 11, opacity: applyingId === r.id ? 0.6 : 1, cursor: applyingId === r.id ? "wait" : "pointer", display: "flex", alignItems: "center", gap: 4 }}
                        >
                          {applyingId === r.id
                            ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
                            : <Send size={11} />}
                          {applyingId === r.id ? "Applying…" : "Apply"}
                        </button>
                      )}
                      <button
                        onClick={() => void downloadPipJson(r)}
                        title="Download pip.json (operator can review and import via PIP > Import)"
                        style={{ ...studioBtnGhost, padding: "6px 12px", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
                      >
                        <Download size={11} />
                        pip.json
                      </button>
                    </>
                  )}
                  <a
                    href={`/pip/projects/${r.id}`}
                    title="Open the inception run dashboard with pipeline canvas + actions"
                    style={{ ...studioBtnGhost, textDecoration: "none", padding: "6px 12px", fontSize: 11 }}
                  >
                    Open
                  </a>
                  {canWrite && (
                    <button
                      onClick={() => void discard(r)}
                      disabled={isBusy}
                      title="Delete the temp project + sprints"
                      style={{ ...studioBtnGhost, padding: "6px 12px", fontSize: 11, color: "var(--red)", borderColor: "rgba(228,75,95,0.3)", opacity: isBusy ? 0.6 : 1 }}
                    >
                      {isBusy ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={11} />}
                      Discard
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ───────────── PIP Internals — read-only inspector ───────────── */

interface PipInternalAgent {
  slug:        string;
  name:        string;
  squad:       string | null;
  level:       string | null;
  version:     string | null;
  description: string;
  tools:       string[];
  metadata:    Record<string, unknown>;
}

interface PipInternalPipeline {
  slug:        string;
  name:        string;
  description: string | null;
  intent:      string | null;
  steps:       Array<{ step: number; agent: string; gate: string | null; phase?: number; phaseName?: string }>;
}

function PipInternalsPane({ factoryId: _factoryId, canWrite: _canWrite }: { factoryId: string; canWrite: boolean }) {
  void _factoryId; void _canWrite;
  const [pipeline, setPipeline] = useState<PipInternalPipeline | null>(null);
  const [agents, setAgents]     = useState<PipInternalAgent[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        // RLS allows operators to read system pipelines (tenant_id IS NULL,
        // mig 021's `system_pipelines_read` policy) and built-in canonical
        // agents (mig 167, mig 196). Filter by exact slugs (more robust
        // than squad-prefix — squads were renamed in mig 200 but a future
        // squad rename would silently break the listing).
        const orderedSlugs = ["pip-scout", "pip-product-manager", "pip-architect", "pip-components-builder", "pip-composer"];
        const [{ data: pipeRow, error: pipeErr }, { data: agentRows, error: agErr }] = await Promise.all([
          supabase
            .from("pipelines")
            .select("slug, name, description, intent, steps")
            .eq("slug", "pip-reverse-engineering")
            .is("tenant_id", null)
            .maybeSingle(),
          supabase
            .from("agent_definitions")
            .select("slug, name, squad, level, version, spec, metadata, tenant_id")
            .in("slug", orderedSlugs),
        ]);
        if (pipeErr) throw new Error(`Pipeline lookup failed: ${pipeErr.message}`);
        if (agErr)   throw new Error(`Agent lookup failed: ${agErr.message}`);
        if (pipeRow) {
          const steps = (pipeRow.steps as Array<{ step: number; agent: string; gate: string | null; phase?: number; phaseName?: string }> | null) ?? [];
          setPipeline({
            slug:        pipeRow.slug as string,
            name:        pipeRow.name as string,
            description: (pipeRow.description as string | null) ?? null,
            intent:      (pipeRow.intent as string | null) ?? null,
            steps,
          });
        } else {
          setPipeline(null);
        }
        // Canonical PIP agents live under the built-in tenant (mig 200).
        // The operator's tenant could in theory have a same-slug clone
        // (legacy pre-mig 198 install path). Prefer the canonical row
        // when both exist so the persona shown is always the platform
        // version. Resolved via tenant_id presence — a row with
        // tenant_id matching the built-in is canonical; anything else
        // is a tenant clone and we ignore it for this view.
        // We can't get built-in tenant id without an extra query, so
        // simpler: prefer the row whose name starts with "PIP " (mig
        // 200 sets all 5 to that prefix). Fall through to first match.
        const bySlug = new Map<string, Record<string, unknown>>();
        for (const r of agentRows ?? []) {
          const slug = r.slug as string;
          const existing = bySlug.get(slug);
          if (!existing) { bySlug.set(slug, r as Record<string, unknown>); continue; }
          const isPipPrefix = (typeof r.name === "string" && r.name.startsWith("PIP "));
          if (isPipPrefix) bySlug.set(slug, r as Record<string, unknown>);
        }
        const ordered = orderedSlugs
          .map((s) => bySlug.get(s))
          .filter((r): r is Record<string, unknown> => !!r)
          .map((a) => {
            const spec = (a.spec ?? {}) as Record<string, unknown>;
            return {
              slug:        a.slug as string,
              name:        (a.name as string | null) ?? (a.slug as string),
              squad:       (a.squad as string | null) ?? null,
              level:       (a.level as string | null) ?? null,
              version:     (a.version as string | null) ?? null,
              description: typeof spec.description === "string" ? spec.description : "",
              tools:       Array.isArray(spec.tools) ? (spec.tools as string[]) : [],
              metadata:    (a.metadata as Record<string, unknown> | null) ?? {},
            };
          });
        setAgents(ordered);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div style={studioSectionContainer}>
      <StudioSectionHeader
        title="Internals"
        subtitle={
          <>
            Read-only view of the canonical PIP machinery: the <code style={{ fontFamily: "var(--font-mono)" }}>pip-reverse-engineering</code> pipeline and the 5 RE agents that execute it.
            These entities live under the platform&apos;s <code style={{ fontFamily: "var(--font-mono)" }}>built-in</code> tenant — they don&apos;t appear in Studio &gt; Pipelines or Studio &gt; Agents on purpose, since they&apos;re inception machinery, not project-running components.
            Persona / step changes ship via migration; this surface is for inspection only.
          </>
        }
      />

      {error && (
        <div style={studioErrBanner}>
          <AlertCircle size={12} style={{ marginRight: 6, verticalAlign: "middle" }} /> {error}
        </div>
      )}

      {loading ? (
        <div style={studioMuted}>Loading PIP internals…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

          {/* Pipeline section */}
          {!pipeline && (
            <div style={{ padding: "10px 14px", borderRadius: 6, background: "rgba(245,194,107,0.06)", border: "1px solid rgba(245,194,107,0.35)", color: "var(--peach)", fontSize: 11, lineHeight: 1.5 }}>
              <strong>PIP pipeline not available in this deployment.</strong> The reverse-engineering pipeline hasn&apos;t been provisioned yet. Contact your platform administrator if you need it enabled.
            </div>
          )}
          {pipeline && (
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                Pipeline
              </div>
              <div style={{
                padding: "14px 16px", borderRadius: 9,
                background: "var(--surface0)", border: "1px solid var(--surface1)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <code style={{ fontSize: 13, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                    {pipeline.slug}
                  </code>
                  {pipeline.intent && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(20,99,255,0.10)", color: "var(--blue)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      {pipeline.intent}
                    </span>
                  )}
                </div>
                {pipeline.description && (
                  <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5, marginBottom: 10, whiteSpace: "pre-wrap" }}>
                    {pipeline.description}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {pipeline.steps.map((s) => (
                    <div key={s.step} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--subtext0)" }}>
                      <span style={{ color: "var(--overlay0)", width: 28 }}>#{s.step}</span>
                      <code style={{ color: "var(--text)" }}>{s.agent}</code>
                      {s.phaseName && <span style={{ color: "var(--overlay0)" }}>· phase {s.phase} {s.phaseName}</span>}
                      {s.gate === "human" && <span style={{ marginLeft: "auto", fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "rgba(245,194,107,0.10)", color: "var(--peach)" }}>human gate</span>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Agents section */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
              Agents <span style={{ color: "var(--subtext0)", marginLeft: 4 }}>({agents.length})</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {agents.map((a) => {
                const isOpen = expanded === a.slug;
                const descShort = (a.metadata.description_short as string | undefined) ?? a.description.split("\n").find((l) => l.trim())?.slice(0, 200) ?? "";
                return (
                  <div
                    key={a.slug}
                    style={{
                      padding: "12px 14px", borderRadius: 9,
                      background: "var(--surface0)", border: "1px solid var(--surface1)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <code style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                        {a.slug}
                      </code>
                      <span style={{ fontSize: 11, color: "var(--subtext0)" }}>{a.name}</span>
                      {a.squad && (
                        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "var(--surface1)", color: "var(--overlay1)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          {a.squad}
                        </span>
                      )}
                      {a.version && (
                        <span style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>v{a.version}</span>
                      )}
                      <button
                        onClick={() => setExpanded(isOpen ? null : a.slug)}
                        style={{ marginLeft: "auto", ...studioBtnGhost, padding: "4px 10px", fontSize: 11 }}
                      >
                        {isOpen ? "Collapse" : "Persona"}
                      </button>
                    </div>
                    {descShort && (
                      <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 6, lineHeight: 1.5 }}>
                        {descShort}
                      </div>
                    )}
                    {a.tools.length > 0 && (
                      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {a.tools.map((t) => (
                          <code key={t} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "var(--surface1)", color: "var(--overlay1)", fontFamily: "var(--font-mono)" }}>
                            {t}
                          </code>
                        ))}
                      </div>
                    )}
                    {isOpen && a.description && (
                      <pre style={{
                        marginTop: 10, padding: "10px 12px", borderRadius: 6,
                        background: "var(--mantle)", border: "1px solid var(--surface1)",
                        fontSize: 10, color: "var(--subtext0)", lineHeight: 1.5,
                        whiteSpace: "pre-wrap", wordBreak: "break-word",
                        fontFamily: "var(--font-mono)",
                        maxHeight: 360, overflow: "auto",
                      }}>
                        {a.description}
                      </pre>
                    )}
                  </div>
                );
              })}
              {agents.length === 0 && (
                <div style={studioMuted}>
                  No PIP agents available in this deployment. Contact your platform administrator if the inception flow should be enabled.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────── PIP Settings — auto-apply + CLI/LLM config ───────────── */

const PIP_RE_AGENT_SLUGS = [
  "pip-scout",
  "pip-product-manager",
  "pip-architect",
  "pip-components-builder",
  "pip-composer",
] as const;

const PIP_CLI_OPTIONS    = ["claude-code", "codex", "gemini-cli", "aider", "plandex", "goose", "amp"];
const PIP_EFFORT_OPTIONS = ["", "low", "medium", "high", "max"] as const;

// Curated picker of popular models per CLI. Operators can still type a
// custom model — datalist is a SUGGESTION list, not a lock-down.
// Keep this short (5-8 entries per CLI) and current. When a CLI ships
// a notable new model, edit the list here.
const PIP_MODEL_OPTIONS_BY_CLI: Record<string, string[]> = {
  "claude-code": [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "claude-sonnet-4-5",
  ],
  "codex": [
    "gpt-5",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "o3",
    "o4-mini",
  ],
  "gemini-cli": [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-pro",
    "gemini-2.0-flash",
  ],
  "aider": [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "gpt-5",
    "gpt-5-mini",
    "deepseek-chat",
    "deepseek-reasoner",
  ],
  "plandex": [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "gpt-5",
    "gpt-4.1",
    "o4-mini",
  ],
  "goose": [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "gpt-5",
    "gpt-4.1",
  ],
  "amp": [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "gpt-5",
  ],
};

function modelOptionsFor(cli: string | undefined): string[] {
  if (!cli) {
    // No CLI picked → union of all options, deduped, alphabetical.
    return Array.from(new Set(Object.values(PIP_MODEL_OPTIONS_BY_CLI).flat())).sort();
  }
  return PIP_MODEL_OPTIONS_BY_CLI[cli] ?? [];
}

interface PipAgentOverride {
  cli?:      string;
  model?:    string;
  effort?:   "low" | "medium" | "high" | "max";
  authMode?: "oauth" | "api-key";
}

interface PipCliConfig {
  default_cli?:        string;
  authMode?:           "oauth" | "api-key";
  execution_backend?:  "local" | "supabase";
  default_model?:      string;
  default_effort?:     "low" | "medium" | "high" | "max";
  agent_overrides?:    Record<string, PipAgentOverride>;
}

function PipSettingsPane({ factoryId, canWrite }: { factoryId: string; canWrite: boolean }) {
  const [cliEnabled, setCliEnabled] = useState<boolean>(false);
  const [cliCfg, setCliCfg]   = useState<PipCliConfig>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not signed in");
        const res = await fetch(
          `/api/factory/pip/settings?factoryId=${encodeURIComponent(factoryId)}`,
          { headers: { Authorization: `Bearer ${session.access_token}` } },
        );
        const body = (await res.json().catch(() => ({}))) as {
          cli_config?: PipCliConfig | null; error?: string;
        };
        if (!res.ok) throw new Error(body.error ?? `Load failed (${res.status})`);
        if (body.cli_config) {
          setCliEnabled(true);
          setCliCfg(body.cli_config);
        } else {
          setCliEnabled(false);
          setCliCfg({});
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [factoryId]);

  async function persist(patch: { cli_config?: PipCliConfig | null }) {
    if (!canWrite) return;
    setSaving(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch(
        `/api/factory/pip/settings?factoryId=${encodeURIComponent(factoryId)}`,
        {
          method:  "POST",
          headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
          body:    JSON.stringify(patch),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; cli_config?: PipCliConfig | null; error?: string;
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Save failed (${res.status})`);
      if (body.cli_config !== undefined) {
        setCliEnabled(!!body.cli_config);
        setCliCfg(body.cli_config ?? {});
      }
      setSavedAt(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function updateCliCfg(patch: Partial<PipCliConfig>) {
    const next: PipCliConfig = { ...cliCfg, ...patch };
    setCliCfg(next);
    void persist({ cli_config: next });
  }

  function updateAgentOverride(slug: string, patch: Partial<PipAgentOverride>) {
    const prevOverrides = cliCfg.agent_overrides ?? {};
    const prevForSlug   = prevOverrides[slug] ?? {};
    const merged: PipAgentOverride = { ...prevForSlug, ...patch };
    // Drop empty fields so we don't persist `{ cli: "", model: "" }`.
    const cleaned: PipAgentOverride = {};
    if (merged.cli)      cleaned.cli = merged.cli;
    if (merged.model)    cleaned.model = merged.model;
    if (merged.effort)   cleaned.effort = merged.effort;
    if (merged.authMode) cleaned.authMode = merged.authMode;
    const nextOverrides = { ...prevOverrides };
    if (Object.keys(cleaned).length === 0) delete nextOverrides[slug];
    else                                   nextOverrides[slug] = cleaned;
    const next: PipCliConfig = { ...cliCfg, agent_overrides: nextOverrides };
    setCliCfg(next);
    void persist({ cli_config: next });
  }

  function clearCliConfig() {
    if (!confirm("Clear PIP CLI/LLM config? Inception will fall back to inheriting cli_agents from a recent project on this factory.")) return;
    setCliCfg({});
    setCliEnabled(false);
    void persist({ cli_config: null });
  }

  return (
    <div style={studioSectionContainer}>
      <StudioSectionHeader
        title="Settings"
        subtitle={
          <>
            CLI/LLM defaults for the RE agents during inception. Auto-apply is set per-dispatch in <strong>Run Inception</strong> — there is no factory-level default.
          </>
        }
      />

      {error && (
        <div style={studioErrBanner}>
          <AlertCircle size={12} style={{ marginRight: 6, verticalAlign: "middle" }} /> {error}
        </div>
      )}

      {loading ? (
        <div style={studioMuted}>Loading settings…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* CLI / LLM config */}
          <div style={{
            padding: "14px 16px", borderRadius: 9,
            background: "var(--surface0)", border: "1px solid var(--surface1)",
            display: "flex", flexDirection: "column", gap: 12,
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
                  CLI &amp; LLM
                  {cliEnabled && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(20,99,255,0.10)", color: "var(--blue)", textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: "var(--font-mono)" }}>OVERRIDE</span>}
                </div>
                <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5 }}>
                  Pick the CLI + model the 5 RE agents use during inception. Per-agent rows let you tune model/effort for individual roles (e.g. <code style={{ fontFamily: "var(--font-mono)" }}>pip-product-manager</code> on opus, <code style={{ fontFamily: "var(--font-mono)" }}>pip-scout</code> on sonnet).
                  <br /><br />
                  When OVERRIDE is off, inception inherits <code style={{ fontFamily: "var(--font-mono)" }}>cli_agents</code> from any recent project on this factory (fallback) — fine for a homogeneous setup.
                </div>
              </div>
              {cliEnabled && canWrite && (
                <button
                  onClick={clearCliConfig}
                  disabled={saving}
                  title="Clear the override and fall back to project inheritance"
                  style={{ ...studioBtnGhost, padding: "5px 10px", fontSize: 11, color: "var(--red)", borderColor: "rgba(228,75,95,0.3)" }}
                >
                  Clear
                </button>
              )}
              {!cliEnabled && canWrite && (
                <button
                  onClick={() => updateCliCfg({ default_cli: "claude-code", authMode: "oauth", execution_backend: "local" })}
                  disabled={saving}
                  style={{ ...studioBtnPrimary, padding: "5px 12px", fontSize: 11 }}
                >
                  Enable
                </button>
              )}
            </div>

            {cliEnabled && (
              <>
                {/* Defaults row */}
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto 1fr", gap: "8px 12px", alignItems: "center", fontSize: 11 }}>
                  <span style={{ color: "var(--overlay0)" }}>CLI</span>
                  <select
                    value={cliCfg.default_cli ?? ""}
                    disabled={!canWrite || saving}
                    onChange={(e) => updateCliCfg({ default_cli: e.target.value || undefined })}
                    style={{ ...studioInputStyle, padding: "5px 8px", fontSize: 11 }}
                  >
                    <option value="">— pick —</option>
                    {PIP_CLI_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>

                  <span style={{ color: "var(--overlay0)" }}>Auth</span>
                  <select
                    value={cliCfg.authMode ?? ""}
                    disabled={!canWrite || saving}
                    onChange={(e) => updateCliCfg({ authMode: (e.target.value || undefined) as "oauth" | "api-key" | undefined })}
                    style={{ ...studioInputStyle, padding: "5px 8px", fontSize: 11 }}
                  >
                    <option value="">— pick —</option>
                    <option value="oauth">oauth</option>
                    <option value="api-key">api-key</option>
                  </select>

                  <span style={{ color: "var(--overlay0)" }}>Default model</span>
                  <input
                    type="text"
                    list="pip-default-model-options"
                    placeholder="e.g. claude-opus-4-7"
                    value={cliCfg.default_model ?? ""}
                    disabled={!canWrite || saving}
                    onChange={(e) => updateCliCfg({ default_model: e.target.value.trim() || undefined })}
                    style={{ ...studioInputStyle, padding: "5px 8px", fontSize: 11 }}
                  />
                  <datalist id="pip-default-model-options">
                    {modelOptionsFor(cliCfg.default_cli).map((m) => <option key={m} value={m} />)}
                  </datalist>

                  <span style={{ color: "var(--overlay0)" }}>Effort</span>
                  <select
                    value={cliCfg.default_effort ?? ""}
                    disabled={!canWrite || saving}
                    onChange={(e) => updateCliCfg({ default_effort: (e.target.value || undefined) as "low" | "medium" | "high" | "max" | undefined })}
                    style={{ ...studioInputStyle, padding: "5px 8px", fontSize: 11 }}
                  >
                    {PIP_EFFORT_OPTIONS.map((o) => <option key={o} value={o}>{o || "—"}</option>)}
                  </select>

                  <span style={{ color: "var(--overlay0)" }}>Storage</span>
                  <select
                    value={cliCfg.execution_backend ?? ""}
                    disabled={!canWrite || saving}
                    onChange={(e) => updateCliCfg({ execution_backend: (e.target.value || undefined) as "local" | "supabase" | undefined })}
                    style={{ ...studioInputStyle, padding: "5px 8px", fontSize: 11 }}
                  >
                    <option value="">— pick —</option>
                    <option value="local">local</option>
                    <option value="supabase">supabase</option>
                  </select>
                </div>

                {/* Per-agent overrides */}
                <div style={{ borderTop: "1px solid var(--surface1)", paddingTop: 10 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                    Per-agent overrides
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1.5fr 0.8fr", gap: "6px 10px", alignItems: "center", fontSize: 11 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Agent</div>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>CLI</div>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Model</div>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Effort</div>
                    {PIP_RE_AGENT_SLUGS.map((slug) => {
                      const ov = cliCfg.agent_overrides?.[slug] ?? {};
                      return (
                        <React.Fragment key={slug}>
                          <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{slug}</code>
                          <select
                            value={ov.cli ?? ""}
                            disabled={!canWrite || saving}
                            onChange={(e) => updateAgentOverride(slug, { cli: e.target.value || undefined })}
                            style={{ ...studioInputStyle, padding: "4px 6px", fontSize: 10 }}
                          >
                            <option value="">{cliCfg.default_cli ?? "default"}</option>
                            {PIP_CLI_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                          <input
                            type="text"
                            list={`pip-agent-model-options-${slug}`}
                            placeholder={cliCfg.default_model ?? "default"}
                            value={ov.model ?? ""}
                            disabled={!canWrite || saving}
                            onChange={(e) => updateAgentOverride(slug, { model: e.target.value.trim() || undefined })}
                            style={{ ...studioInputStyle, padding: "4px 6px", fontSize: 10 }}
                          />
                          <select
                            value={ov.effort ?? ""}
                            disabled={!canWrite || saving}
                            onChange={(e) => updateAgentOverride(slug, { effort: (e.target.value || undefined) as "low" | "medium" | "high" | "max" | undefined })}
                            style={{ ...studioInputStyle, padding: "4px 6px", fontSize: 10 }}
                          >
                            {PIP_EFFORT_OPTIONS.map((o) => <option key={o} value={o}>{o || (cliCfg.default_effort ?? "—")}</option>)}
                          </select>
                        </React.Fragment>
                      );
                    })}
                  </div>
                  {/* Per-agent model datalists — rendered outside the
                      grid so they don't get auto-placed as grid items
                      (display:none should hide them, but some browsers
                      still claim a track). */}
                  {PIP_RE_AGENT_SLUGS.map((slug) => {
                    const ov = cliCfg.agent_overrides?.[slug] ?? {};
                    return (
                      <datalist key={`dl-${slug}`} id={`pip-agent-model-options-${slug}`}>
                        {modelOptionsFor(ov.cli ?? cliCfg.default_cli).map((m) => <option key={m} value={m} />)}
                      </datalist>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {savedAt && (
            <div style={{ fontSize: 10, color: "var(--overlay0)" }}>
              Saved {savedAt.toLocaleTimeString()}
            </div>
          )}

          {!canWrite && (
            <div style={studioMuted}>
              <em>Read-only — your role can&apos;t change feature settings.</em>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
