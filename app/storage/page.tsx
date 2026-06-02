"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import IntegrationsShell from "../../components/IntegrationsShell";
import { useAuth } from "../../lib/auth-context";
import { brand } from "@/lib/brand";
import {
  CheckCircle2, AlertCircle, Eye, EyeOff, ExternalLink, Plus, Loader2,
  X, Shield, Zap, HardDrive, FolderOpen, Trash2, ChevronDown, ChevronUp,
  Database,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BackendSummary {
  name:       string;
  type:       "supabase" | "local" | string;
  url?:       string;
  basePath?:  string;
  verified:   boolean;
  verifiedAt?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function badge(text: string, color: string) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99,
      background: `${color}18`, color, textTransform: "uppercase" as const,
      letterSpacing: "0.04em",
    }}>
      {text}
    </span>
  );
}

// ─── BackendCard ──────────────────────────────────────────────────────────────

function BackendCard({
  backend,
  session,
  onDeleted,
  onVerified,
}: {
  backend:    BackendSummary;
  session:    { access_token: string } | null;
  onDeleted:  (name: string) => void;
  onVerified: (name: string) => void;
}) {
  const [testing,    setTesting]    = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; note?: string; error?: string } | null>(null);
  const [deleting,   setDeleting]   = useState(false);
  const [confirm,    setConfirm]    = useState(false);

  async function handleTest() {
    if (!session) return;
    setTesting(true);
    setTestResult(null);
    try {
      // Use Mode B — server fetches stored credentials by name
      const res = await fetch("/api/settings/storage/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ name: backend.name }),
      });
      const data = await res.json() as { ok?: boolean; note?: string; error?: string };
      setTestResult({ ok: !!data.ok, note: data.note, error: data.error });
      if (data.ok) onVerified(backend.name);
    } catch (e: unknown) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally { setTesting(false); }
  }

  async function handleDelete() {
    if (!session) return;
    setDeleting(true);
    try {
      await fetch(`/api/settings/storage?name=${encodeURIComponent(backend.name)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      onDeleted(backend.name);
    } catch {
      setDeleting(false);
      setConfirm(false);
    }
  }

  const typeColor = backend.type === "supabase" ? "var(--teal)" : backend.type === "github" ? "var(--mauve)" : "var(--sapphire)";
  const typeLabel = backend.type === "supabase" ? "supabase" : backend.type === "github" ? "github" : "user space";

  return (
    <div style={{
      background: "var(--mantle)",
      border: backend.verified ? "1px solid rgba(28,191,107,0.3)" : "1px solid var(--surface1)",
      borderRadius: 12, overflow: "hidden", marginBottom: 8,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
        <div style={{
          width: 34, height: 34, borderRadius: 8, flexShrink: 0,
          background: `${typeColor}18`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {backend.type === "supabase"
            ? <Database size={16} color={typeColor} />
            : backend.type === "github"
            ? <span style={{ fontSize: 16 }}>🐙</span>
            : <FolderOpen size={16} color={typeColor} />}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" as const }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{backend.name}</span>
            {badge(typeLabel, typeColor)}
            {backend.verified
              ? <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11, color: "var(--green)", fontWeight: 600 }}>
                  <CheckCircle2 size={11} /> Verified
                </span>
              : <span style={{ fontSize: 11, color: "var(--overlay0)" }}>Not verified</span>}
          </div>
          <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
            {backend.type === "supabase" && backend.url}
            {backend.type === "github"  && "GitHub repository access"}
            {backend.type === "local"   && backend.basePath}
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {backend.type !== "local" && (
            <button onClick={handleTest} disabled={testing}
              title="Test connection"
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 7, border: "1px solid var(--surface2)", background: "var(--surface0)", color: "var(--subtext1)", fontSize: 11, fontWeight: 600, cursor: testing ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)", opacity: testing ? 0.6 : 1 }}>
              {testing ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <Zap size={11} />}
              {testing ? "Testing…" : "Test"}
            </button>
          )}
          {confirm ? (
            <>
              <button onClick={handleDelete} disabled={deleting}
                style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 7, border: "1px solid rgba(237,67,55,0.4)", background: "rgba(237,67,55,0.1)", color: "var(--red)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                {deleting ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={11} />}
                Confirm
              </button>
              <button onClick={() => setConfirm(false)}
                style={{ padding: "5px 8px", borderRadius: 7, border: "1px solid var(--surface2)", background: "var(--surface0)", color: "var(--overlay1)", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                Cancel
              </button>
            </>
          ) : (
            <button onClick={() => setConfirm(true)}
              title="Remove backend"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 7, border: "1px solid var(--surface2)", background: "var(--surface0)", color: "var(--overlay1)", cursor: "pointer" }}>
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Test result */}
      {testResult && (
        <div style={{
          margin: "0 16px 12px", padding: "8px 12px", borderRadius: 8, fontSize: 11, lineHeight: 1.6,
          background: testResult.ok ? "rgba(28,191,107,0.08)" : "rgba(237,67,55,0.08)",
          border: `1px solid ${testResult.ok ? "rgba(28,191,107,0.3)" : "rgba(237,67,55,0.3)"}`,
          color: testResult.ok ? "var(--green)" : "var(--red)",
          display: "flex", alignItems: "flex-start", gap: 7,
        }}>
          {testResult.ok ? <CheckCircle2 size={12} style={{ flexShrink: 0, marginTop: 1 }} /> : <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />}
          <span style={{ flex: 1 }}>{testResult.note ?? testResult.error}</span>
          <button onClick={() => setTestResult(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 0, display: "flex", flexShrink: 0 }}>
            <X size={11} />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── AddBackendForm ────────────────────────────────────────────────────────────

function AddBackendForm({
  session,
  tenantId,
  onAdded,
}: {
  session: { access_token: string } | null;
  tenantId: string | null;
  onAdded: (b: BackendSummary) => void;
}) {
  const [open,      setOpen]      = useState(false);
  const [type,      setType]      = useState<"supabase" | "local" | "github">("supabase");
  const [name,      setName]      = useState("");
  const [url,       setUrl]       = useState("");
  const [key,       setKey]       = useState("");
  const [showKey,   setShowKey]   = useState(false);
  const [basePath,  setBasePath]  = useState("");
  const [ghToken,   setGhToken]   = useState("");
  const [ghOwner,   setGhOwner]   = useState("");
  const [showGhToken, setShowGhToken] = useState(false);
  const [testing,   setTesting]   = useState(false);
  const [tested,    setTested]    = useState<{ ok: boolean; note?: string; error?: string } | null>(null);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  function reset() {
    setName(""); setUrl(""); setKey(""); setBasePath(""); setGhToken(""); setGhOwner("");
    setTested(null); setError(null); setOpen(false);
  }

  const canTest = type === "supabase"
    ? url.trim().startsWith("https://") && key.trim().length > 20
    : type === "github"
    ? ghToken.trim().length > 5 && ghOwner.trim().length > 0
    : false; // User Space: no remote test — validated when local worker connects

  const canSave = name.trim().length > 0 && (
    type === "supabase" ? url.trim().startsWith("https://") && key.trim().length > 20
    : type === "github" ? ghToken.trim().length > 5 && ghOwner.trim().length > 0
    : basePath.trim().length > 2
  );

  async function handleTest() {
    if (!session || !canTest) return;
    setTesting(true); setTested(null); setError(null);
    try {
      if (type === "github") {
        // GitHub uses the integrations test endpoint
        const res = await fetch("/api/settings/integrations/test", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ tenantId: tenantId, serviceId: "github" }),
        });
        const data = await res.json() as { ok?: boolean; steps?: { name: string; ok: boolean; detail: string }[] };
        const note = data.steps?.map((s) => `${s.ok ? "✓" : "✗"} ${s.name}: ${s.detail}`).join("\n");
        setTested({ ok: !!data.ok, note: note ?? (data.ok ? "Connection successful" : "Connection failed") });
      } else {
        const payload: Record<string, string> = { type, name: name.trim() || "test" };
        if (type === "supabase") { payload.url = url.trim(); payload.key = key.trim(); }
        else { payload.basePath = basePath.trim(); }

        const res = await fetch("/api/settings/storage/test", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify(payload),
        });
        const data = await res.json() as { ok?: boolean; note?: string; error?: string };
        setTested({ ok: !!data.ok, note: data.note, error: data.error });
      }
    } catch (e: unknown) {
      setTested({ ok: false, error: (e as Error).message });
    } finally { setTesting(false); }
  }

  async function handleSave() {
    if (!session || !canSave) return;
    setSaving(true); setError(null);
    try {
      if (type === "github") {
        // 1. Save credentials via integrations API (service_id = "github")
        const res = await fetch("/api/settings/integrations", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            tenantId,
            serviceId: "github",
            keys: { GITHUB_TOKEN: ghToken.trim(), GITHUB_OWNER: ghOwner.trim() },
          }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? "Save failed");
        }
        // 2. Also save as storage backend so it appears in the backends list
        const storageRes = await fetch("/api/settings/storage", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            type: "github",
            name: name.trim(),
            verified: tested?.ok ?? false,
            verifiedAt: tested?.ok ? new Date().toISOString() : undefined,
          }),
        });
        if (!storageRes.ok) {
          const b = await storageRes.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? "Save failed");
        }
        onAdded({
          name: name.trim(),
          type: "github",
          verified: tested?.ok ?? false,
          verifiedAt: tested?.ok ? new Date().toISOString() : undefined,
        });
      } else {
        const isLocal = type === "local";
        const isVerified = isLocal || (tested?.ok ?? false);
        const res = await fetch("/api/settings/storage", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            type,
            name: name.trim(),
            url: type === "supabase" ? url.trim() : undefined,
            key: type === "supabase" ? key.trim() : undefined,
            basePath: isLocal ? basePath.trim() : undefined,
            verified: isVerified,
            verifiedAt: isVerified ? new Date().toISOString() : undefined,
          }),
        });
        if (!res.ok) {
          const b = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(b.error ?? "Save failed");
        }
        onAdded({
          name: name.trim(),
          type,
          url: type === "supabase" ? url.trim() : undefined,
          basePath: isLocal ? basePath.trim() : undefined,
          verified: isVerified,
          verifiedAt: isVerified ? new Date().toISOString() : undefined,
        });
      }
      reset();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally { setSaving(false); }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "7px 11px", background: "var(--surface0)",
    border: "1px solid var(--surface1)", borderRadius: 7, color: "var(--text)",
    fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext1)", marginBottom: 4,
  };

  return (
    <div style={{ marginTop: 12 }}>
      {!open ? (
        <button onClick={() => setOpen(true)}
          style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", borderRadius: 9, border: "1px dashed var(--surface2)", background: "transparent", color: "var(--subtext0)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", width: "100%" }}>
          <Plus size={14} /> Add storage backend
        </button>
      ) : (
        <div style={{ background: "var(--mantle)", border: "1px solid var(--surface1)", borderRadius: 12, overflow: "hidden" }}>
          {/* Form header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--surface0)" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>New storage backend</span>
            <button onClick={reset} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay1)", padding: 2, display: "flex" }}>
              <X size={14} />
            </button>
          </div>

          <div style={{ padding: "16px" }}>
            {/* Type selector */}
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Type</label>
              <div style={{ display: "flex", gap: 8 }}>
                {(["supabase", "github", "local"] as const).map((t) => (
                  <button key={t} onClick={() => { setType(t); setTested(null); }}
                    style={{
                      flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                      cursor: "pointer", fontFamily: "var(--font-sans)",
                      border: type === t ? "1px solid var(--blue)" : "1px solid var(--surface2)",
                      background: type === t ? "rgba(30,102,245,0.12)" : "var(--surface0)",
                      color: type === t ? "var(--blue)" : "var(--subtext1)",
                    }}>
                    {t === "supabase" ? "Supabase" : t === "github" ? "GitHub" : "User Space"}
                  </button>
                ))}
              </div>
            </div>

            {/* Name */}
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Backend name <span style={{ fontWeight: 400, color: "var(--overlay0)" }}>— used to identify this backend</span></label>
              <input type="text" placeholder={type === "github" ? 'e.g. "github", "gh-org"' : type === "local" ? 'e.g. "local", "my-workspace"' : 'e.g. "default", "prod-storage"'}
                value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
            </div>

            {type === "supabase" && (<>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>Supabase Project URL</label>
                <input type="url" placeholder="https://<ref>.supabase.co"
                  value={url} onChange={(e) => { setUrl(e.target.value); setTested(null); }} style={inputStyle} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>
                  Service Role / Secret Key
                  <span style={{ fontWeight: 400, color: "var(--overlay0)", marginLeft: 8 }}>Dashboard → Settings → API Keys → Legacy</span>
                </label>
                <div style={{ position: "relative" }}>
                  <input type={showKey ? "text" : "password"} placeholder="sb_secret_…"
                    value={key} onChange={(e) => { setKey(e.target.value); setTested(null); }}
                    style={{ ...inputStyle, paddingRight: 36 }} />
                  <button type="button" onClick={() => setShowKey((s) => !s)}
                    style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "flex" }}>
                    {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>
              </div>
            </>)}

            {type === "github" && (<>
              <div style={{ marginBottom: 12 }}>
                <label style={labelStyle}>
                  Personal access token
                  <span style={{ fontWeight: 400, color: "var(--overlay0)", marginLeft: 8 }}>Scope: repo (full control)</span>
                </label>
                <div style={{ position: "relative" }}>
                  <input type={showGhToken ? "text" : "password"} placeholder="ghp_…"
                    value={ghToken} onChange={(e) => { setGhToken(e.target.value); setTested(null); }}
                    autoComplete="off"
                    style={{ ...inputStyle, paddingRight: 36 }} />
                  <button type="button" onClick={() => setShowGhToken((s) => !s)}
                    style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "flex" }}>
                    {showGhToken ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>
                  Owner
                  <span style={{ fontWeight: 400, color: "var(--overlay0)", marginLeft: 8 }}>Username or org name — not the full URL</span>
                </label>
                <input type="text" placeholder="tirsafactory"
                  value={ghOwner} onChange={(e) => { setGhOwner(e.target.value); setTested(null); }}
                  autoComplete="off"
                  style={inputStyle} />
              </div>
            </>)}

            {type === "local" && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Default base path <span style={{ fontWeight: 400, color: "var(--overlay0)" }}>— absolute path on your local machine (can be overridden per project)</span></label>
                <input type="text" placeholder="C:\Users\me\tirsa-workspace"
                  value={basePath} onChange={(e) => { setBasePath(e.target.value); setTested(null); }} style={inputStyle} />
              </div>
            )}

            {/* Test result */}
            {tested && (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: 7, padding: "8px 11px",
                borderRadius: 8, marginBottom: 12, fontSize: 11, lineHeight: 1.6,
                background: tested.ok ? "rgba(28,191,107,0.08)" : "rgba(237,67,55,0.08)",
                border: `1px solid ${tested.ok ? "rgba(28,191,107,0.3)" : "rgba(237,67,55,0.3)"}`,
                color: tested.ok ? "var(--green)" : "var(--red)",
              }}>
                {tested.ok ? <CheckCircle2 size={12} style={{ flexShrink: 0, marginTop: 1 }} /> : <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />}
                <span>{tested.note ?? tested.error}</span>
              </div>
            )}

            {error && (
              <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 11px", borderRadius: 8, marginBottom: 12, background: "rgba(237,67,55,0.1)", border: "1px solid rgba(237,67,55,0.2)", color: "var(--red)", fontSize: 11 }}>
                <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
              </div>
            )}

            {/* User Space note */}
            {type === "local" && (
              <div style={{ marginBottom: 14, padding: "8px 12px", borderRadius: 8, background: "rgba(137,180,250,0.08)", border: "1px solid rgba(137,180,250,0.2)", fontSize: 11, color: "var(--subtext0)", lineHeight: 1.6 }}>
                Path will be validated when the local worker connects via <code style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>tirsa-factory dev</code>.
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", gap: 8 }}>
                {type === "supabase" && (
                  <a href="https://supabase.com/dashboard/project/_/settings/api-keys/legacy" target="_blank" rel="noreferrer"
                    style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--blue)", textDecoration: "none" }}>
                    <ExternalLink size={10} /> API Keys
                  </a>
                )}
                {type === "github" && (<>
                  <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer"
                    style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--blue)", textDecoration: "none" }}>
                    <ExternalLink size={10} /> Tokens
                  </a>
                  <a href="https://github.com/settings/tokens/new" target="_blank" rel="noreferrer"
                    style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--blue)", textDecoration: "none" }}>
                    <ExternalLink size={10} /> New token
                  </a>
                </>)}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {type !== "local" && (
                  <button onClick={handleTest} disabled={testing || !canTest}
                    style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 12px", borderRadius: 8, border: "1px solid var(--surface2)", background: "var(--surface0)", color: "var(--subtext1)", fontSize: 12, fontWeight: 600, cursor: canTest && !testing ? "pointer" : "not-allowed", fontFamily: "var(--font-sans)", opacity: testing || !canTest ? 0.6 : 1 }}>
                    {testing ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Zap size={12} />}
                    {testing ? "Testing…" : "Test"}
                  </button>
                )}
                <button onClick={handleSave} disabled={saving || !canSave}
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 16px", borderRadius: 8, border: "none", background: "#1463ff", color: "#fff", fontSize: 12, fontWeight: 600, cursor: canSave && !saving ? "pointer" : "not-allowed", fontFamily: "var(--font-sans)", opacity: saving || !canSave ? 0.6 : 1 }}>
                  {saving ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Plus size={12} />}
                  {saving ? "Saving…" : "Add backend"}
                </button>
              </div>
            </div>

            {/* Security note */}
            <div style={{ marginTop: 14, padding: "7px 11px", borderRadius: 8, background: "rgba(107,122,158,0.08)", border: "1px solid var(--surface1)", fontSize: 11, color: "var(--overlay1)", lineHeight: 1.6 }}>
              <Shield size={10} style={{ display: "inline", verticalAlign: "middle", marginRight: 5 }} />
              {type === "supabase"
                ? <>Credentials are stored encrypted server-side and never returned to the browser. A private bucket named <code style={{ fontFamily: "var(--font-mono)" }}>tirsa</code> will be created automatically.</>
                : type === "github"
                ? <>Token is stored encrypted server-side. Requires <code style={{ fontFamily: "var(--font-mono)" }}>repo</code> scope for branch creation and pull requests.</>
                : <>This path is the default working directory on your machine. Each project can override it in Studio settings.</>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function StoragePage() {
  const router = useRouter();
  const { session, tenantId, loading: authLoading } = useAuth();
  const [backends,  setBackends]  = useState<BackendSummary[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [infoOpen,  setInfoOpen]  = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  useEffect(() => {
    if (!session?.access_token) return;
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetch("/api/settings/storage", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (res) => {
        if (res.ok) {
          const body = await res.json() as { backends: BackendSummary[] };
          setBackends(body.backends ?? []);
        }
      })
      .finally(() => setLoading(false));
  }, [session]);

  const handleAdded = useCallback((b: BackendSummary) => {
    setBackends((prev) => {
      const existing = prev.findIndex((x) => x.name === b.name);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = b;
        return next;
      }
      return [...prev, b];
    });
  }, []);

  const handleDeleted = useCallback((name: string) => {
    setBackends((prev) => prev.filter((b) => b.name !== name));
  }, []);

  const handleVerified = useCallback((name: string) => {
    setBackends((prev) => prev.map((b) =>
      b.name === name ? { ...b, verified: true, verifiedAt: new Date().toISOString() } : b,
    ));
  }, []);

  const hasConfigured = backends.length > 0;
  const hasVerified   = backends.some((b) => b.verified);

  return (
    <IntegrationsShell
      active="storage"
      title="Storage"
      description={
        <>
          Configure where {brand.name} stores sprint artifacts — your own Supabase bucket or a local directory on your machine.
          At least one verified backend is required to run sprints.
        </>
      }
      maxWidth={680}
    >

          {/* Status banner */}
          {!loading && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 8, padding: "10px 14px", borderRadius: 10, marginBottom: 20, fontSize: 12,
              background: hasVerified ? "rgba(28,191,107,0.07)" : hasConfigured ? "rgba(254,188,43,0.07)" : "rgba(237,67,55,0.07)",
              border: `1px solid ${hasVerified ? "rgba(28,191,107,0.2)" : hasConfigured ? "rgba(254,188,43,0.2)" : "rgba(237,67,55,0.2)"}`,
              color: hasVerified ? "var(--green)" : hasConfigured ? "var(--yellow)" : "var(--red)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                {hasVerified
                  ? <CheckCircle2 size={13} />
                  : hasConfigured
                    ? <AlertCircle size={13} />
                    : <AlertCircle size={13} />}
                {hasVerified
                  ? `${backends.filter((b) => b.verified).length} verified backend${backends.filter((b) => b.verified).length !== 1 ? "s" : ""} configured.`
                  : hasConfigured
                    ? "Backend added but not yet verified — click Test to verify."
                    : "No storage backend configured. Add at least one to run sprints."}
              </div>
              <button onClick={() => setInfoOpen((o) => !o)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "currentColor", padding: 0, display: "flex", opacity: 0.7 }}>
                {infoOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
          )}

          {/* Info panel */}
          {infoOpen && (
            <div style={{ padding: "12px 16px", borderRadius: 10, marginBottom: 20, background: "var(--mantle)", border: "1px solid var(--surface1)", fontSize: 12, color: "var(--subtext0)", lineHeight: 1.8 }}>
              <strong style={{ color: "var(--text)" }}>How storage works</strong>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                <li><strong>Supabase:</strong> Artifacts are stored in a private bucket named <code>tirsa</code> inside your own Supabase project.</li>
                <li><strong>User Space:</strong> Artifacts are written to a directory on your local machine when using Orchestration Mode "Local".</li>
                <li>Each backend gets a <code>.tirsa-factory</code> marker file written on first successful test.</li>
                <li>Artifacts are stored at <code>{"<project>/sprint-<N>/<file>"}</code> so each sprint is isolated.</li>
                <li>When configuring a project, you choose which backend it uses. Different sprints can use different backends.</li>
              </ul>
            </div>
          )}

          {/* Backend list */}
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--subtext0)", fontSize: 14 }}>
              <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> Loading…
            </div>
          ) : (
            <>
              {backends.length === 0 && (
                <div style={{ textAlign: "center" as const, padding: "32px 0", color: "var(--subtext0)", fontSize: 13 }}>
                  <HardDrive size={28} style={{ marginBottom: 10, opacity: 0.4, display: "block", margin: "0 auto 10px" }} />
                  No backends configured yet.
                </div>
              )}

              {backends.map((b) => (
                <BackendCard
                  key={b.name}
                  backend={b}
                  session={session}
                  onDeleted={handleDeleted}
                  onVerified={handleVerified}
                />
              ))}

              <AddBackendForm session={session} tenantId={tenantId} onAdded={handleAdded} />
            </>
          )}


          {/* ─── Bottom note ───────────────────────────────────────────── */}
          <div style={{ marginTop: 32, padding: "10px 14px", borderRadius: 10, background: "rgba(107,122,158,0.08)", border: "1px solid var(--surface1)", fontSize: 12, color: "var(--overlay1)", lineHeight: 1.7 }}>
            <Shield size={11} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />
            The local filesystem path configured here is the default for new projects. Each project can override it in Studio settings.
          </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </IntegrationsShell>
  );
}
