"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Power, PowerOff, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface MaintenanceStatus {
  maintenanceMode: boolean;
  since:           string | null;
}

function formatSince(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function MaintenancePage() {
  const [status,    setStatus]    = useState<MaintenanceStatus | null>(null);
  const [fetching,  setFetching]  = useState(true);
  const [toggling,  setToggling]  = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [success,   setSuccess]   = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    setFetching(true);
    try {
      const res = await fetch("/api/admin/maintenance", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) setStatus(await res.json() as MaintenanceStatus);
      else setError("Could not load maintenance status.");
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  async function toggle(action: "enable" | "disable") {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    setToggling(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/admin/maintenance", {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ action }),
      });
      if (res.ok) {
        const body = await res.json() as { maintenanceMode: boolean };
        setStatus({ maintenanceMode: body.maintenanceMode, since: body.maintenanceMode ? new Date().toISOString() : null });
        setConfirmed(false);
        setSuccess(body.maintenanceMode ? "Maintenance mode enabled. All tenants are now redirected." : "Maintenance mode disabled. Platform is live again.");
        setTimeout(() => setSuccess(null), 5000);
      } else {
        const b = await res.json() as { error?: string };
        setError(b.error ?? "Failed to toggle maintenance mode.");
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setToggling(false);
    }
  }

  const isOn = status?.maintenanceMode ?? false;

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "40px 28px 80px" }}>

      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--font-heading)", marginBottom: 4 }}>Maintenance Mode</h1>
        <p style={{ fontSize: 13, color: "var(--subtext0)" }}>Control platform-wide access for all tenants.</p>
      </div>

      {/* Status card */}
      <div style={{
        background: "var(--mantle)",
        border: `1px solid ${isOn ? "rgba(239,68,68,0.35)" : "var(--surface1)"}`,
        borderRadius: 14,
        overflow: "hidden",
        marginBottom: 20,
      }}>
        {/* Card header */}
        <div style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${isOn ? "rgba(239,68,68,0.2)" : "var(--surface0)"}`,
          background: isOn ? "rgba(239,68,68,0.05)" : "transparent",
          display: "flex", alignItems: "center", gap: 12,
        }}>
          {isOn
            ? <PowerOff size={18} color="#ef4444" strokeWidth={2} />
            : <Power    size={18} color="var(--green)" strokeWidth={1.5} />}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              {fetching ? "Loading…" : isOn ? "Platform is in maintenance" : "Platform is live"}
            </div>
            {isOn && status?.since && (
              <div style={{ fontSize: 12, color: "#ef4444", marginTop: 2 }}>
                Active since {formatSince(status.since)}
              </div>
            )}
            {!isOn && !fetching && (
              <div style={{ fontSize: 12, color: "var(--subtext0)", marginTop: 2 }}>
                All tenants have full access
              </div>
            )}
          </div>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99,
            background: fetching ? "var(--surface1)" : isOn ? "rgba(239,68,68,0.12)" : "rgba(28,191,107,0.12)",
            color:      fetching ? "var(--overlay0)"  : isOn ? "#ef4444" : "var(--green)",
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>
            {fetching ? "…" : isOn ? "ON" : "OFF"}
          </span>
        </div>

        {/* Card body */}
        <div style={{ padding: "20px" }}>
          <p style={{ fontSize: 13, color: "var(--subtext0)", lineHeight: 1.7, marginBottom: 20 }}>
            {isOn
              ? "Maintenance mode is active. All tenant requests are redirected to the maintenance page. As platform admin, your session passes through normally."
              : "Enable maintenance mode to take the platform offline for all tenants. You will retain access via a secure bypass token set in your session."}
          </p>

          {/* Confirm checkbox — only when enabling */}
          {!isOn && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 18, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                style={{ marginTop: 2, accentColor: "#ef4444", cursor: "pointer" }}
              />
              <span style={{ fontSize: 13, color: "var(--subtext1)", lineHeight: 1.6 }}>
                I understand that enabling maintenance mode will immediately block all tenant access to the platform.
              </span>
            </label>
          )}

          {/* Error */}
          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 8, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", fontSize: 13, color: "#ef4444", marginBottom: 16 }}>
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          {/* Success */}
          {success && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 8, background: "rgba(28,191,107,0.08)", border: "1px solid rgba(28,191,107,0.3)", fontSize: 13, color: "var(--green)", marginBottom: 16 }}>
              <CheckCircle2 size={14} /> {success}
            </div>
          )}

          {/* Toggle button */}
          <button
            onClick={() => toggle(isOn ? "disable" : "enable")}
            disabled={toggling || fetching || (!isOn && !confirmed)}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "10px 22px", borderRadius: 9, border: "none",
              background: isOn ? "#1463ff" : "#ef4444",
              color: "#fff", fontSize: 13, fontWeight: 700,
              cursor: (toggling || fetching || (!isOn && !confirmed)) ? "not-allowed" : "pointer",
              opacity: (toggling || fetching || (!isOn && !confirmed)) ? 0.55 : 1,
              fontFamily: "var(--font-sans)",
              transition: "opacity 0.15s",
            }}
          >
            {toggling
              ? <><Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Processing…</>
              : isOn
              ? <><Power size={14} /> Disable Maintenance</>
              : <><PowerOff size={14} /> Enable Maintenance</>}
          </button>
        </div>
      </div>

      {/* Info box */}
      <div style={{ padding: "14px 16px", borderRadius: 10, background: "var(--surface0)", border: "1px solid var(--surface1)", fontSize: 12, color: "var(--overlay1)", lineHeight: 1.7 }}>
        <strong style={{ color: "var(--subtext0)" }}>How it works:</strong> When enabled, a bypass token is stored in your browser session. The platform middleware reads maintenance state from the database (cached 30 s per edge node) and redirects all requests without the token to <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>/maintenance</code>. Disabling clears the state immediately.
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
