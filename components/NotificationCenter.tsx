"use client";

import React, { useEffect, useState, useCallback } from "react";
import { X, CheckCheck, Trash2, AlertTriangle, AlertCircle, Info, Circle, Bell } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";

interface Notification {
  id: string;
  event_type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

const SEV_ICON: Record<string, { icon: React.FC<{ size?: number; style?: React.CSSProperties }>; color: string }> = {
  info:     { icon: Info,           color: "var(--blue)" },
  warning:  { icon: AlertTriangle,  color: "var(--peach)" },
  critical: { icon: AlertCircle,    color: "var(--red)" },
};

function timeAgo(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

type Tab = "all" | "unread" | "critical";

export default function NotificationCenter({
  onClose,
  onCountChange,
}: {
  onClose: () => void;
  onCountChange: (count: number) => void;
}) {
  const { session, tenantId } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("all");

  const fetchNotifications = useCallback(async () => {
    if (!session || !tenantId) return;
    setLoading(true);
    const params = new URLSearchParams({ tenantId, limit: "30" });
    if (tab === "unread") params.set("unread", "true");
    const res = await fetch(`/api/notifications?${params}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      const body = await res.json() as { notifications: Notification[] };
      setNotifications(body.notifications);
    }
    setLoading(false);
  }, [session, tenantId, tab]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  async function markRead(id: string) {
    if (!session) return;
    await fetch(`/api/notifications/${id}/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
    onCountChange(notifications.filter((n) => n.read_at === null && n.id !== id).length);
  }

  async function markAllRead() {
    if (!session || !tenantId) return;
    await fetch("/api/notifications/read-all", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    onCountChange(0);
  }

  async function deleteOne(id: string) {
    if (!session) return;
    await fetch(`/api/notifications/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    onCountChange(notifications.filter((n) => n.read_at === null && n.id !== id).length);
  }

  async function clearAll() {
    if (!session || !tenantId) return;
    await fetch("/api/notifications/clear-all", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    setNotifications([]);
    onCountChange(0);
  }

  const filtered = tab === "critical"
    ? notifications.filter((n) => n.severity === "critical")
    : notifications;

  return (
    <div style={{
      position: "fixed", top: 0, right: 0, bottom: 0, width: 380, maxWidth: "100vw",
      background: "var(--mantle)", borderLeft: "1px solid var(--surface0)",
      boxShadow: "-8px 0 32px rgba(0,0,0,0.3)",
      zIndex: 2000, display: "flex", flexDirection: "column",
      fontFamily: "var(--font-sans)", color: "var(--text)",
    }}>
      {/* Header */}
      <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, fontSize: 16, fontWeight: 700, fontFamily: "var(--font-heading)" }}>Notifications</div>
        <button onClick={markAllRead} title="Mark all read" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", display: "flex", padding: 4 }}>
          <CheckCheck size={16} />
        </button>
        <button onClick={clearAll} title="Clear all" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", display: "flex", padding: 4 }}>
          <Trash2 size={16} />
        </button>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", display: "flex", padding: 4 }}>
          <X size={16} />
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--surface0)" }}>
        {(["all", "unread", "critical"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: "8px 0", border: "none", background: "transparent",
            color: tab === t ? "var(--text)" : "var(--overlay0)",
            fontSize: 12, fontWeight: tab === t ? 700 : 500,
            cursor: "pointer", fontFamily: "var(--font-sans)",
            borderBottom: tab === t ? "2px solid var(--blue)" : "2px solid transparent",
            textTransform: "capitalize",
          }}>
            {t}
          </button>
        ))}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading && (
          <div style={{ textAlign: "center", padding: 32, color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: 40, color: "var(--overlay0)" }}>
            <Bell size={28} style={{ marginBottom: 8, opacity: 0.3 }} />
            <div style={{ fontSize: 13 }}>No notifications</div>
          </div>
        )}
        {!loading && filtered.map((n) => {
          const sev = SEV_ICON[n.severity] ?? SEV_ICON.info;
          const SevIcon = sev.icon;
          const isUnread = !n.read_at;
          return (
            <div
              key={n.id}
              className="notif-card"
              style={{
                display: "flex", alignItems: "flex-start", gap: 10,
                width: "100%", padding: "12px 18px",
                background: isUnread ? "rgba(20,99,255,0.03)" : "transparent",
                borderBottom: "1px solid var(--surface0)",
                cursor: isUnread ? "pointer" : "default",
                textAlign: "left", fontFamily: "var(--font-sans)",
                color: "inherit", position: "relative",
              }}
              onClick={() => { if (isUnread) markRead(n.id); }}
            >
              {/* Unread dot */}
              <div style={{ width: 8, paddingTop: 5, flexShrink: 0 }}>
                {isUnread && <Circle size={7} fill="var(--blue)" color="var(--blue)" />}
              </div>
              {/* Icon */}
              <div style={{ flexShrink: 0, marginTop: 1 }}>
                <SevIcon size={15} style={{ color: sev.color }} />
              </div>
              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: isUnread ? 700 : 500, color: isUnread ? "var(--text)" : "var(--subtext1)", marginBottom: 2 }}>
                  {n.title}
                </div>
                {n.body && (
                  <div style={{ fontSize: 12, color: "var(--subtext0)", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {n.body}
                  </div>
                )}
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 3 }}>
                  {timeAgo(n.created_at)}
                </div>
              </div>
              {/* Delete */}
              <button
                onClick={(e) => { e.stopPropagation(); deleteOne(n.id); }}
                title="Delete"
                style={{
                  position: "absolute", top: 8, right: 8,
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--overlay0)", padding: 2, display: "flex",
                  opacity: 0.4, transition: "opacity 0.15s",
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = "1"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = "0.4"; }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
