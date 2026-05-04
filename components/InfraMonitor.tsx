"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

/* ─── Types ──────────────────────────────────────────────── */

interface ServiceStatus {
  name: string;
  status: "ok" | "degraded" | "down" | "checking";
  latency?: number;
}

interface GitHubActivity {
  id: string;
  repo: string;
  action: string;
  ref?: string;
  agent?: string;
  message?: string;
  timestamp: string;
}

/* ─── Fetch health from server-side API route ────────────── */

async function fetchHealth(): Promise<ServiceStatus[]> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) throw new Error("health check failed");
    const data = await res.json();
    return data.services as ServiceStatus[];
  } catch {
    return [];
  }
}

/* ─── Status Dot ─────────────────────────────────────────── */

function StatusDot({ status }: { status: ServiceStatus["status"] }) {
  const color =
    status === "ok" ? "var(--green)"
      : status === "degraded" ? "var(--yellow)"
        : status === "checking" ? "var(--overlay0)"
          : "var(--red)";
  return (
    <div
      className={status === "checking" ? "pulse" : undefined}
      style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }}
    />
  );
}

/* ─── Compact mode ───────────────────────────────────────── */
// In compact mode: single-row inline summary, probed once on mount, no interval, no subscription.

function InfraCompact() {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    fetchHealth().then((s) => { setServices(s); setReady(true); });
  }, []);

  const okCount = services.filter((s) => s.status === "ok").length;
  const allOk = okCount === services.length && services.length > 0;

  return (
    <div style={{
      background: "var(--surface0)", border: "1px solid var(--surface1)",
      borderRadius: 12, padding: "10px 16px",
      display: "flex", alignItems: "center", gap: 16,
    }}>
      <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.4px", fontWeight: 600, color: "var(--overlay0)" }}>Infra</span>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1 }}>
        {ready && services.map((s) => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <StatusDot status={s.status} />
            <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{s.name}</span>
          </div>
        ))}
        {!ready && (
          <span className="pulse" style={{ fontSize: 10, color: "var(--overlay0)" }}>checking...</span>
        )}
      </div>
      {ready && (
        allOk
          ? <span style={{ fontSize: 10, color: "var(--green)" }}>all ok</span>
          : <span style={{ fontSize: 10, color: "var(--yellow)" }}>{okCount}/{services.length}</span>
      )}
    </div>
  );
}

/* ─── GitHub Activity Feed ───────────────────────────────── */

