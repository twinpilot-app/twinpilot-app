"use client";

/**
 * Admin > Integrations
 *
 * Platform-level infrastructure credentials and deployment controls.
 * Credentials are stored in Supabase (admin_config table) — NOT in env files.
 * Only NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and
 * SUPABASE_SERVICE_ROLE_KEY must remain as env vars (needed to boot at all).
 *
 * Sections:
 *   1. Supabase       — core DB/auth (env vars only — cannot store in self)
 *   2. Vercel         — Command Center hosting, deployment status, redeploy
 *   3. Worker Image   — GHCR tirsa-worker, publish new image
 *   4. Live check     — Supabase connection health
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  CheckCircle2, AlertCircle, Database, Server, ExternalLink,
  RefreshCw, Loader2, ShieldCheck, Triangle, Package,
  RotateCcw, Play, GitCommit, Clock, Tag, Pencil, X, Save,
  Eye, EyeOff, Zap,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EnvVar {
  var: string;
  label: string;
  set: boolean;
  preview?: string;
}

interface ConfigEntry {
  key: string;
  set: boolean;
  inDb: boolean;
  preview?: string;
  updatedAt?: string | null;
}

interface SupabaseHealth {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
  tenantCount: number | null;
}

interface VercelDeployment {
  url: string;
  state: string;
  createdAt: string;
  commitSha?: string;
  commitMessage?: string;
  branch?: string;
}

interface WorkerImage {
  tags: string[];
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StateChip({ state }: { state: string }) {
  const map: Record<string, { color: string; bg: string; label: string }> = {
    READY:    { color: "#a6e3a1", bg: "rgba(166,227,161,0.12)", label: "Ready" },
    BUILDING: { color: "#f9e2af", bg: "rgba(249,226,175,0.12)", label: "Building" },
    ERROR:    { color: "#f38ba8", bg: "rgba(243,139,168,0.12)", label: "Error" },
    CANCELED: { color: "#a6adc8", bg: "rgba(166,173,200,0.12)", label: "Canceled" },
  };
  const s = map[state] ?? { color: "var(--overlay0)", bg: "var(--surface0)", label: state };
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99,
      background: s.bg, color: s.color, textTransform: "uppercase", letterSpacing: "0.04em",
    }}>
      {s.label}
    </span>
  );
}

function SourceBadge({ inDb }: { inDb: boolean }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99,
      background: inDb ? "rgba(137,180,250,0.12)" : "rgba(166,173,200,0.1)",
      color: inDb ? "var(--blue)" : "var(--overlay0)",
      textTransform: "uppercase", letterSpacing: "0.04em",
    }}>
      {inDb ? "DB" : "env"}
    </span>
  );
}

function EnvRow({ e }: { e: EnvVar }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ color: e.set ? "var(--green)" : "var(--red)", flexShrink: 0 }}>
        {e.set ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
      </span>
      <code style={{ fontSize: 12, color: "var(--text)", flex: 1, fontFamily: "var(--font-mono)" }}>{e.var}</code>
      <span style={{ fontSize: 11, color: "var(--subtext0)" }}>{e.label}</span>
      {e.set && e.preview && (
        <code style={{ fontSize: 11, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{e.preview}</code>
      )}
      {!e.set && <span style={{ fontSize: 11, color: "var(--red)", fontWeight: 600 }}>Not set</span>}
    </div>
  );
}

/** Editable config row — saves to DB via PUT /api/admin/config */
function ConfigRow({
  entry,
  label,
  hint,
  isSecret = true,
  onSaved,
  getToken,
}: {
  entry: ConfigEntry | undefined;
  label: string;
  hint?: string;
  isSecret?: boolean;
  onSaved: () => void;
  getToken: () => Promise<string>;
}) {
  const [editing, setEditing]   = useState(false);
  const [value, setValue]       = useState("");
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const key = entry?.key ?? "";

  async function save() {
    setSaving(true); setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? "Save failed");
      }
      setEditing(false); setValue("");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function clear() {
    setSaving(true); setError(null);
    try {
      const token = await getToken();
      await fetch("/api/admin/config", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: "" }),
      });
      setEditing(false); setValue("");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const isSet = entry?.set ?? false;

  return (
    <div style={{ borderBottom: "1px solid var(--surface0)", padding: "12px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: editing ? 10 : 0 }}>
        <span style={{ color: isSet ? "var(--green)" : "var(--red)", flexShrink: 0 }}>
          {isSet ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
        </span>
        <code style={{ fontSize: 12, color: "var(--text)", flex: 1, fontFamily: "var(--font-mono)" }}>{key}</code>
        <span style={{ fontSize: 11, color: "var(--subtext0)", marginRight: 4 }}>{label}</span>

        {isSet && entry?.preview && (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <code style={{ fontSize: 11, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>
              {revealed ? entry.preview : entry.preview}
            </code>
            <SourceBadge inDb={entry?.inDb ?? false} />
          </div>
        )}
        {!isSet && <span style={{ fontSize: 11, color: "var(--red)", fontWeight: 600 }}>Not set</span>}

        <div style={{ display: "flex", gap: 4, marginLeft: 4 }}>
          {!editing && (
            <button
              onClick={() => { setEditing(true); setValue(""); setError(null); }}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 6, border: "1px solid var(--surface1)", background: "var(--surface0)", color: "var(--subtext1)", fontSize: 11, fontWeight: 600, cursor: "pointer" }}
            >
              <Pencil size={10} /> {isSet ? "Edit" : "Set"}
            </button>
          )}
          {isSet && entry?.inDb && !editing && (
            <button
              onClick={clear}
              disabled={saving}
              style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 7px", borderRadius: 6, border: "1px solid rgba(228,75,95,0.2)", background: "rgba(228,75,95,0.06)", color: "var(--red)", fontSize: 11, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.5 : 1 }}
            >
              <X size={10} /> Clear
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 23 }}>
          {hint && (
            <div style={{ fontSize: 11, color: "var(--subtext0)" }}>{hint}</div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <input
                type={isSecret && !revealed ? "password" : "text"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={isSet ? "Enter new value to replace…" : "Paste value…"}
                autoFocus
                style={{
                  width: "100%", padding: "8px 34px 8px 10px", borderRadius: 8, fontSize: 12,
                  background: "var(--surface0)", border: "1px solid var(--surface1)",
                  color: "var(--text)", fontFamily: isSecret ? "var(--font-mono)" : "var(--font-sans)",
                  boxSizing: "border-box",
                }}
              />
              {isSecret && (
                <button
                  onClick={() => setRevealed((r) => !r)}
                  style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 0, display: "flex" }}
                >
                  {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              )}
            </div>
            <button
              onClick={save}
              disabled={saving || !value.trim()}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 14px", borderRadius: 8, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: saving || !value.trim() ? "not-allowed" : "pointer", opacity: saving || !value.trim() ? 0.5 : 1 }}
            >
              {saving ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={12} />}
              Save
            </button>
            <button
              onClick={() => { setEditing(false); setValue(""); setError(null); }}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--surface1)", background: "var(--surface0)", color: "var(--subtext1)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
            >
              <X size={12} /> Cancel
            </button>
          </div>
          {error && (
            <div style={{ fontSize: 11, color: "var(--red)" }}>{error}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Boolean toggle backed by an admin_config entry. Stores "true" /
 * "false" as strings so the existing string-keyed admin_config table
 * doesn't need a schema change.
 */
function ToggleRow({
  entry,
  label,
  hint,
  onSaved,
  getToken,
}: {
  entry: ConfigEntry | undefined;
  label: string;
  hint?: string;
  onSaved: () => void;
  getToken: () => Promise<string>;
}) {
  const on = entry?.set === true;
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  async function setValue(next: boolean) {
    if (!entry) return;
    setSaving(true); setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ key: entry.key, value: next ? "true" : "" }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? "Save failed");
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          type="button"
          onClick={() => setValue(!on)}
          disabled={saving}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "5px 11px", borderRadius: 999,
            border: `1px solid ${on ? "rgba(28,191,107,0.4)" : "var(--surface1)"}`,
            background: on ? "rgba(28,191,107,0.12)" : "var(--surface0)",
            color: on ? "var(--green)" : "var(--subtext0)",
            fontSize: 11, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
            fontFamily: "var(--font-sans)", flexShrink: 0,
          }}
        >
          {saving ? <Loader2 size={11} className="spin" /> : <span style={{ fontSize: 12, lineHeight: 1 }}>{on ? "●" : "○"}</span>}
          {on ? "On" : "Off"}
        </button>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{label}</span>
      </div>
      {hint && <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 6, lineHeight: 1.5 }}>{hint}</div>}
      {error && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 4 }}>{error}</div>}
    </div>
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--mantle)", border: "1px solid var(--surface1)",
      borderRadius: 14, overflow: "hidden", marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function CardHeader({ icon, title, badge, status, link }: {
  icon: React.ReactNode;
  title: string;
  badge?: string;
  status?: { ok: boolean; label: string };
  link?: { href: string; label: string };
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px 18px", borderBottom: "1px solid var(--surface0)" }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: "var(--surface0)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>{title}</span>
          {badge && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 99, background: "rgba(228,75,95,0.12)", color: "var(--red)", textTransform: "uppercase" }}>
              {badge}
            </span>
          )}
          {status && (
            <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: status.ok ? "var(--green)" : "var(--overlay0)", fontWeight: 600 }}>
              {status.ok && <CheckCircle2 size={12} />}
              {status.label}
            </span>
          )}
        </div>
      </div>
      {link && (
        <a href={link.href} target="_blank" rel="noreferrer"
          style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--blue)", textDecoration: "none", flexShrink: 0 }}>
          <ExternalLink size={11} /> {link.label}
        </a>
      )}
    </div>
  );
}

