"use client";

/**
 * /triggers — unified surface for sprint dispatch sources.
 *
 * Five cards (manual, CLI, API, GitHub webhook, auto-drain) showing per-
 * source counts and last-fired-at across the operator's tenant. Backed
 * by GET /api/triggers/summary which scopes by tenant_members.
 *
 * Configuration of each source still lives in its native UI (Project
 * Settings for auto-drain, Integrations for webhook secrets, etc); this
 * page is the discovery + observability surface, not a config replacement.
 */

import React, { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, MousePointer2, Terminal, Code, Webhook, Bot, AlertCircle,
} from "lucide-react";
import PageShell from "@/components/PageShell";
import { useAuth } from "@/lib/auth-context";

type SourceId = "manual" | "cli" | "api" | "webhook" | "auto_drain";

interface SourceRow {
  id:                SourceId;
  total:             number;
  last_30d:          number;
  last_fired_at:     string | null;
  last_project_name: string | null;
}

interface SourceMeta {
  label:       string;
  description: string;
  Icon:        React.ComponentType<{ size?: number }>;
  accent:      string;
  configHint:  string;
}

const META: Record<SourceId, SourceMeta> = {
  manual: {
    label:       "Manual",
    description: "Operator clicked Start Sprint in the Office.",
    Icon:        MousePointer2,
    accent:      "var(--blue, #1463ff)",
    configHint:  "Always available — no setup needed.",
  },
  cli: {
    label:       "CLI",
    description: "Dispatched via the twin-pilot CLI binary.",
    Icon:        Terminal,
    accent:      "var(--green, #40a02b)",
    configHint:  "Run `twin-pilot login` then `twin-pilot run --project <slug>`.",
  },
  api: {
    label:       "API",
    description: "Programmatic POST to /api/projects/{id}/run.",
    Icon:        Code,
    accent:      "var(--mauve, #cba6f7)",
    configHint:  "Pass an API key in the Authorization header. Generate one in API Keys.",
  },
  webhook: {
    label:       "GitHub Webhook",
    description: "Triggered by a GitHub event (push, workflow_run).",
    Icon:        Webhook,
    accent:      "var(--peach, #f59f00)",
    configHint:  "Coming soon — wire-up tracked. Today the webhook only emits CI notifications.",
  },
  auto_drain: {
    label:       "Auto-Drain",
    description: "Backlog auto-drain cron picks the next todo item.",
    Icon:        Bot,
    accent:      "var(--mauve, #cba6f7)",
    configHint:  "Per-project — toggle Auto-drain in Project Settings on the autonomous-projects card.",
  },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1)   return "just now";
  if (minutes < 60)  return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)    return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30)     return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function TriggersPage() {
  const router = useRouter();
  const { session, loading: authLoading } = useAuth();
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  const reload = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/triggers/summary", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const body = await res.json() as { sources: SourceRow[] };
      setSources(body.sources ?? []);
    } catch (e) { setError((e as Error).message); }
    finally       { setLoading(false); }
  }, [session]);

  useEffect(() => { void reload(); }, [reload]);

  return (
    <PageShell
      active="triggers"
      title="Triggers"
      description="Where sprints come from. Five sources, configured in their own surfaces — this page is the discovery and observability view."
      maxWidth={960}
    >
      {error && (
        <div style={{
          marginBottom: 16, padding: "10px 14px", borderRadius: 8,
          background: "rgba(243,139,168,0.08)", border: "1px solid rgba(243,139,168,0.25)",
          color: "var(--red)", fontSize: 12, display: "flex", alignItems: "center", gap: 8,
        }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--overlay0)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Loading…
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          {sources.map((src) => {
            const meta = META[src.id];
            const { Icon } = meta;
            return (
              <div
                key={src.id}
                style={{
                  borderRadius: 10, background: "var(--surface0)",
                  border: "1px solid var(--surface1)",
                  padding: "14px 16px",
                  display: "flex", flexDirection: "column", gap: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 28, height: 28, borderRadius: 6,
                    background: `${meta.accent}1a`, color: meta.accent,
                  }}>
                    <Icon size={14} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{meta.label}</div>
                    <div style={{ fontSize: 11, color: "var(--overlay0)", lineHeight: 1.4 }}>
                      {meta.description}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
                  <Stat label="Last 30d" value={src.last_30d.toString()} />
                  <Stat label="Total"    value={src.total.toString()} />
                  <Stat label="Last fired" value={fmtDate(src.last_fired_at)} />
                </div>

                {src.last_project_name && (
                  <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 2 }}>
                    Last: <strong>{src.last_project_name}</strong>
                  </div>
                )}

                <div style={{
                  fontSize: 10, color: "var(--overlay0)", lineHeight: 1.45,
                  marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--surface1)",
                }}>
                  {meta.configHint}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {value}
      </div>
    </div>
  );
}