function GitHubFeed({ activities }: { activities: GitHubActivity[] }) {
  if (activities.length === 0) {
    return (
      <div style={{ color: "var(--overlay0)", fontSize: 12, textAlign: "center", padding: "12px 0" }}>
        No GitHub activity yet. Agent outputs will appear here.
      </div>
    );
  }

  const actionIcon: Record<string, string> = {
    commit: "●", pr_opened: "⊕", pr_merged: "⊛", branch_created: "⑂",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 192, overflowY: "auto" }}>
      {activities.map((a) => (
        <div key={a.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 }}>
          <span style={{ color: "var(--mauve)", marginTop: 2 }}>{actionIcon[a.action] ?? "·"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ color: "var(--subtext0)", fontFamily: "var(--font-mono)" }}>{a.repo.split("/")[1]}</span>
            {a.agent && <span style={{ color: "var(--overlay0)", marginLeft: 4 }}>via {a.agent}</span>}
            {a.message && <span style={{ color: "var(--overlay0)", marginLeft: 4 }} className="truncate">{a.message}</span>}
          </div>
          <span style={{ color: "var(--overlay0)", whiteSpace: "nowrap" }}>
            {new Date(a.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ─── Full mode ──────────────────────────────────────────── */

function InfraFull() {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [ghActivity, setGhActivity] = useState<GitHubActivity[]>([]);
  const [lastCheck, setLastCheck] = useState<Date | null>(null);
  const [checking, setChecking] = useState(false);

  const runProbes = useCallback(async () => {
    setChecking(true);
    const results = await fetchHealth();
    setServices(results);
    setLastCheck(new Date());
    setChecking(false);
  }, []);

  // Initial probe + 5-minute interval (was 60s — overkill for health checks)
  useEffect(() => {
    runProbes();
    const interval = setInterval(runProbes, 5 * 60_000);
    return () => clearInterval(interval);
  }, [runProbes]);

  // Realtime subscription for GitHub activity — only in full mode
  useEffect(() => {
    async function fetchGitHubEvents() {
      const { data } = await supabase
        .from("agent_events")
        .select("*, agent_runs!inner(agent)")
        .in("event_type", ["completed", "output"])
        .order("created_at", { ascending: false })
        .limit(20);

      if (data) {
        const activities: GitHubActivity[] = data
          .filter((e: Record<string, unknown>) => {
            const payload = e.payload as Record<string, unknown>;
            return payload?.github_ref || payload?.repo;
          })
          .map((e: Record<string, unknown>) => {
            const payload = e.payload as Record<string, unknown>;
            const ghRef = payload.github_ref as Record<string, unknown> | undefined;
            return {
              id: e.id as string,
              repo: (ghRef?.repo as string) ?? (payload.repo as string) ?? "unknown",
              action: (ghRef?.pr as number) ? "pr_opened" : "commit",
              ref: ghRef?.commit as string | undefined,
              agent: ((e as Record<string, unknown>).agent_runs as Record<string, unknown>)?.agent as string | undefined,
              message: payload.spec_id as string | undefined,
              timestamp: e.created_at as string,
            };
          });
        setGhActivity(activities);
      }
    }
    fetchGitHubEvents();

    const channel = supabase
      .channel("infra-github")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_events" }, (payload) => {
        const evt = payload.new as Record<string, unknown>;
        const p = evt.payload as Record<string, unknown>;
        if (p?.github_ref || p?.repo) {
          const ghRef = p.github_ref as Record<string, unknown> | undefined;
          setGhActivity((prev) => [
            {
              id: evt.id as string,
              repo: (ghRef?.repo as string) ?? (p.repo as string) ?? "unknown",
              action: (ghRef?.pr as number) ? "pr_opened" : "commit",
              ref: ghRef?.commit as string | undefined,
              agent: p.agent as string | undefined,
              message: p.spec_id as string | undefined,
              timestamp: evt.created_at as string,
            },
            ...prev.slice(0, 19),
          ]);
        }
      })
      .subscribe();

    return () => { channel.unsubscribe().then(() => supabase.removeChannel(channel)); };
  }, []);

  const okCount = services.filter((s) => s.status === "ok").length;
  const allOk = okCount === services.length && services.length > 0;

  return (
    <div style={{
      background: "var(--surface0)", border: "1px solid var(--surface1)",
      borderRadius: 12, padding: 20,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.4px" }}>Infrastructure</h2>
          {checking
            ? <span className="pulse" style={{ fontSize: 10, color: "var(--overlay0)" }}>checking...</span>
            : allOk
              ? <span style={{ fontSize: 10, color: "var(--green)" }}>all systems operational</span>
              : services.length > 0
                ? <span style={{ fontSize: 10, color: "var(--yellow)" }}>{okCount}/{services.length} operational</span>
                : null
          }
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {lastCheck && (
            <span style={{ fontSize: 10, color: "var(--overlay0)" }}>
              {lastCheck.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          )}
          <button
            onClick={runProbes}
            style={{ fontSize: 10, cursor: "pointer", color: "var(--overlay0)", background: "none", border: "none", fontFamily: "var(--font-sans)" }}
          >
            ↻ refresh
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <div>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.4px", color: "var(--overlay0)", marginBottom: 8 }}>Cloud Platforms</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {services.map((s) => (
              <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <StatusDot status={s.status} />
                <span style={{ fontSize: 12, color: "var(--subtext0)", flex: 1 }}>{s.name}</span>
                {s.latency !== undefined && (
                  <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: s.latency > 1000 ? "var(--yellow)" : "var(--overlay0)" }}>
                    {s.latency}ms
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.4px", color: "var(--overlay0)", marginBottom: 8 }}>GitHub Activity</div>
          <GitHubFeed activities={ghActivity} />
        </div>
      </div>
    </div>
  );
}

/* ─── Export ─────────────────────────────────────────────── */

export default function InfraMonitor({ compact }: { compact?: boolean } = {}) {
  return compact ? <InfraCompact /> : <InfraFull />;
}
