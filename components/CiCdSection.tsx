"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Loader2, Copy, Check, RefreshCw, Terminal, CheckCircle2, Trash2, Plus, Factory as FactoryIcon, Building2, AlertCircle,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";

/* ─── CopyField ─────────────────────────────────────────────────────────────── */

export function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ flex: 1, padding: "9px 12px", borderRadius: 8, background: "var(--surface0)", border: "1px solid var(--surface1)", fontSize: 13, color: "var(--text)", fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)", userSelect: "all" }}>{value}</span>
      <button
        onClick={() => { navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); }}
        title="Copy"
        style={{ padding: "9px 10px", borderRadius: 8, border: "1px solid var(--surface1)", background: "var(--surface0)", cursor: "pointer", color: copied ? "var(--green)" : "var(--overlay0)", display: "flex", alignItems: "center", flexShrink: 0 }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/* ─── Types ─────────────────────────────────────────────────────────────────── */

interface WorkspaceInfo {
  tenant:    { id: string; name: string; slug: string };
  factories: { id: string; name: string; slug: string }[];
}

interface ApiKey {
  id:           string;
  preview:      string;
  factory_id:   string | null;
  factory_name: string | null;
  name:         string | null;
  created_at:   string;
}

type Scope = "tenant" | string;  // "tenant" = tenant-wide; otherwise factory id

/* ─── CiCdSection ───────────────────────────────────────────────────────────── */

export function CiCdSection({ tenantId }: { tenantId: string }) {
  const { session } = useAuth();
  const [ws,     setWs]     = useState<WorkspaceInfo | null>(null);
  const [keys,   setKeys]   = useState<ApiKey[]>([]);
  const [newKey, setNewKey] = useState<{ raw: string; scope: Scope } | null>(null);
  const [generating, setGenerating] = useState<Scope | null>(null);
  const [deleting,   setDeleting]   = useState<string | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [createScope, setCreateScope] = useState<Scope>("tenant");
  const [selectedFactorySlug, setSelectedFactorySlug] = useState<string>("");  // for the .env preview snippet

  const reload = useCallback(async () => {
    if (!session) return;
    const token = session.access_token;
    const [wsRes, keysRes] = await Promise.all([
      fetch(`/api/settings/workspace?tenantId=${tenantId}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`/api/settings/apikey?tenantId=${tenantId}`,    { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    if (wsRes.ok)   { const b = await wsRes.json() as WorkspaceInfo; setWs(b); if (b.factories[0]) setSelectedFactorySlug((s) => s || b.factories[0]!.slug); }
    if (keysRes.ok) { const b = await keysRes.json() as { keys: ApiKey[] }; setKeys(b.keys); }
  }, [tenantId, session]);

  useEffect(() => { reload(); }, [reload]);

  async function generateKey(scope: Scope) {
    if (!session) return;
    setGenerating(scope); setError(null);
    try {
      const res = await fetch("/api/settings/apikey", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantId,
          factoryId: scope === "tenant" ? null : scope,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      const b = await res.json() as { key: string };
      setNewKey({ raw: b.key, scope });
      await reload();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setGenerating(null);
    }
  }

  async function revoke(id: string) {
    if (!session) return;
    if (!confirm("Revoke this API key? Anything using it will stop working immediately.")) return;
    setDeleting(id); setError(null);
    try {
      const res = await fetch(`/api/settings/apikey?id=${id}&tenantId=${tenantId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      if (newKey && keys.find((k) => k.id === id)?.factory_id === (newKey.scope === "tenant" ? null : newKey.scope)) {
        setNewKey(null);
      }
      await reload();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setDeleting(null);
    }
  }

  if (!ws) return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--subtext0)", fontSize: 14 }}>
      <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> Loading…
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  const tenantSlug  = ws.tenant.slug;
  const factorySlug = selectedFactorySlug || ws.factories[0]?.slug || "";
  const envSnippet  = [
    `TWINPILOT_TENANT=${tenantSlug}`,
    `TWINPILOT_FACTORY=${factorySlug}`,
    `TWINPILOT_API_KEY=${newKey?.raw ?? "<your-api-key>"}`,
  ].join("\n");

  /* Determine if user already has a key for the chosen scope */
  const existingKeyForScope = keys.find((k) => (createScope === "tenant" ? k.factory_id === null : k.factory_id === createScope));

  return (
    <div>
      <p style={{ fontSize: 13, color: "var(--subtext0)", marginBottom: 20, lineHeight: 1.6 }}>
        Generate API keys for non-interactive use — CI pipelines, GitHub Actions secrets, any context that calls the {brand.name} API.
        Scope each key to a specific factory to limit its blast radius.
      </p>

      {/* ── Keys list ── */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--subtext1)" }}>Active keys</label>
          <span style={{ fontSize: 11, color: "var(--overlay0)" }}>{keys.length} total</span>
        </div>

        {keys.length === 0 ? (
          <div style={{ padding: "12px 14px", borderRadius: 8, background: "var(--surface0)", border: "1px solid var(--surface1)", fontSize: 13, color: "var(--overlay0)" }}>
            No keys yet. Generate one below.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {keys.map((k) => (
              <div key={k.id} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", borderRadius: 8,
                background: "var(--surface0)", border: "1px solid var(--surface1)",
                fontSize: 13,
              }}>
                {k.factory_id
                  ? <FactoryIcon size={14} color="var(--blue)" />
                  : <Building2  size={14} color="var(--overlay1)" />}
                <span style={{ fontSize: 11, fontWeight: 700, color: k.factory_id ? "var(--blue)" : "var(--overlay1)", textTransform: "uppercase", letterSpacing: "0.04em", flexShrink: 0 }}>
                  {k.factory_id ? (k.factory_name ?? "Factory") : "Tenant-wide"}
                </span>
                <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", flex: 1 }}>
                  sk_live_•••••••••••••••••{k.preview.replace("…", "")}
                </code>
                <span style={{ fontSize: 11, color: "var(--overlay0)", flexShrink: 0 }}>
                  {new Date(k.created_at).toLocaleDateString()}
                </span>
                <button
                  onClick={() => revoke(k.id)}
                  disabled={deleting === k.id}
                  title="Revoke key"
                  style={{ padding: 6, borderRadius: 6, border: "1px solid rgba(228,75,95,0.2)", background: "rgba(228,75,95,0.06)", cursor: deleting === k.id ? "not-allowed" : "pointer", color: "var(--red)", display: "flex" }}
                >
                  {deleting === k.id ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={12} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── New key creation ── */}
      <div style={{ marginBottom: 24, padding: 16, borderRadius: 10, border: "1px solid var(--surface1)", background: "var(--mantle)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <Plus size={14} color="var(--overlay1)" />
          <span style={{ fontSize: 13, fontWeight: 700 }}>Generate a new key</span>
        </div>

        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext1)", marginBottom: 6 }}>Scope</label>
        <select
          value={createScope}
          onChange={(e) => setCreateScope(e.target.value as Scope)}
          style={{
            width: "100%", padding: "9px 12px", borderRadius: 8, fontSize: 13,
            background: "var(--surface0)", border: "1px solid var(--surface1)",
            color: "var(--text)", fontFamily: "var(--font-sans)", cursor: "pointer", boxSizing: "border-box",
            marginBottom: 12,
          }}
        >
          <option value="tenant">Tenant-wide · {ws.tenant.name}</option>
          {ws.factories.map((f) => (
            <option key={f.id} value={f.id}>Factory · {f.name} ({f.slug})</option>
          ))}
        </select>

        {existingKeyForScope && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 7, background: "rgba(245,159,0,0.08)", border: "1px solid rgba(245,159,0,0.25)", fontSize: 12, color: "var(--peach)", marginBottom: 12 }}>
            <AlertCircle size={13} />
            A key already exists for this scope. Generating will replace it and the old key will stop working.
          </div>
        )}

        <button
          onClick={() => generateKey(createScope)}
          disabled={generating !== null}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "9px 14px", borderRadius: 8, border: "none",
            background: existingKeyForScope ? "var(--peach)" : "var(--blue)",
            color: "#fff", fontSize: 13, fontWeight: 600,
            cursor: generating !== null ? "not-allowed" : "pointer",
            opacity: generating !== null ? 0.6 : 1,
          }}
        >
          {generating === createScope
            ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Generating…</>
            : <><RefreshCw size={13} /> {existingKeyForScope ? "Regenerate key" : "Generate key"}</>}
        </button>

        {newKey && (
          <div style={{ marginTop: 14 }}>
            <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 8, background: "rgba(28,191,107,0.08)", border: "1px solid rgba(28,191,107,0.3)", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--green)" }}>
              <CheckCircle2 size={13} /> Copy this key now — it will not be shown again.
            </div>
            <CopyField value={newKey.raw} />
          </div>
        )}

        {error && (
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 7, padding: "7px 11px", borderRadius: 7, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)", fontSize: 12, color: "var(--red)" }}>
            <AlertCircle size={13} /> {error}
          </div>
        )}
      </div>

      {/* ── Env var snippet ── */}
      <div>
        <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--subtext1)", marginBottom: 6 }}>
          Env vars for the CLI
          {ws.factories.length > 1 && (
            <select
              value={selectedFactorySlug}
              onChange={(e) => setSelectedFactorySlug(e.target.value)}
              style={{ marginLeft: 12, padding: "2px 8px", borderRadius: 6, fontSize: 12, background: "var(--surface0)", border: "1px solid var(--surface1)", color: "var(--text)", fontFamily: "var(--font-sans)", cursor: "pointer" }}
            >
              {ws.factories.map((f) => <option key={f.id} value={f.slug}>{f.name}</option>)}
            </select>
          )}
        </label>
        <div style={{ background: "var(--crust)", border: "1px solid var(--surface0)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "9px 14px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: "var(--overlay0)" }}><Terminal size={12} /> .env / CI secrets</div>
            <CopySnippet value={envSnippet} />
          </div>
          <pre style={{ margin: 0, padding: "14px 16px", fontSize: 12, lineHeight: 1.7, fontFamily: "var(--font-mono)", color: "var(--text)", overflowX: "auto" }}>
            {[
              { k: "TWINPILOT_TENANT",  v: tenantSlug  },
              { k: "TWINPILOT_FACTORY", v: factorySlug },
              { k: "TWINPILOT_API_KEY", v: newKey?.raw ?? "<your-api-key>" },
            ].map(({ k, v }) => (
              <span key={k}><span style={{ color: "#00c2a8" }}>{k}</span><span style={{ color: "var(--overlay0)" }}>=</span><span style={{ color: "#a78bfa" }}>{v}</span>{"\n"}</span>
            ))}
          </pre>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function CopySnippet({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }); }}
      style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 6, border: "1px solid var(--surface1)", background: "transparent", color: copied ? "var(--green)" : "var(--overlay0)", fontSize: 11, cursor: "pointer" }}
    >
      {copied ? <><Check size={10} /> Copied</> : <><Copy size={10} /> Copy all</>}
    </button>
  );
}
