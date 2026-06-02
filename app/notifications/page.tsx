"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  Save,
  Loader2,
  X,
  ChevronDown,
  Zap,
  Bell,
  Trash2,
} from "lucide-react";
import IntegrationsShell from "../../components/IntegrationsShell";
import { useAuth } from "../../lib/auth-context";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Integration {
  id?: string;
  channel: string;
  name: string;
  integration_type: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

interface TestResult {
  ok: boolean;
  message: string;
}

/* ------------------------------------------------------------------ */
/*  Integration catalog                                                */
/* ------------------------------------------------------------------ */

const INTEGRATION_TEMPLATES = [
  { type: "telegram",   label: "Telegram",    icon: "✈️",  color: "#0088cc", channel: "telegram", category: "messaging",     fields: [
    { key: "bot_token", label: "Bot Token", placeholder: "123456:ABC-…", secret: true, description: "@BotFather → /newbot → copy token" },
    { key: "chat_id",   label: "Chat ID",   placeholder: "-100…",       secret: false, description: "Your chat or group ID" },
  ]},
  { type: "slack",      label: "Slack",       icon: "💬", color: "#4A154B", channel: "webhook",  category: "messaging",     fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://hooks.slack.com/services/T.../B.../...", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "discord",    label: "Discord",     icon: "🎮", color: "#5865F2", channel: "webhook",  category: "messaging",     fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/.../...", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "teams",      label: "MS Teams",    icon: "🟦", color: "#6264A7", channel: "webhook",  category: "messaging",     fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://outlook.office.com/webhook/...", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "jira",       label: "Jira",        icon: "🔷", color: "#0052CC", channel: "webhook",  category: "tickets",       fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://automation.atlassian.com/pro/hooks/...", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "linear",     label: "Linear",      icon: "◼️",  color: "#5E6AD2", channel: "webhook",  category: "tickets",       fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://api.linear.app/webhooks/...", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "pagerduty",  label: "PagerDuty",   icon: "🚨", color: "#06AC38", channel: "webhook",  category: "observability", fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://events.pagerduty.com/integration/.../enqueue", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "datadog",    label: "Datadog",     icon: "🐕", color: "#632CA6", channel: "webhook",  category: "observability", fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://http-intake.logs.datadoghq.com/api/v2/logs", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "opsgenie",   label: "OpsGenie",    icon: "🔔", color: "#2684FF", channel: "webhook",  category: "observability", fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://api.opsgenie.com/v2/alerts", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "n8n",        label: "n8n",         icon: "⚡", color: "#FF6D5A", channel: "webhook",  category: "automation",    fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://your-n8n.com/webhook/...", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "zapier",     label: "Zapier",      icon: "⚡", color: "#FF4A00", channel: "webhook",  category: "automation",    fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://hooks.zapier.com/hooks/catch/...", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "make",       label: "Make",        icon: "🔄", color: "#6D00CC", channel: "webhook",  category: "automation",    fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://hook.us1.make.com/...", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
  { type: "custom",     label: "Custom",      icon: "🔗", color: "#6b7a9e", channel: "webhook",  category: "other",         fields: [
    { key: "url", label: "Webhook URL", placeholder: "https://your-endpoint.com/webhook", secret: false },
    { key: "secret", label: "Secret (optional)", placeholder: "HMAC secret", secret: true },
  ]},
] as const;

type TemplateType = typeof INTEGRATION_TEMPLATES[number];

const CATEGORIES = [
  { id: "messaging",     label: "Messaging" },
  { id: "tickets",       label: "Issues & Tickets" },
  { id: "observability", label: "Observability" },
  { id: "automation",    label: "Automation" },
  { id: "other",         label: "Other" },
];

/* ------------------------------------------------------------------ */
/*  Telegram setup guide                                               */
/* ------------------------------------------------------------------ */

function TelegramGuide() {
  return (
    <details style={{ marginTop: 14 }}>
      <summary style={{
        fontSize: 12, color: "var(--subtext0)", cursor: "pointer",
        listStyle: "none", display: "flex", alignItems: "center", gap: 6,
      }}>
        <ChevronDown size={12} style={{ transition: "transform 0.2s" }} />
        How to set up Telegram notifications
      </summary>
      <div style={{
        marginTop: 10, padding: "14px 16px", borderRadius: 8,
        background: "var(--surface0)", fontSize: 13, lineHeight: 1.7,
        color: "var(--subtext1)",
      }}>
        <p style={{ margin: "0 0 10px", fontWeight: 600, color: "var(--text)" }}>1. Create a bot</p>
        <p style={{ margin: 0 }}>
          Open Telegram and search for <strong>@BotFather</strong>. Send <code>/newbot</code>,
          choose a name and username. BotFather will reply with a <strong>Bot Token</strong> — paste it above.
        </p>
        <p style={{ margin: "14px 0 10px", fontWeight: 600, color: "var(--text)" }}>2. Get your Chat ID</p>
        <p style={{ margin: 0 }}>
          Send any message to your new bot (or add it to a group). Then open this URL in your browser:
        </p>
        <code style={{
          display: "block", margin: "8px 0", padding: "8px 12px",
          background: "var(--base)", borderRadius: 6, fontSize: 12,
          wordBreak: "break-all",
        }}>
          {"https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"}
        </code>
        <p style={{ margin: 0 }}>
          Look for <code>{'"chat": { "id": 123456789 }'}</code> in the JSON response.
          For groups, the ID is negative (e.g. <code>-1001234567890</code>). Paste it above.
        </p>
        <p style={{ margin: "14px 0 10px", fontWeight: 600, color: "var(--text)" }}>3. Save &amp; Test</p>
        <p style={{ margin: 0 }}>
          Click <strong>Save</strong>, then <strong>Test</strong>. You should receive a confirmation
          message in your Telegram chat. Once configured, all enabled events in the preferences
          matrix below will be sent to this bot.
        </p>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function NotificationsPage() {
  const router = useRouter();
  const { session, tenantId, loading: authLoading } = useAuth();

  // Auth guard
  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  /* ── Integrations state ── */
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // id or "__new__"
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editType, setEditType] = useState<string>("custom");
  const [editEnabled, setEditEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({});

  /* ── Notification preferences matrix ── */
  type PrefKey = `${string}:${string}`;
  const [prefs, setPrefs] = useState<Map<PrefKey, boolean>>(new Map());
  const [platformConfig, setPlatformConfig] = useState<Map<string, boolean>>(new Map());
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [toggling, setToggling] = useState<PrefKey | null>(null);

  useEffect(() => {
    import("@/lib/supabase").then(({ supabase: supa }) => {
      supa.from("platform_notification_config").select("event_type, enabled").then(({ data }) => {
        const map = new Map<string, boolean>();
        for (const row of data ?? []) map.set(row.event_type as string, row.enabled as boolean);
        setPlatformConfig(map);
      });
    });
  }, []);

  function isEventEnabled(eventType: string): boolean {
    const v = platformConfig.get(eventType);
    return v !== false;
  }

  const EVENT_GROUPS = [
    { label: "Platform", events: [
      { type: "platform_update", label: "Platform update" },
      { type: "platform_instability", label: "Platform instability" },
      { type: "worker_update", label: "Worker update available" },
      { type: "cli_update", label: "CLI update available" },
    ]},
    { label: "Sprint", events: [
      { type: "sprint_started", label: "Sprint started" },
      { type: "sprint_completed", label: "Sprint completed" },
      { type: "sprint_failed", label: "Sprint failed" },
    ]},
    { label: "Queue", events: [
      { type: "queue_empty", label: "Office queue empty" },
      { type: "queue_full", label: "Office queue full" },
    ]},
    { label: "Human", events: [
      { type: "human_gate", label: "Human gate waiting" },
      { type: "agent_escalation", label: "Agent escalation" },
    ]},
    { label: "Marketplace", events: [
      { type: "factory_installed", label: "Factory installed" },
    ]},
  ] as const;

  const CHANNELS = [
    { id: "in_app", label: "In-app" },
    { id: "telegram", label: "Telegram" },
    { id: "webhook", label: "Webhook" },
  ] as const;

  /* ── Load integrations ── */
  const loadIntegrations = React.useCallback(async () => {
    if (!tenantId || !session) return;
    const res = await fetch(`/api/notifications/channels?tenantId=${tenantId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      const body = await res.json() as { channels?: Integration[] };
      setIntegrations(body.channels ?? []);
    }
  }, [tenantId, session]);

  useEffect(() => { loadIntegrations(); }, [loadIntegrations]);

  /* ── Load preferences ── */
  useEffect(() => {
    if (!tenantId || !session) return;
    fetch(`/api/notifications/preferences?tenantId=${tenantId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.json())
      .then((body: { preferences?: Array<{ event_type: string; channel: string; enabled: boolean }> }) => {
        const map = new Map<PrefKey, boolean>();
        for (const p of body.preferences ?? []) map.set(`${p.event_type}:${p.channel}`, p.enabled);
        setPrefs(map);
        setPrefsLoaded(true);
      })
      .catch(() => setPrefsLoaded(true));
  }, [tenantId, session]);

  function getPref(eventType: string, channel: string): boolean {
    const key: PrefKey = `${eventType}:${channel}`;
    const explicit = prefs.get(key);
    if (explicit !== undefined) return explicit;
    // Default: in_app always on, telegram on, webhook/email off
    if (channel === "in_app") return true;
    if (channel === "telegram") return true;
    return false;
  }

  async function togglePref(eventType: string, channel: string, currentValue: boolean) {
    if (!tenantId || !session) return;
    const key: PrefKey = `${eventType}:${channel}`;
    setToggling(key);
    const newValue = !currentValue;
    setPrefs((prev) => { const next = new Map(prev); next.set(key, newValue); return next; });
    await fetch("/api/notifications/preferences", {
      method: "PUT",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, eventType, channel, enabled: newValue }),
    });
    setToggling(null);
  }

  /* ── Integration CRUD ── */
  function getTemplate(type: string): TemplateType {
    return INTEGRATION_TEMPLATES.find((t) => t.type === type) ?? INTEGRATION_TEMPLATES[INTEGRATION_TEMPLATES.length - 1];
  }

  function selectTemplate(type: string) {
    const tmpl = getTemplate(type);
    setEditType(type);
    setEditForm({});
    setEditEnabled(true);
    setEditingId("__new__");
    setShowAddModal(false);
    setVisibleFields({});
    // Pre-fill name
    setEditForm({ __name__: tmpl.label });
  }

  function startEdit(intg: Integration) {
    const tmpl = getTemplate(intg.integration_type);
    const form: Record<string, string> = { __name__: intg.name };
    for (const f of tmpl.fields) {
      form[f.key] = (intg.config[f.key] as string) ?? "";
    }
    setEditType(intg.integration_type);
    setEditForm(form);
    setEditEnabled(intg.enabled);
    setEditingId(intg.id ?? "__new__");
    setVisibleFields({});
  }

  async function saveIntegration() {
    if (!tenantId || !session) return;
    setSaving(true);
    const tmpl = getTemplate(editType);
    const config: Record<string, unknown> = {};
    for (const f of tmpl.fields) {
      const val = editForm[f.key]?.trim();
      if (val) config[f.key] = val;
    }

    await fetch("/api/notifications/channels", {
      method: "PUT",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId,
        channel: tmpl.channel,
        name: editForm.__name__?.trim() || tmpl.label,
        config,
        enabled: editEnabled,
        integration_type: editType,
      }),
    });

    await loadIntegrations();
    setSaving(false);
    setEditingId(null);
  }

  async function deleteIntegration(intg: Integration) {
    if (!tenantId || !session || !intg.id) return;
    if (!confirm(`Remove ${intg.name}?`)) return;
    await fetch(`/api/notifications/channels?tenantId=${tenantId}&id=${intg.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    setIntegrations((prev) => prev.filter((i) => i.id !== intg.id));
  }

  async function testIntegration(intg: Integration) {
    if (!session || !tenantId) return;
    const key = intg.id ?? intg.name;
    setTesting(key);
    try {
      const tmpl = getTemplate(intg.integration_type);
      const body: Record<string, string> = { tenantId, channel: tmpl.channel };
      // Pass config fields for testing
      for (const f of tmpl.fields) {
        const val = intg.config[f.key] as string;
        if (val) body[f.key] = val;
      }
      // For webhook: pass url and secret specifically
      if (tmpl.channel === "webhook") {
        body.url = (intg.config.url as string) ?? "";
        body.secret = (intg.config.secret as string) ?? "";
      }

      const res = await fetch("/api/notifications/channels/test", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { ok?: boolean; message?: string; error?: string };
      setTestResults((prev) => ({ ...prev, [key]: { ok: !!data.ok, message: data.message ?? data.error ?? (data.ok ? "OK" : "Failed") } }));
    } catch (e: unknown) {
      setTestResults((prev) => ({ ...prev, [key]: { ok: false, message: (e as Error).message } }));
    }
    setTesting(null);
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  if (authLoading || !session) return null;

  return (
    <IntegrationsShell
      active="notifications"
      title="Notifications"
      description="Configure where you receive notifications. Add integrations and fine-tune per event."
      maxWidth={680}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

            {/* ── Integrations ── */}
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-heading)", margin: 0 }}>Integrations</h2>
                <button onClick={() => setShowAddModal(true)} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 8, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                  + Add Integration
                </button>
              </div>

              {/* Empty state */}
              {integrations.length === 0 && editingId === null && (
                <div style={{ textAlign: "center", padding: "28px 16px", color: "var(--overlay0)", fontSize: 13, background: "var(--mantle)", borderRadius: 12, border: "1px solid var(--surface0)" }}>
                  No integrations configured. Add one to receive notifications via Telegram, Slack, or other services.
                </div>
              )}

              {/* Existing integrations */}
              {integrations.map((intg) => {
                const tmpl = getTemplate(intg.integration_type);
                const key = intg.id ?? intg.name;
                const testRes = testResults[key];
                return (
                  <div key={key} style={{ marginBottom: 8, padding: "14px 18px", borderRadius: 10, background: "var(--mantle)", border: `1px solid ${intg.enabled ? "var(--surface1)" : "var(--surface0)"}`, opacity: intg.enabled ? 1 : 0.6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 20 }}>{tmpl.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{intg.name}</div>
                        <div style={{ fontSize: 11, color: "var(--overlay0)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {intg.channel === "telegram" ? `Chat ${(intg.config.chat_id as string) ?? ""}` : (intg.config.url as string) ?? ""}
                        </div>
                      </div>
                      <button onClick={() => startEdit(intg)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                        Edit
                      </button>
                      <button onClick={() => testIntegration(intg)} disabled={testing === key} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                        {testing === key ? "..." : "Test"}
                      </button>
                      <button onClick={() => deleteIntegration(intg)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "flex" }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {testRes && (
                      <div style={{ marginTop: 6, fontSize: 11, color: testRes.ok ? "var(--green)" : "var(--red)", display: "flex", alignItems: "center", gap: 4 }}>
                        {testRes.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                        {testRes.message}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Editing / adding form */}
              {editingId !== null && (() => {
                const tmpl = getTemplate(editType);
                return (
                  <div style={{ marginTop: 8, padding: "16px 18px", borderRadius: 10, background: "var(--mantle)", border: "1px solid var(--surface0)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                      <span style={{ fontSize: 18 }}>{tmpl.icon}</span>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{tmpl.label}</span>
                    </div>

                    {/* Name */}
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4 }}>Name</label>
                      <input
                        value={editForm.__name__ ?? ""}
                        onChange={(e) => setEditForm((f) => ({ ...f, __name__: e.target.value }))}
                        placeholder={tmpl.label}
                        style={{ width: "100%", padding: "8px 12px", borderRadius: 8, background: "var(--surface0)", border: "1px solid var(--surface1)", color: "var(--text)", fontSize: 13, outline: "none", fontFamily: "var(--font-sans)", boxSizing: "border-box" }}
                      />
                    </div>

                    {/* Dynamic fields */}
                    {tmpl.fields.map((f) => (
                      <div key={f.key} style={{ marginBottom: 10 }}>
                        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4 }}>
                          {f.label}
                        </label>
                        {"description" in f && f.description && (
                          <p style={{ fontSize: 11, color: "var(--overlay0)", margin: "0 0 4px" }}>{f.description}</p>
                        )}
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input
                            type={f.secret && !visibleFields[f.key] ? "password" : "text"}
                            value={editForm[f.key] ?? ""}
                            onChange={(e) => setEditForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                            placeholder={f.placeholder}
                            style={{ flex: 1, padding: "8px 12px", borderRadius: 8, background: "var(--surface0)", border: "1px solid var(--surface1)", color: "var(--text)", fontSize: 13, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
                          />
                          {f.secret && (
                            <button onClick={() => setVisibleFields((v) => ({ ...v, [f.key]: !v[f.key] }))} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--subtext0)", padding: 4 }}>
                              {visibleFields[f.key] ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}

                    {/* Telegram setup guide */}
                    {editType === "telegram" && <TelegramGuide />}

                    {/* Actions */}
                    <div style={{ display: "flex", gap: 6, marginTop: 16 }}>
                      <button onClick={saveIntegration} disabled={saving} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 16px", borderRadius: 8, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)" }}>
                        {saving ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={14} />}
                        Save
                      </button>
                      <button onClick={() => setEditingId(null)} style={{ padding: "7px 16px", borderRadius: 8, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* ── Add Integration Modal ── */}
            {showAddModal && (
              <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
                <div style={{ width: "100%", maxWidth: 560, maxHeight: "80vh", background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                  <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-heading)" }}>Add Integration</div>
                    <button onClick={() => setShowAddModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", fontSize: 16 }}>
                      <X size={18} />
                    </button>
                  </div>
                  <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
                    {CATEGORIES.map((cat) => {
                      const items = INTEGRATION_TEMPLATES.filter((t) => t.category === cat.id);
                      if (items.length === 0) return null;
                      return (
                        <div key={cat.id} style={{ marginBottom: 16 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>{cat.label}</div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
                            {items.map((tmpl) => (
                              <button key={tmpl.type} onClick={() => selectTemplate(tmpl.type)} style={{
                                padding: "14px 12px", borderRadius: 10, border: "1px solid var(--surface1)", background: "var(--surface0)",
                                cursor: "pointer", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                                transition: "border-color 0.15s",
                              }}>
                                <span style={{ fontSize: 24 }}>{tmpl.icon}</span>
                                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{tmpl.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* ── Notification Preferences Matrix ── */}
            {prefsLoaded && (
              <div style={{ marginTop: 32 }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-heading)", marginBottom: 4 }}>
                  Notification Preferences
                </h2>
                <p style={{ fontSize: 13, color: "var(--subtext0)", marginBottom: 20 }}>
                  Choose which events are sent to each channel.
                </p>

                <div style={{
                  background: "var(--mantle)", border: "1px solid var(--surface0)",
                  borderRadius: 12, overflow: "hidden",
                }}>
                  {/* Header row */}
                  <div style={{
                    display: "grid", gridTemplateColumns: "1fr repeat(3, 80px)",
                    padding: "10px 18px", borderBottom: "1px solid var(--surface0)",
                    background: "var(--crust)",
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Event</div>
                    {CHANNELS.map((ch) => (
                      <div key={ch.id} style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "center" }}>
                        {ch.label}
                      </div>
                    ))}
                  </div>

                  {/* Event groups */}
                  {EVENT_GROUPS.map((group) => (
                    <div key={group.label}>
                      <div style={{
                        padding: "8px 18px", fontSize: 10, fontWeight: 700,
                        color: "var(--overlay0)", textTransform: "uppercase",
                        letterSpacing: "0.08em", background: "var(--surface0)",
                        borderBottom: "1px solid var(--surface0)",
                      }}>
                        {group.label}
                      </div>

                      {group.events.map((evt) => {
                        const platformEnabled = isEventEnabled(evt.type);
                        return (
                          <div key={evt.type} style={{
                            display: "grid", gridTemplateColumns: "1fr repeat(3, 80px)",
                            padding: "8px 18px", borderBottom: "1px solid var(--surface0)",
                            alignItems: "center",
                            opacity: platformEnabled ? 1 : 0.35,
                            pointerEvents: platformEnabled ? "auto" : "none",
                          }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 13, color: platformEnabled ? "var(--text)" : "var(--overlay0)" }}>{evt.label}</span>
                              {!platformEnabled && <span style={{ fontSize: 9, fontWeight: 600, color: "var(--overlay0)", padding: "1px 5px", borderRadius: 4, background: "var(--surface1)" }}>OFF</span>}
                            </div>
                            {CHANNELS.map((ch) => {
                              const val = getPref(evt.type, ch.id);
                              const key: PrefKey = `${evt.type}:${ch.id}`;
                              const isToggling = toggling === key;
                              return (
                                <div key={ch.id} style={{ textAlign: "center" }}>
                                  <button
                                    onClick={() => togglePref(evt.type, ch.id, val)}
                                    disabled={isToggling}
                                    style={{
                                      width: 36, height: 20, borderRadius: 10, border: "none",
                                      background: val ? "var(--blue)" : "var(--surface1)",
                                      cursor: isToggling ? "not-allowed" : "pointer",
                                      position: "relative", transition: "background 0.15s",
                                      opacity: isToggling ? 0.5 : 1,
                                    }}
                                  >
                                    <div style={{
                                      width: 14, height: 14, borderRadius: "50%",
                                      background: "#fff", position: "absolute",
                                      top: 3, left: val ? 19 : 3,
                                      transition: "left 0.15s",
                                      boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                                    }} />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}
    </IntegrationsShell>
  );
}