function ActionButton({ onClick, disabled, busy, icon, label, variant = "default" }: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon: React.ReactNode;
  label: string;
  variant?: "default" | "primary";
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "7px 14px", borderRadius: 8,
        border: variant === "primary" ? "none" : "1px solid var(--surface1)",
        background: variant === "primary" ? "var(--blue)" : "var(--surface0)",
        color: variant === "primary" ? "#fff" : "var(--text)",
        fontSize: 12, fontWeight: 600, cursor: disabled || busy ? "not-allowed" : "pointer",
        opacity: disabled || busy ? 0.6 : 1,
        transition: "opacity 0.15s",
      }}
    >
      {busy
        ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
        : icon}
      {label}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminIntegrationsPage() {
  // Supabase (env-only) state
  const [supaEnv,     setSupaEnv]     = useState<EnvVar[] | null>(null);
  const [supaHealth,  setSupaHealth]  = useState<SupabaseHealth | null>(null);
  const [supaLoading, setSupaLoading] = useState(true);
  const [supaChecking,setSupaChecking]= useState(false);

  // Admin config (DB-stored) state
  const [config,        setConfig]        = useState<ConfigEntry[]>([]);
  const [configLoading, setConfigLoading] = useState(true);

  // Deployment status state
  const [deployData,    setDeployData]    = useState<{
    vercel: { env: EnvVar[]; deployment: VercelDeployment | null; deployHookSet: boolean };
    worker: { env: EnvVar[]; image: WorkerImage | null; packageUrl: string };
  } | null>(null);
  const [deployLoading, setDeployLoading] = useState(true);
  const [deployChecking,setDeployChecking]= useState(false);

  // Action state
  const [redeployBusy, setRedeployBusy] = useState(false);
  const [redeployMsg,  setRedeployMsg]  = useState<string | null>(null);
  const [publishBusy,  setPublishBusy]  = useState(false);
  const [publishMsg,   setPublishMsg]   = useState<string | null>(null);

  const getToken = useCallback(async () => {
    const { data: { session } } = await (await import("@/lib/supabase")).supabase.auth.getSession();
    return session?.access_token ?? "";
  }, []);

  // ── Fetchers ───────────────────────────────────────────────────────────────

  const fetchSupa = useCallback(async () => {
    const token = await getToken();
    const res = await fetch("/api/admin/infra-status", { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const body = await res.json() as { env: EnvVar[]; health: SupabaseHealth };
      setSupaEnv(body.env);
      setSupaHealth(body.health);
    }
  }, [getToken]);

  const fetchConfig = useCallback(async () => {
    const token = await getToken();
    const res = await fetch("/api/admin/config", { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const body = await res.json() as { config: ConfigEntry[] };
      setConfig(body.config);
    }
  }, [getToken]);

  const fetchDeploy = useCallback(async () => {
    const token = await getToken();
    const res = await fetch("/api/admin/deployment-status", { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setDeployData(await res.json());
  }, [getToken]);

  useEffect(() => {
    void (async () => {
      setSupaLoading(true); setConfigLoading(true); setDeployLoading(true);
      try { await Promise.all([fetchSupa(), fetchConfig(), fetchDeploy()]); }
      finally { setSupaLoading(false); setConfigLoading(false); setDeployLoading(false); }
    })();
  }, [fetchSupa, fetchConfig, fetchDeploy]);

  // After saving a config key, re-fetch both config and deployment status
  const handleSaved = useCallback(async () => {
    await Promise.all([fetchConfig(), fetchDeploy()]);
  }, [fetchConfig, fetchDeploy]);

  async function recheckSupa() {
    setSupaChecking(true);
    try { await fetchSupa(); } finally { setSupaChecking(false); }
  }

  async function recheckDeploy() {
    setDeployChecking(true);
    try { await Promise.all([fetchConfig(), fetchDeploy()]); } finally { setDeployChecking(false); }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleRedeploy() {
    setRedeployBusy(true); setRedeployMsg(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/redeploy", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json() as { ok?: boolean; error?: string };
      setRedeployMsg(res.ok ? "Redeploy triggered. Check Vercel dashboard for progress." : `Error: ${body.error}`);
    } catch (e) {
      setRedeployMsg(`Error: ${(e as Error).message}`);
    } finally {
      setRedeployBusy(false);
    }
  }

  async function handlePublishWorker() {
    setPublishBusy(true); setPublishMsg(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/admin/publish-worker", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json() as { ok?: boolean; error?: string };
      setPublishMsg(res.ok ? "Workflow dispatched. New image will be published in ~10 minutes." : `Error: ${body.error}`);
    } catch (e) {
      setPublishMsg(`Error: ${(e as Error).message}`);
    } finally {
      setPublishBusy(false);
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  function cfg(key: string) { return config.find((c) => c.key === key); }

  const supaAllSet     = supaEnv?.every((e) => e.set) ?? false;
  const vercelTokenSet = cfg("VERCEL_TOKEN")?.set ?? false;
  const togglesSet     = (cfg("PUSH_VIA_TRIGGER")?.set ? 1 : 0);
  const vercelProjSet  = cfg("VERCEL_PROJECT_ID")?.set ?? false;
  const vercelHookSet  = cfg("VERCEL_DEPLOY_HOOK_URL")?.set ?? false;
  const ghTokenSet     = cfg("GITHUB_ADMIN_TOKEN")?.set ?? false;
  const vercelOk       = vercelTokenSet && vercelProjSet;

  const loading = supaLoading && configLoading && deployLoading;

  function FeedbackMsg({ msg }: { msg: string | null }) {
    if (!msg) return null;
    const isErr = msg.startsWith("Error");
    return (
      <div style={{
        marginTop: 10, fontSize: 12, padding: "8px 12px", borderRadius: 8,
        background: isErr ? "rgba(228,75,95,0.08)" : "rgba(166,227,161,0.08)",
        border: `1px solid ${isErr ? "rgba(228,75,95,0.2)" : "rgba(166,227,161,0.2)"}`,
        color: isErr ? "var(--red)" : "var(--green)",
      }}>
        {msg}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 24px 80px", fontFamily: "var(--font-sans)", color: "var(--text)" }}>

      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--font-heading)", marginBottom: 4 }}>
          Factory Infrastructure
        </h1>
        <p style={{ fontSize: 13, color: "var(--subtext0)", margin: 0 }}>
          Platform-level credentials are stored in Supabase — configure everything here, no server files needed.
          Tenant integrations (LLM keys, GitHub, Trigger.dev) live in{" "}
          <a href="/orchestration" style={{ color: "var(--blue)" }}>Orchestration</a>.
        </p>
      </div>

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--subtext0)", fontSize: 14 }}>
          <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> Loading…
        </div>
      ) : (
        <>
          {/* ══ 1. Supabase ══════════════════════════════════════════════════ */}
          <SectionCard>
            <CardHeader
              icon={<Database size={18} color="#3ecf8e" />}
              title="Supabase — Core Database"
              badge="Required (env only)"
              status={supaAllSet ? { ok: true, label: "Configured" } : undefined}
              link={{ href: "https://supabase.com/dashboard", label: "Dashboard" }}
            />
            <div style={{ padding: "16px 18px" }}>
              <div style={{ fontSize: 12, color: "var(--subtext0)", marginBottom: 12, lineHeight: 1.5 }}>
                These must stay as environment variables — they're needed to connect to the database before anything else can load.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                {(supaEnv ?? []).map((e) => <EnvRow key={e.var} e={e} />)}
              </div>
              <div style={{ background: "var(--crust)", borderRadius: 10, padding: "12px 14px", fontSize: 12, color: "var(--subtext0)", lineHeight: 1.6 }}>
                <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                  <Server size={13} /> Where to set these
                </div>
                <div>Local: <code style={{ fontFamily: "var(--font-mono)", background: "var(--surface0)", padding: "1px 5px", borderRadius: 4 }}>services/command-center/.env.local</code></div>
                <div>Production: Vercel → Settings → Environment Variables</div>
              </div>
            </div>
          </SectionCard>

          {/* ══ 2. Vercel ════════════════════════════════════════════════════ */}
          <SectionCard>
            <CardHeader
              icon={<Triangle size={16} color="#fff" />}
              title="Vercel — Command Center"
              status={vercelOk ? { ok: true, label: "Configured" } : undefined}
              link={{ href: "https://vercel.com/dashboard", label: "Dashboard" }}
            />
            <div style={{ padding: "16px 18px" }}>

              {/* Editable config rows */}
              <div style={{ marginBottom: 16 }}>
                {configLoading ? (
                  <div style={{ color: "var(--overlay0)", fontSize: 12 }}>Loading…</div>
                ) : (
                  <>
                    <ConfigRow
                      entry={cfg("VERCEL_TOKEN")}
                      label="API token"
                      hint="Generate at vercel.com/account/tokens — needs read access to your project's deployments."
                      getToken={getToken}
                      onSaved={handleSaved}
                    />
                    <ConfigRow
                      entry={cfg("VERCEL_PROJECT_ID")}
                      label="Project ID"
                      hint="Found in Vercel → Project → Settings → General."
                      isSecret={false}
                      getToken={getToken}
                      onSaved={handleSaved}
                    />
                    <ConfigRow
                      entry={cfg("VERCEL_TEAM_ID")}
                      label="Team ID (optional)"
                      hint="Required only if the project lives under a Vercel team. Found in Team Settings → General."
                      isSecret={false}
                      getToken={getToken}
                      onSaved={handleSaved}
                    />
                    <ConfigRow
                      entry={cfg("VERCEL_DEPLOY_HOOK_URL")}
                      label="Deploy hook URL"
                      hint="Vercel → Project → Settings → Git → Deploy Hooks → create for branch 'main'. Enables one-click redeploy."
                      getToken={getToken}
                      onSaved={handleSaved}
                    />
                  </>
                )}
              </div>

              {/* Latest deployment */}
              {deployData?.vercel.deployment ? (
                <div style={{ background: "var(--crust)", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--subtext1)", marginBottom: 10 }}>
                    Latest production deployment
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <StateChip state={deployData.vercel.deployment.state} />
                      <a href={deployData.vercel.deployment.url} target="_blank" rel="noreferrer"
                        style={{ fontSize: 12, color: "var(--blue)", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
                        {deployData.vercel.deployment.url} <ExternalLink size={10} />
                      </a>
                    </div>
                    {deployData.vercel.deployment.commitSha && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--subtext0)" }}>
                        <GitCommit size={11} />
                        <code style={{ fontFamily: "var(--font-mono)" }}>{deployData.vercel.deployment.commitSha}</code>
                        {deployData.vercel.deployment.branch && (
                          <span style={{ color: "var(--overlay0)" }}>on {deployData.vercel.deployment.branch}</span>
                        )}
                        {deployData.vercel.deployment.commitMessage && (
                          <span style={{ color: "var(--text)" }}>— {deployData.vercel.deployment.commitMessage.slice(0, 72)}</span>
                        )}
                      </div>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--overlay0)" }}>
                      <Clock size={11} />
                      {new Date(deployData.vercel.deployment.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ) : vercelOk ? (
                <div style={{ fontSize: 12, color: "var(--overlay0)", marginBottom: 14 }}>
                  Could not fetch deployment info. Check VERCEL_TOKEN and VERCEL_PROJECT_ID.
                </div>
              ) : null}

              {/* Actions */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <ActionButton
                  onClick={handleRedeploy}
                  disabled={!vercelHookSet}
                  busy={redeployBusy}
                  icon={<RotateCcw size={12} />}
                  label="Redeploy"
                  variant="primary"
                />
                <ActionButton
                  onClick={recheckDeploy}
                  busy={deployChecking}
                  icon={<RefreshCw size={12} />}
                  label="Refresh"
                />
                {!vercelHookSet && (
                  <span style={{ fontSize: 11, color: "var(--overlay0)" }}>
                    Set deploy hook URL above to enable one-click redeploy.
                  </span>
                )}
              </div>
              <FeedbackMsg msg={redeployMsg} />
            </div>
          </SectionCard>

          {/* ══ 3. Worker Image ══════════════════════════════════════════════ */}
          <SectionCard>
            <CardHeader
              icon={<Package size={16} color="#89b4fa" />}
              title="Worker Image — GHCR"
              status={ghTokenSet ? { ok: true, label: "Token configured" } : undefined}
              link={{ href: deployData?.worker.packageUrl ?? "https://github.com/tirsasoftware/tirsa-factory/pkgs/container/tirsa-worker", label: "Package" }}
            />
            <div style={{ padding: "16px 18px" }}>

              {/* Editable config */}
              <div style={{ marginBottom: 16 }}>
                {configLoading ? (
                  <div style={{ color: "var(--overlay0)", fontSize: 12 }}>Loading…</div>
                ) : (
                  <ConfigRow
                    entry={cfg("GITHUB_ADMIN_TOKEN")}
                    label="GitHub PAT"
                    hint="Create at github.com/settings/tokens with scopes: read:packages + workflow. Used to fetch image info and dispatch publish-worker.yml."
                    getToken={getToken}
                    onSaved={handleSaved}
                  />
                )}
              </div>

              {/* Latest image */}
              {deployData?.worker.image ? (
                <div style={{ background: "var(--crust)", borderRadius: 10, padding: "12px 14px", marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--subtext1)", marginBottom: 10 }}>
                    Latest published image
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Tag size={11} color="var(--overlay0)" />
                      {deployData.worker.image.tags.map((tag) => (
                        <code key={tag} style={{ fontSize: 11, fontFamily: "var(--font-mono)", background: "var(--surface0)", padding: "2px 8px", borderRadius: 6, color: "var(--text)" }}>
                          {tag}
                        </code>
                      ))}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--overlay0)" }}>
                      <Clock size={11} />
                      {new Date(deployData.worker.image.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              ) : ghTokenSet ? (
                <div style={{ fontSize: 12, color: "var(--overlay0)", marginBottom: 14 }}>
                  Could not fetch image info. Check that the token has <code style={{ fontFamily: "var(--font-mono)", background: "var(--surface0)", padding: "1px 5px", borderRadius: 4 }}>read:packages</code> scope.
                </div>
              ) : null}

              {/* Actions */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <ActionButton
                  onClick={handlePublishWorker}
                  disabled={!ghTokenSet}
                  busy={publishBusy}
                  icon={<Play size={12} />}
                  label="Publish new image"
                  variant="primary"
                />
                <ActionButton
                  onClick={recheckDeploy}
                  busy={deployChecking}
                  icon={<RefreshCw size={12} />}
                  label="Refresh"
                />
              </div>
              <FeedbackMsg msg={publishMsg} />
            </div>
          </SectionCard>

          {/* ══ 3.5 Runtime toggles ═════════════════════════════════════════ */}
          <SectionCard>
            <CardHeader
              icon={<Zap size={16} color="#f59f00" />}
              title="Runtime toggles"
              status={{ ok: true, label: `${togglesSet} set` }}
            />
            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
              <ToggleRow
                entry={cfg("PUSH_VIA_TRIGGER")}
                label="Offload sprint push to Trigger.dev worker"
                hint="Turn on to enqueue the push-sprint task on the tenant's worker instead of running inline in this Vercel function. Recommended on Vercel Hobby (10s limit) or for large sprints. Each tenant must have Trigger.dev configured in Integrations → Processing and a current worker deploy."
                getToken={getToken}
                onSaved={handleSaved}
              />
            </div>
          </SectionCard>

          {/* ══ 4. Live connection check ══════════════════════════════════════ */}
          <SectionCard>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--surface0)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <ShieldCheck size={16} color="var(--blue)" />
                <span style={{ fontSize: 13, fontWeight: 700 }}>Live connection check</span>
              </div>
              <ActionButton onClick={recheckSupa} busy={supaChecking} icon={<RefreshCw size={12} />} label="Re-check" />
            </div>
            <div style={{ padding: "14px 18px" }}>
              {supaHealth ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                    <span style={{ color: supaHealth.ok ? "var(--green)" : "var(--red)" }}>
                      {supaHealth.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                    </span>
                    <span style={{ fontWeight: 600, color: supaHealth.ok ? "var(--green)" : "var(--red)" }}>
                      {supaHealth.ok ? "Supabase connection OK" : "Connection failed"}
                    </span>
                    {supaHealth.latencyMs !== null && (
                      <span style={{ fontSize: 11, color: "var(--overlay0)" }}>{supaHealth.latencyMs} ms</span>
                    )}
                  </div>
                  {supaHealth.tenantCount !== null && (
                    <div style={{ fontSize: 12, color: "var(--subtext0)" }}>
                      {supaHealth.tenantCount} tenant{supaHealth.tenantCount !== 1 ? "s" : ""} in database.
                    </div>
                  )}
                  {supaHealth.error && (
                    <div style={{ fontSize: 12, color: "var(--red)", background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.2)", borderRadius: 8, padding: "8px 12px", fontFamily: "var(--font-mono)" }}>
                      {supaHealth.error}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 13, color: "var(--overlay0)" }}>No check run yet.</div>
              )}
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}
