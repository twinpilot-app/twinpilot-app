"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  ExternalLink,
  Save,
  Loader2,
  X,
  ChevronDown,
  Zap,
  Container,
  Copy,
  Check,
  Terminal,
} from "lucide-react";
import IntegrationsShell from "../../components/IntegrationsShell";
import { useAuth } from "../../lib/auth-context";
import { brand } from "@/lib/brand";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TestStep {
  name: string;
  ok: boolean;
  detail?: string;
}

/* ------------------------------------------------------------------ */
/*  Field definitions                                                  */
/* ------------------------------------------------------------------ */

const TRIGGER_FIELDS: {
  key: string;
  label: string;
  description: string;
  placeholder: string;
  secret: boolean;
}[] = [
  {
    key: "TRIGGER_PROJECT_ID",
    label: "Project ref",
    description: "Project → General → Project ref",
    placeholder: "proj_…",
    secret: false,
  },
  {
    key: "TRIGGER_DEV_SECRET_KEY",
    label: "Development Secret Key",
    description: "Environment Development → API Keys → Secret key",
    placeholder: "tr_dev_…",
    secret: true,
  },
  {
    key: "TRIGGER_PROD_SECRET_KEY",
    label: "Production Secret Key",
    description: "Environment Production → API Keys → Secret key",
    placeholder: "tr_prod_…",
    secret: true,
  },
  {
    key: "TRIGGER_ACCESS_TOKEN",
    label: "Personal Access Token",
    description: "Account → Tokens → generate at cloud.trigger.dev/account/tokens",
    placeholder: "tr_pat_…",
    secret: true,
  },
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function OrchestrationPage() {
  const router = useRouter();
  const { session, tenantId, loading: authLoading } = useAuth();

  // Auth guard
  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  /* --- integration configured state --- */
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [previews,   setPreviews]   = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  /* --- trigger fields --- */
  const [edited, setEdited] = useState<Record<string, string>>({});
  /** Per-field mode. "saved" = show preview + Edit button; "editing" = input + Save/Cancel. */
  const [fieldMode, setFieldMode] = useState<Record<string, "saved" | "editing">>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [savingField, setSavingField] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<{ key: string; ok: boolean } | null>(null);

  /* --- test --- */
  const [testing, setTesting] = useState(false);
  const [testSteps, setTestSteps] = useState<TestStep[] | null>(null);

  /* --- env vars --- */
  const [envVars, setEnvVars] = useState<Map<string, { value: string; checked: boolean; remote: boolean }>>(new Map());
  const [envLoading, setEnvLoading] = useState(false);
  const [envSyncing, setEnvSyncing] = useState(false);
  const [envResult, setEnvResult] = useState<{ ok: boolean; set?: string[]; environments?: { env: string; ok: boolean; error?: string }[]; error?: string } | null>(null);
  const [envGroupCollapsed, setEnvGroupCollapsed] = useState<Record<string, boolean>>({});
  const [newVarName, setNewVarName] = useState("");
  const [newVarValue, setNewVarValue] = useState("");
  const [copiedVar, setCopiedVar] = useState<string | null>(null);

  /* --- section collapse --- */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ trigger: true, sync: true, deploy: true });

  const triggerConfigured =
    configured.has("trigger:TRIGGER_PROJECT_ID") &&
    (configured.has("trigger:TRIGGER_DEV_SECRET_KEY") ||
      configured.has("trigger:TRIGGER_PROD_SECRET_KEY"));

  /* ---------------------------------------------------------------- */
  /*  Load configured status                                          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!tenantId) return;
    setLoading(true);
    fetch(`/api/settings/integrations?tenantId=${tenantId}`, { headers: { Authorization: `Bearer ${session?.access_token}` } })
      .then(async (res) => {
        if (res.ok) {
          const body = await res.json();
          setConfigured(new Set(body.configured));
          setPreviews(body.previews ?? {});
        }
      })
      .finally(() => setLoading(false));
  }, [tenantId]);

  /* ---------------------------------------------------------------- */
  /*  Load env-var sync status                                        */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!tenantId || !triggerConfigured) return;
    setEnvLoading(true);
    fetch(`/api/settings/integrations/trigger-sync?tenantId=${tenantId}`, { headers: { Authorization: `Bearer ${session?.access_token}` } })
      .then(async (res) => {
        if (!res.ok) return;
        const body = await res.json();
        const vars = new Map<string, { value: string; checked: boolean; remote: boolean }>();
        // Remote vars (already in Trigger.dev) — checked by default
        for (const [name, value] of Object.entries(body.remote ?? {})) {
          // Skip Trigger.dev internal vars
          if (name.startsWith("TRIGGER_") || name.startsWith("OTEL_")) continue;
          vars.set(name, { value: value as string, checked: true, remote: true });
        }
        // Suggested vars not yet remote — unchecked
        for (const [name, value] of Object.entries(body.suggested ?? {})) {
          if (!vars.has(name)) {
            vars.set(name, { value: value as string, checked: false, remote: false });
          }
        }
        setEnvVars(vars);
      })
      .finally(() => setEnvLoading(false));
  }, [tenantId, triggerConfigured]);

  /* Load last deploy status on mount (for header badge) */
  /* ---------------------------------------------------------------- */
  /*  Handlers                                                        */
  /* ---------------------------------------------------------------- */

  /** Save a single field. Keeps other fields untouched — fixes the prior behavior
   *  where the "Save" button POSTed every edited field at once. */
  const handleSaveField = async (fieldKey: string) => {
    if (!tenantId) return;
    const raw = (edited[fieldKey] ?? "").trim();
    if (!raw) {
      setSaveOk({ key: fieldKey, ok: false });
      return;
    }
    setSavingField(fieldKey);
    setSaveOk(null);
    try {
      const res = await fetch("/api/settings/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ tenantId, serviceId: "trigger", keys: { [fieldKey]: raw } }),
      });
      const ok = res.ok;
      setSaveOk({ key: fieldKey, ok });
      if (ok) {
        setConfigured((prev) => new Set(prev).add(`trigger:${fieldKey}`));
        // Optimistic preview — last 4 chars of what the user typed.
        setPreviews((prev) => ({
          ...prev,
          [`trigger:${fieldKey}`]: raw.length < 6 ? "●●●●" : `…${raw.slice(-4)}`,
        }));
        setEdited((p) => { const n = { ...p }; delete n[fieldKey]; return n; });
        setFieldMode((p) => ({ ...p, [fieldKey]: "saved" }));
      }
    } catch {
      setSaveOk({ key: fieldKey, ok: false });
    } finally {
      setSavingField(null);
    }
  };

  const handleEditField = (fieldKey: string) => {
    setFieldMode((p) => ({ ...p, [fieldKey]: "editing" }));
    setEdited((p) => ({ ...p, [fieldKey]: "" }));
    setSaveOk(null);
  };

  const handleCancelEdit = (fieldKey: string) => {
    setFieldMode((p) => ({ ...p, [fieldKey]: "saved" }));
    setEdited((p) => { const n = { ...p }; delete n[fieldKey]; return n; });
    setSaveOk(null);
  };

  const handleTest = async () => {
    if (!tenantId) return;
    setTesting(true);
    setTestSteps(null);
    try {
      const res = await fetch("/api/settings/integrations/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ tenantId, serviceId: "trigger" }),
      });
      const body = await res.json();
      setTestSteps(body.steps ?? [{ name: "Connection", ok: false, detail: "Unknown error" }]);
    } catch {
      setTestSteps([{ name: "Connection", ok: false, detail: "Network error" }]);
    } finally {
      setTesting(false);
    }
  };

  const handleEnvSync = async () => {
    if (!tenantId) return;
    setEnvSyncing(true);
    setEnvResult(null);
    const variables: Record<string, string | null> = {};
    envVars.forEach((v, name) => {
      if (v.checked) variables[name] = v.value;
    });
    try {
      const res = await fetch("/api/settings/integrations/trigger-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ tenantId, variables }),
      });
      const body = await res.json();
      setEnvResult(body);
      // Mark synced vars as remote
      if (body.ok) {
        setEnvVars((prev) => {
          const next = new Map(prev);
          for (const name of body.set ?? []) {
            const cur = next.get(name);
            if (cur) next.set(name, { ...cur, remote: true });
          }
          return next;
        });
      }
    } catch {
      setEnvResult({ ok: false, error: "Network error" });
    } finally {
      setEnvSyncing(false);
    }
  };

  const handleCopyVar = (name: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedVar(name);
    setTimeout(() => setCopiedVar(null), 2000);
  };

  const toggle = (section: string) =>
    setCollapsed((p) => ({ ...p, [section]: !p[section] }));

  /* ---------------------------------------------------------------- */
  /*  Shared styles                                                   */
  /* ---------------------------------------------------------------- */

  const cardStyle: React.CSSProperties = {
    background: "var(--mantle)",
    border: "1px solid var(--surface1)",
    borderRadius: 12,
    padding: 24,
    marginBottom: 24,
  };

  const sectionHeader: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    cursor: "pointer",
    userSelect: "none",
  };

  const labelStyle: React.CSSProperties = {
    color: "var(--text)",
    fontWeight: 600,
    fontSize: 14,
    marginBottom: 4,
  };

  const descStyle: React.CSSProperties = {
    color: "var(--subtext0)",
    fontSize: 12,
    marginBottom: 6,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--surface1)",
    background: "var(--surface0)",
    color: "var(--text)",
    fontSize: 14,
    outline: "none",
  };

  const btnPrimary: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 16px",
    borderRadius: 8,
    border: "none",
    background: "var(--blue)",
    color: "var(--base)",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  };

  const btnSecondary: React.CSSProperties = {
    ...btnPrimary,
    background: "var(--surface1)",
    color: "var(--text)",
  };

  const linkStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    color: "var(--blue)",
    fontSize: 13,
    textDecoration: "none",
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */

  if (authLoading || !session) return null;

  return (
    <IntegrationsShell
      active="orchestration"
      title="Processing"
      description="Monitor sprints, configure Trigger.dev, and deploy Factory Workers."
      maxWidth={920}
    >

          {/* ========================================================= */}
          {/*  SECTION 1 — Trigger.dev Configuration                     */}
          {/* ========================================================= */}
          <div style={cardStyle}>
            <div style={sectionHeader} onClick={() => toggle("trigger")}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Zap size={18} style={{ color: "var(--blue)" }} />
                <span style={{ color: "var(--text)", fontWeight: 600, fontSize: 16 }}>
                  Trigger.dev Configuration
                </span>
                {triggerConfigured
                  ? <CheckCircle2 size={14} style={{ color: "var(--green)" }} />
                  : <AlertCircle size={14} style={{ color: "var(--peach)" }} />}
              </div>
              <ChevronDown
                size={18}
                style={{
                  color: "var(--subtext0)",
                  transform: collapsed["trigger"] ? "rotate(-90deg)" : "rotate(0deg)",
                  transition: "transform 0.2s",
                }}
              />
            </div>

            {!collapsed["trigger"] && (
              <div style={{ marginTop: 20 }}>
                {/* Fields — each has its own saved/editing state */}
                {TRIGGER_FIELDS.map((f) => {
                  const isSet    = configured.has(`trigger:${f.key}`);
                  const preview  = previews[`trigger:${f.key}`];
                  // Implicit default: if the field is set, start in "saved" mode.
                  const mode     = fieldMode[f.key] ?? (isSet ? "saved" : "editing");
                  const isSecret = f.secret;
                  const shown    = reveal[f.key];
                  const busy     = savingField === f.key;
                  const result   = saveOk?.key === f.key ? saveOk.ok : null;

                  return (
                    <div key={f.key} style={{ marginBottom: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <label style={labelStyle}>{f.label}</label>
                        {isSet && (
                          <CheckCircle2 size={14} style={{ color: "var(--green)" }} />
                        )}
                      </div>
                      <p style={descStyle}>{f.description}</p>

                      {mode === "saved" ? (
                        /* ── Saved view: preview + Edit button ──────────── */
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div
                            style={{
                              ...inputStyle,
                              display: "flex",
                              alignItems: "center",
                              color: "var(--subtext0)",
                              fontFamily: "ui-monospace, SFMono-Regular, monospace",
                            }}
                          >
                            {preview ?? "●●●●"}
                          </div>
                          <button
                            type="button"
                            onClick={() => handleEditField(f.key)}
                            style={btnSecondary}
                          >
                            Edit
                          </button>
                        </div>
                      ) : (
                        /* ── Editing view: input + Save/Cancel per field ── */
                        <>
                          <div style={{ position: "relative" }}>
                            <input
                              /* Randomised name + autoComplete="new-password" keeps
                               * Chrome/1Password from pre-filling the saved value
                               * of another site or stale suggestion. */
                              name={`trigger-${f.key}-${Math.random().toString(36).slice(2, 8)}`}
                              type={isSecret && !shown ? "password" : "text"}
                              placeholder={f.placeholder}
                              value={edited[f.key] ?? ""}
                              onChange={(e) =>
                                setEdited((p) => ({ ...p, [f.key]: e.target.value }))
                              }
                              autoComplete="new-password"
                              data-1p-ignore
                              data-lpignore="true"
                              spellCheck={false}
                              style={inputStyle}
                            />
                            {isSecret && (
                              <button
                                type="button"
                                onClick={() =>
                                  setReveal((p) => ({ ...p, [f.key]: !p[f.key] }))
                                }
                                style={{
                                  position: "absolute",
                                  right: 8,
                                  top: "50%",
                                  transform: "translateY(-50%)",
                                  background: "none",
                                  border: "none",
                                  cursor: "pointer",
                                  color: "var(--subtext0)",
                                  padding: 4,
                                }}
                              >
                                {shown ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                            )}
                          </div>
                          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleSaveField(f.key)}
                              style={{ ...btnPrimary, opacity: busy ? 0.7 : 1 }}
                            >
                              {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                              Save
                            </button>
                            {isSet && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => handleCancelEdit(f.key)}
                                style={btnSecondary}
                              >
                                Cancel
                              </button>
                            )}
                            {result !== null && (
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4,
                                  fontSize: 13,
                                  color: result ? "var(--green)" : "var(--red)",
                                }}
                              >
                                {result ? <CheckCircle2 size={14} /> : <X size={14} />}
                                {result ? "Saved" : "Failed — please retry"}
                              </span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}

                {/* Connection test is a section-level action — keeps its own button. */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                    marginTop: 8,
                  }}
                >
                  <button
                    type="button"
                    style={{
                      ...btnSecondary,
                      opacity: testing ? 0.7 : 1,
                    }}
                    disabled={testing}
                    onClick={handleTest}
                  >
                    {testing ? <Loader2 size={16} className="spin" /> : <Zap size={16} />}
                    Test Connection
                  </button>
                </div>


                {/* Test result banner */}
                {testSteps && (
                  <div
                    style={{
                      marginTop: 16,
                      padding: "14px 18px",
                      borderRadius: 8,
                      border: `1px solid ${
                        testSteps.every((s) => s.ok) ? "var(--green)" : "var(--red)"
                      }`,
                      background: testSteps.every((s) => s.ok)
                        ? "color-mix(in srgb, var(--green) 8%, var(--mantle))"
                        : "color-mix(in srgb, var(--red) 8%, var(--mantle))",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 10,
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: 14,
                          color: testSteps.every((s) => s.ok)
                            ? "var(--green)"
                            : "var(--red)",
                        }}
                      >
                        {testSteps.every((s) => s.ok) ? "All checks passed" : "Some checks failed"}
                      </span>
                      <button
                        onClick={() => setTestSteps(null)}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "var(--subtext0)",
                          padding: 2,
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                    {testSteps.map((step, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          fontSize: 13,
                          color: "var(--text)",
                          marginBottom: i < testSteps.length - 1 ? 6 : 0,
                        }}
                      >
                        {step.ok ? (
                          <CheckCircle2 size={14} style={{ color: "var(--green)", flexShrink: 0 }} />
                        ) : (
                          <X size={14} style={{ color: "var(--red)", flexShrink: 0 }} />
                        )}
                        <span style={{ fontWeight: 600 }}>{step.name}</span>
                        {step.detail && <span style={{ color: "var(--overlay1)" }}>— {step.detail}</span>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Links */}
                <div
                  style={{
                    display: "flex",
                    gap: 16,
                    marginTop: 16,
                    flexWrap: "wrap",
                  }}
                >
                  <a
                    href="https://cloud.trigger.dev"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={linkStyle}
                  >
                    Dashboard <ExternalLink size={13} />
                  </a>
                  <a
                    href="https://trigger.dev/docs/apikeys"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={linkStyle}
                  >
                    Docs <ExternalLink size={13} />
                  </a>
                </div>

                {/* ── Environment Variables ── */}
                {triggerConfigured && (
                  <div style={{ marginTop: 28 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, color: "var(--subtext0)", fontSize: 13, fontWeight: 600 }}>
                      <span style={{ flex: "0 0 auto" }}>──</span>
                      <span>Environment Variables</span>
                      <span style={{ flex: 1, height: 1, background: "var(--surface1)" }} />
                    </div>
                    <p style={{ color: "var(--subtext0)", fontSize: 12, marginBottom: 12, lineHeight: 1.6 }}>
                      Select variables and sync them to your Trigger.dev project environments (dev + prod).
                    </p>

                    {envLoading ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--subtext0)", fontSize: 13 }}>
                        <Loader2 size={14} className="spin" /> Loading...
                      </div>
                    ) : (
                      <>
                        {/* Grouped variables */}
                        {(() => {
                          const groups = new Map<string, [string, { value: string; checked: boolean; remote: boolean }][]>();
                          envVars.forEach((v, name) => {
                            const idx = name.indexOf("_");
                            const prefix = idx > 0 ? name.slice(0, idx) : "OTHER";
                            const list = groups.get(prefix) ?? [];
                            list.push([name, v]);
                            groups.set(prefix, list);
                          });

                          if (groups.size === 0) {
                            return (
                              <div style={{ fontSize: 12, color: "var(--overlay0)", padding: "8px 0" }}>
                                No variables to configure. Supabase credentials will appear once Storage is set up.
                              </div>
                            );
                          }

                          return Array.from(groups.entries()).map(([prefix, vars]) => {
                            const isGroupCollapsed = envGroupCollapsed[prefix] ?? true;
                            const allChecked = vars.every(([, v]) => v.checked);
                            const allRemote = vars.every(([, v]) => v.remote);
                            return (
                              <div key={prefix} style={{ marginBottom: 6, borderRadius: 8, border: "1px solid var(--surface1)", overflow: "hidden" }}>
                                {/* Group header */}
                                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "var(--surface0)" }}>
                                  <input type="checkbox" checked={allChecked}
                                    onChange={() => {
                                      const newVal = !allChecked;
                                      setEnvVars((prev) => {
                                        const next = new Map(prev);
                                        for (const [n, v] of vars) next.set(n, { ...v, checked: newVal });
                                        return next;
                                      });
                                    }}
                                    title={allChecked ? "Unselect all" : "Select all"}
                                    style={{ accentColor: "var(--blue)", cursor: "pointer", flexShrink: 0 }} />
                                  <button type="button" onClick={() => setEnvGroupCollapsed((p) => ({ ...p, [prefix]: !p[prefix] }))}
                                    style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0 }}>
                                    <ChevronDown size={12} style={{ color: "var(--overlay0)", transform: isGroupCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }} />
                                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--subtext1)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{prefix}</span>
                                    <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{vars.length}</span>
                                    <span style={{ flex: 1 }} />
                                    {allRemote
                                      ? <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 4, background: "rgba(28,191,107,0.12)", color: "var(--green)" }}>synced</span>
                                      : <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 4, background: "rgba(245,159,0,0.12)", color: "var(--peach)" }}>not synced</span>}
                                  </button>
                                </div>
                                {/* Group items */}
                                {!isGroupCollapsed && (
                                  <div style={{ padding: "6px 10px" }}>
                                    {vars.map(([name, v]) => (
                                      <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 12 }}>
                                        <input type="checkbox" checked={v.checked}
                                          onChange={() => setEnvVars((prev) => { const next = new Map(prev); next.set(name, { ...v, checked: !v.checked }); return next; })}
                                          style={{ accentColor: "var(--blue)", cursor: "pointer", flexShrink: 0 }} />
                                        {v.remote
                                          ? <CheckCircle2 size={11} style={{ color: "var(--green)", flexShrink: 0 }} />
                                          : <AlertCircle size={11} style={{ color: "var(--peach)", flexShrink: 0 }} />}
                                        <code style={{ fontSize: 11, color: "var(--text)", minWidth: 160 }}>{name}</code>
                                        <span style={{ flex: 1, color: "var(--overlay1)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                          {v.value.length > 25 ? v.value.slice(0, 25) + "…" : v.value}
                                        </span>
                                        <button type="button" onClick={() => handleCopyVar(name, v.value)}
                                          title="Copy value"
                                          style={{ background: "none", border: "none", cursor: "pointer", color: copiedVar === name ? "var(--green)" : "var(--overlay0)", padding: 2, flexShrink: 0 }}>
                                          {copiedVar === name ? <Check size={12} /> : <Copy size={12} />}
                                        </button>
                                        <button type="button" onClick={() => setEnvVars((prev) => { const next = new Map(prev); next.delete(name); return next; })}
                                          title="Remove"
                                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, flexShrink: 0 }}>
                                          <X size={11} />
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          });
                        })()}

                        {/* Add variable */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, marginBottom: 12 }}>
                          <input type="text" placeholder="VARIABLE_NAME" value={newVarName}
                            onChange={(e) => setNewVarName(e.target.value.toUpperCase())}
                            autoComplete="off" style={{ ...inputStyle, width: 180, fontSize: 12 }} />
                          <input type="text" placeholder="value" value={newVarValue}
                            onChange={(e) => setNewVarValue(e.target.value)}
                            autoComplete="off" style={{ ...inputStyle, flex: 1, fontSize: 12 }} />
                          <button type="button"
                            style={{ ...btnSecondary, padding: "6px 12px", fontSize: 12, opacity: !newVarName.trim() ? 0.5 : 1 }}
                            disabled={!newVarName.trim()}
                            onClick={() => {
                              if (!newVarName.trim()) return;
                              setEnvVars((prev) => { const next = new Map(prev); next.set(newVarName.trim(), { value: newVarValue, checked: true, remote: false }); return next; });
                              setNewVarName(""); setNewVarValue("");
                            }}>+ Add</button>
                        </div>

                        {/* Sync button */}
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <button type="button" style={{ ...btnPrimary, opacity: envSyncing ? 0.7 : 1 }}
                            disabled={envSyncing || !Array.from(envVars.values()).some((v) => v.checked)}
                            onClick={handleEnvSync}>
                            {envSyncing ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
                            Sync selected to Trigger.dev
                          </button>
                          <span style={{ fontSize: 11, color: "var(--overlay0)" }}>
                            {Array.from(envVars.values()).filter((v) => v.checked).length} selected
                          </span>
                        </div>

                        {/* Sync result */}
                        {envResult && (
                          <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8,
                            border: `1px solid ${envResult.ok ? "var(--green)" : "var(--red)"}`,
                            background: envResult.ok ? "rgba(28,191,107,0.06)" : "rgba(237,67,55,0.06)",
                            fontSize: 12 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, color: envResult.ok ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
                              {envResult.ok ? <CheckCircle2 size={13} /> : <X size={13} />}
                              {envResult.ok ? "Sync completed" : "Sync failed"}
                            </div>
                            {envResult.error && <div style={{ color: "var(--red)", marginTop: 4 }}>{envResult.error}</div>}
                            {envResult.environments?.map((e) => (
                              <div key={e.env} style={{ marginTop: 3, color: e.ok ? "var(--green)" : "var(--red)" }}>
                                {e.ok ? "✓" : "✗"} {e.env} environment {e.error ? `— ${e.error}` : ""}
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ========================================================= */}
          {/*  SECTION 3 — Factory Workers (deployed from the CLI)       */}
          {/* ========================================================= */}
          <div style={cardStyle}>
            <div style={sectionHeader} onClick={() => toggle("deploy")}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Container size={18} style={{ color: "var(--blue)" }} />
                <span style={{ color: "var(--text)", fontWeight: 600, fontSize: 16 }}>
                  Factory Workers
                </span>
              </div>
              <ChevronDown
                size={18}
                style={{
                  color: "var(--subtext0)",
                  transform: collapsed["deploy"] ? "rotate(-90deg)" : "rotate(0deg)",
                  transition: "transform 0.2s",
                }}
              />
            </div>

            {!collapsed["deploy"] && (
              <div style={{ marginTop: 20 }}>
                <p style={{ color: "var(--subtext0)", fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
                  Workers are deployed to <strong>your</strong> Trigger.dev project — the one
                  configured above. You push them from your terminal using the {brand.shortName} CLI,
                  which bundles the orchestrator code, injects your tenant's env vars, and runs
                  <code style={{ fontFamily: "monospace", fontSize: 12, padding: "1px 6px", borderRadius: 4, background: "var(--surface0)", margin: "0 4px" }}>trigger.dev deploy</code>
                  under your credentials — no platform GitHub Actions, no shared secrets.
                </p>

                <div style={{
                  padding: "12px 16px", borderRadius: 8,
                  background: "var(--surface0)", border: "1px solid var(--surface1)",
                  fontSize: 13, color: "var(--text)", lineHeight: 1.8,
                }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    <div><span style={{ color: "var(--overlay0)" }}>$</span> npm i -g {brand.cli.packageName}</div>
                    <div><span style={{ color: "var(--overlay0)" }}>$</span> {brand.cli.binName} login</div>
                    <div><span style={{ color: "var(--overlay0)" }}>$</span> {brand.cli.binName} workers prepare</div>
                    <div><span style={{ color: "var(--overlay0)" }}>$</span> {brand.cli.binName} workers deploy  <span style={{ color: "var(--overlay0)" }}># cloud</span></div>
                    <div><span style={{ color: "var(--overlay0)" }}>$</span> {brand.cli.binName} workers dev     <span style={{ color: "var(--overlay0)" }}># local</span></div>
                  </div>
                </div>

                <a
                  href="/cli"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    marginTop: 14, padding: "8px 14px", borderRadius: 8,
                    background: "var(--blue)", color: "#fff",
                    textDecoration: "none", fontSize: 13, fontWeight: 600,
                  }}
                >
                  <Terminal size={13} /> Install the CLI
                </a>

                {!triggerConfigured && (
                  <p style={{ color: "var(--subtext0)", fontSize: 12, marginTop: 12 }}>
                    Configure Trigger.dev above before deploying workers.
                  </p>
                )}
              </div>
            )}
          </div>

      {/* Spin animation */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
      `}</style>
    </IntegrationsShell>
  );
}
