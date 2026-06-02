"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Bell, ToggleLeft, ToggleRight, Save, Check, AlertCircle, Zap, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface EventConfig {
  event_type: string;
  enabled: boolean;
  label: string;
  description: string | null;
  severity: string;
  group_name: string;
  display_order: number;
}

const SEV_COLOR: Record<string, string> = {
  info: "var(--blue)",
  warning: "var(--peach)",
  critical: "var(--red)",
};

type AdminTab = "tenant-events" | "platform-ops" | "activity";

const TELEGRAM_FIELDS = [
  { key: "TELEGRAM_BOT_TOKEN", label: "Bot token", placeholder: "123456:ABC-..." },
  { key: "TELEGRAM_CHAT_ID", label: "Chat ID", placeholder: "-100123456789" },
];

export default function AdminNotificationsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<AdminTab>("tenant-events");
  const [events, setEvents] = useState<EventConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  // Platform Telegram config
  const [tgValues, setTgValues] = useState<Record<string, string>>({});
  const [tgSaving, setTgSaving] = useState(false);
  const [tgTesting, setTgTesting] = useState(false);
  const [tgSaved, setTgSaved] = useState(false);
  const [tgTestResult, setTgTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Platform activity log
  interface PlatformNotification {
    id: string; event_type: string; severity: string; title: string; body: string | null; read_at: string | null; created_at: string;
  }
  const [platformNotifs, setPlatformNotifs] = useState<PlatformNotification[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  async function loadActivity() {
    setActivityLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const { data: owner } = await supabase.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
    if (!owner) return;
    const res = await fetch(`/api/notifications?tenantId=${owner.id}&scope=platform&limit=50`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      const body = await res.json() as { notifications: PlatformNotification[] };
      setPlatformNotifs(body.notifications);
    }
    setActivityLoading(false);
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { router.replace("/login"); return; }
      const res = await fetch("/api/admin/notifications", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const body = await res.json() as { events: EventConfig[] };
        setEvents(body.events);
      }
      setLoading(false);
    });
  }, [router]);

  // Load platform Telegram config
  const loadTgConfig = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    // Platform telegram uses the owner tenant's integrations with service_id "platform_telegram"
    const { data: owner } = await supabase.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
    if (!owner) return;
    const res = await fetch(`/api/settings/integrations?tenantId=${owner.id}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      const body = await res.json() as { configured?: string[] };
      // Check if platform telegram is configured
      for (const key of TELEGRAM_FIELDS) {
        if ((body.configured ?? []).includes(`platform_telegram:${key.key}`)) {
          setTgValues((v) => ({ ...v, [key.key]: "••••••" }));
        }
      }
    }
  }, []);

  useEffect(() => { loadTgConfig(); }, [loadTgConfig]);

  async function toggle(eventType: string) {
    const evt = events.find((e) => e.event_type === eventType);
    if (!evt) return;
    setToggling(eventType);
    const newEnabled = !evt.enabled;
    setEvents((prev) => prev.map((e) => e.event_type === eventType ? { ...e, enabled: newEnabled } : e));
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      await fetch("/api/admin/notifications", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ eventType, enabled: newEnabled }),
      });
    }
    setToggling(null);
  }

  async function saveTelegram() {
    setTgSaving(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const { data: owner } = await supabase.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
    if (!owner) return;
    // Save as platform_telegram service
    for (const field of TELEGRAM_FIELDS) {
      if (tgValues[field.key] && !tgValues[field.key].startsWith("••")) {
        await fetch("/api/settings/integrations", {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId: owner.id, serviceId: "platform_telegram", keys: { [field.key]: tgValues[field.key] } }),
        });
      }
    }
    setTgSaving(false);
    setTgSaved(true);
    setTimeout(() => setTgSaved(false), 2000);
  }

  async function testTelegram() {
    setTgTesting(true);
    setTgTestResult(null);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setTgTesting(false); return; }
    const { data: owner } = await supabase.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
    if (!owner) { setTgTesting(false); return; }
    const res = await fetch("/api/settings/integrations/test", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: owner.id, serviceId: "platform_telegram" }),
    });
    const body = await res.json() as { ok?: boolean; error?: string };
    setTgTestResult({ ok: !!body.ok, message: body.ok ? "Test message sent!" : (body.error ?? "Failed") });
    setTgTesting(false);
  }

  // Separate tenant events from platform ops
  const tenantEvents = events.filter((e) => e.group_name !== "devops");
  const platformEvents = events.filter((e) => e.group_name === "devops");

  function groupEvents(list: EventConfig[]) {
    const groups = new Map<string, EventConfig[]>();
    for (const e of list) {
      if (!groups.has(e.group_name)) groups.set(e.group_name, []);
      groups.get(e.group_name)!.push(e);
    }
    return groups;
  }

  function renderEventList(list: EventConfig[]) {
    const groups = groupEvents(list);
    return (
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 12, overflow: "hidden" }}>
        {[...groups.entries()].map(([groupName, groupEvents]) => (
          <div key={groupName}>
            <div style={{ padding: "8px 18px", fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.08em", background: "var(--surface0)", borderBottom: "1px solid var(--surface0)" }}>
              {groupName}
            </div>
            {groupEvents.map((evt) => (
              <div key={evt.event_type} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 18px", borderBottom: "1px solid var(--surface0)" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: evt.enabled ? "var(--text)" : "var(--overlay0)" }}>{evt.label}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4, background: `${SEV_COLOR[evt.severity] ?? "var(--overlay0)"}15`, color: SEV_COLOR[evt.severity] ?? "var(--overlay0)", textTransform: "uppercase" }}>
                      {evt.severity}
                    </span>
                  </div>
                  {evt.description && <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 2 }}>{evt.description}</div>}
                </div>
                <button onClick={() => toggle(evt.event_type)} disabled={toggling === evt.event_type}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", opacity: toggling === evt.event_type ? 0.4 : 1 }}>
                  {evt.enabled ? <ToggleRight size={24} color="var(--green)" /> : <ToggleLeft size={24} color="var(--overlay0)" />}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "9px 12px", borderRadius: 8,
    background: "var(--surface0)", border: "1px solid var(--surface1)",
    color: "var(--text)", fontSize: 13, outline: "none", fontFamily: "var(--font-sans)",
  };

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "40px 28px 80px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <Bell size={22} color="var(--blue)" />
        <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--font-heading)", margin: 0 }}>Notification Events</h1>
      </div>
      <p style={{ fontSize: 13, color: "var(--subtext0)", marginBottom: 24 }}>
        Manage notification events for tenants and platform operations.
      </p>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--surface0)", marginBottom: 24 }}>
        {([
          { id: "tenant-events" as AdminTab, label: "Tenant Events" },
          { id: "platform-ops" as AdminTab, label: "Platform Ops" },
          { id: "activity" as AdminTab, label: "Activity" },
        ]).map((t) => (
          <button key={t.id} onClick={() => { setTab(t.id); if (t.id === "activity" && platformNotifs.length === 0) loadActivity(); }} style={{
            padding: "9px 20px", border: "none", background: "transparent",
            color: tab === t.id ? "var(--text)" : "var(--overlay0)",
            fontSize: 13, fontWeight: tab === t.id ? 700 : 500,
            cursor: "pointer", fontFamily: "var(--font-sans)",
            borderBottom: tab === t.id ? "2px solid var(--blue)" : "2px solid transparent",
            marginBottom: -1,
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>
      ) : tab === "tenant-events" ? (
        <div>
          <p style={{ fontSize: 13, color: "var(--subtext0)", marginBottom: 16 }}>
            Control which events are available to tenants. Disabled events are hidden from tenant notification preferences.
          </p>
          {renderEventList(tenantEvents)}
        </div>
      ) : tab === "platform-ops" ? (
        <div>
          <p style={{ fontSize: 13, color: "var(--subtext0)", marginBottom: 16 }}>
            Platform operations events — visible only to the platform owner.
          </p>

          {/* Platform Telegram config */}
          <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 12, padding: "18px 20px", marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Platform Telegram</div>
            <p style={{ fontSize: 12, color: "var(--subtext0)", marginBottom: 14 }}>
              Separate from tenant Telegram. Receives platform ops alerts (deploys, health, etc).
            </p>
            {TELEGRAM_FIELDS.map((f) => (
              <div key={f.key} style={{ marginBottom: 10 }}>
                <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4 }}>{f.label}</label>
                <input
                  value={tgValues[f.key] ?? ""}
                  onChange={(e) => setTgValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  style={inputStyle}
                />
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={testTelegram} disabled={tgTesting} style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 14px", borderRadius: 8, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext1)", fontSize: 12, fontWeight: 600, cursor: tgTesting ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)" }}>
                {tgTesting ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Zap size={13} />} Test
              </button>
              <button onClick={saveTelegram} disabled={tgSaving} style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 14px", borderRadius: 8, border: "none", background: tgSaved ? "rgba(28,191,107,0.12)" : "var(--blue)", color: tgSaved ? "var(--green)" : "#fff", fontSize: 12, fontWeight: 700, cursor: tgSaving ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)" }}>
                {tgSaved ? <><Check size={13} /> Saved</> : <><Save size={13} /> Save</>}
              </button>
              {tgTestResult && (
                <span style={{ fontSize: 11, color: tgTestResult.ok ? "var(--green)" : "var(--red)", display: "flex", alignItems: "center", gap: 4 }}>
                  {tgTestResult.ok ? <Check size={12} /> : <AlertCircle size={12} />} {tgTestResult.message}
                </span>
              )}
            </div>
          </div>

          {/* GitHub Webhook setup */}
          <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 12, padding: "18px 20px", marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>GitHub Webhook</div>
            <p style={{ fontSize: 12, color: "var(--subtext0)", marginBottom: 12 }}>
              Receives CI/CD workflow events (deploy, publish, failures).
            </p>
            <div style={{ fontSize: 12, color: "var(--subtext1)", lineHeight: 1.7 }}>
              <div style={{ marginBottom: 8 }}>
                <strong>1.</strong> Go to your GitHub repo → <strong>Settings → Webhooks → Add webhook</strong>
              </div>
              <div style={{ marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--overlay0)" }}>Payload URL</span>
                <div style={{ background: "var(--surface0)", borderRadius: 6, padding: "7px 10px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--teal)", marginTop: 2, userSelect: "all" }}>
                  {typeof window !== "undefined" ? `${window.location.origin}/api/webhooks/github` : "/api/webhooks/github"}
                </div>
              </div>
              <div style={{ marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--overlay0)" }}>Content type</span>
                <div style={{ fontSize: 12, color: "var(--text)", marginTop: 2 }}>application/json</div>
              </div>
              <div style={{ marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: "var(--overlay0)" }}>Events</span>
                <div style={{ fontSize: 12, color: "var(--text)", marginTop: 2 }}>Select &quot;Let me select individual events&quot; → check <strong>Workflow runs</strong> only</div>
              </div>
            </div>
            <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, background: "rgba(20,99,255,0.06)", border: "1px solid rgba(20,99,255,0.15)", fontSize: 11, color: "var(--subtext0)", lineHeight: 1.6 }}>
              <strong style={{ color: "var(--blue)" }}>Mapped workflows:</strong> publish-cli.yml → <code style={{ fontSize: 10, color: "var(--teal)" }}>deploy_cli</code> · publish-worker.yml → <code style={{ fontSize: 10, color: "var(--teal)" }}>deploy_workers</code> · ci.yml → <code style={{ fontSize: 10, color: "var(--teal)" }}>github_action_success</code> · Any failure → <code style={{ fontSize: 10, color: "var(--red)" }}>github_action_failed</code>
            </div>
          </div>

          {/* Health Check setup */}
          <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 12, padding: "18px 20px", marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Health Check</div>
            <p style={{ fontSize: 12, color: "var(--subtext0)", marginBottom: 12 }}>
              Monitors Supabase, Vercel, and Trigger.dev connectivity. Call periodically via cron.
            </p>
            <div style={{ marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--overlay0)" }}>Endpoint</span>
              <div style={{ background: "var(--surface0)", borderRadius: 6, padding: "7px 10px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--teal)", marginTop: 2, userSelect: "all" }}>
                POST {typeof window !== "undefined" ? `${window.location.origin}/api/webhooks/health-check?token=YOUR_SECRET` : "/api/webhooks/health-check?token=YOUR_SECRET"}
              </div>
            </div>
            <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 8, lineHeight: 1.6 }}>
              Set <code style={{ fontSize: 10, color: "var(--teal)", background: "var(--surface0)", padding: "1px 4px", borderRadius: 3 }}>HEALTH_CHECK_SECRET</code> as env var on your deployment. Call every 5 minutes via external cron or Vercel Cron.
            </div>
          </div>

          {/* Platform ops events */}
          {renderEventList(platformEvents)}
        </div>
      ) : tab === "activity" ? (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: "var(--subtext0)", margin: 0 }}>
              Platform operations activity log.
            </p>
            <button onClick={loadActivity} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext1)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
              Refresh
            </button>
          </div>
          {activityLoading ? (
            <div style={{ color: "var(--overlay0)", fontSize: 13, padding: 20, textAlign: "center" }}>Loading…</div>
          ) : platformNotifs.length === 0 ? (
            <div style={{ color: "var(--overlay0)", fontSize: 13, padding: 32, textAlign: "center", background: "var(--mantle)", borderRadius: 12, border: "1px solid var(--surface0)" }}>
              No platform activity yet. Events will appear here when deploys, health checks, and admin actions occur.
            </div>
          ) : (
            <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 12, overflow: "hidden" }}>
              {platformNotifs.map((n) => (
                <div key={n.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 18px", borderBottom: "1px solid var(--surface0)" }}>
                  <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>
                    {n.severity === "critical" ? "🚨" : n.severity === "warning" ? "⚠️" : "ℹ️"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{n.title}</div>
                    {n.body && <div style={{ fontSize: 12, color: "var(--subtext0)", marginTop: 2 }}>{n.body}</div>}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--overlay0)", flexShrink: 0, whiteSpace: "nowrap" }}>
                    {new Date(n.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
