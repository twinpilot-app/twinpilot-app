"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2, Laptop, AlertCircle, Terminal, Building2, Factory as FactoryIcon } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

interface Instance {
  id:            string;
  factory_id:    string | null;
  factory_name:  string | null;
  hostname:      string;
  os_username:   string;
  platform:      string;
  arch:          string | null;
  node_version:  string;
  cli_version:   string;
  email:         string | null;
  created_at:    string;
  last_seen_at:  string;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins  = Math.round(diffMs / 60_000);
  const hours = Math.round(diffMs / 3_600_000);
  const days  = Math.round(diffMs / 86_400_000);
  if (mins   < 2)   return "just now";
  if (mins   < 60)  return `${mins}m ago`;
  if (hours  < 24)  return `${hours}h ago`;
  if (days   < 30)  return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function platformLabel(p: string): string {
  if (p === "darwin") return "macOS";
  if (p === "win32")  return "Windows";
  if (p === "linux")  return "Linux";
  return p;
}

export function CliInstancesSection({ tenantId }: { tenantId: string }) {
  const { session } = useAuth();
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [deleting, setDeleting]   = useState<string | null>(null);
  const [error, setError]         = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!session) return;
    const res = await fetch(`/api/cli/instances?tenantId=${tenantId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      const b = await res.json() as { instances: Instance[] };
      setInstances(b.instances);
    } else {
      const b = await res.json().catch(() => ({})) as { error?: string };
      setError(b.error ?? `HTTP ${res.status}`);
    }
  }, [tenantId, session]);

  useEffect(() => { reload(); }, [reload]);

  async function revoke(id: string) {
    if (!session) return;
    if (!confirm("Remove this CLI registration? The CLI stays authenticated on the host — this only clears the record from your dashboard.")) return;
    setDeleting(id); setError(null);
    try {
      const res = await fetch(`/api/cli/instances?id=${id}&tenantId=${tenantId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      await reload();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setDeleting(null);
    }
  }

  if (instances === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--subtext0)", fontSize: 13 }}>
        <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Loading…
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Terminal size={14} color="var(--overlay1)" />
        <span style={{ fontSize: 13, fontWeight: 700 }}>Authenticated CLIs</span>
        <span style={{ fontSize: 11, color: "var(--overlay0)", marginLeft: "auto" }}>{instances.length} total</span>
      </div>

      {instances.length === 0 ? (
        <div style={{ padding: "12px 14px", borderRadius: 8, background: "var(--surface0)", border: "1px solid var(--surface1)", fontSize: 12, color: "var(--overlay0)" }}>
          No CLI has logged in yet. After <code style={codeInline}>twin-pilot login</code> from a terminal, the install appears here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {instances.map((i) => (
            <div key={i.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", borderRadius: 8,
              background: "var(--surface0)", border: "1px solid var(--surface1)",
              fontSize: 12,
            }}>
              <Laptop size={14} color="var(--overlay1)" style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 700, color: "var(--text)" }}>
                  <span>{i.os_username}@{i.hostname}</span>
                  <span style={{ fontSize: 10, color: "var(--overlay0)", fontWeight: 400 }}>·</span>
                  <span style={{ fontSize: 10, color: "var(--overlay0)", fontWeight: 400 }}>{platformLabel(i.platform)}{i.arch ? ` (${i.arch})` : ""}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 2, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {i.factory_id
                    ? <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><FactoryIcon size={10} color="var(--blue)" /> {i.factory_name ?? "Factory"}</span>
                    : <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><Building2 size={10} color="var(--overlay1)" /> Tenant-wide</span>}
                  <span>·</span>
                  <span>CLI v{i.cli_version}</span>
                  <span>·</span>
                  <span>Node {i.node_version}</span>
                  {i.email && <><span>·</span><span>{i.email}</span></>}
                </div>
              </div>
              <div style={{ textAlign: "right", fontSize: 11, color: "var(--overlay0)", flexShrink: 0 }}>
                <div>Last seen</div>
                <div>{relativeTime(i.last_seen_at)}</div>
              </div>
              <button
                onClick={() => revoke(i.id)}
                disabled={deleting === i.id}
                title="Remove registration"
                style={{ padding: 6, borderRadius: 6, border: "1px solid rgba(228,75,95,0.2)", background: "rgba(228,75,95,0.06)", cursor: deleting === i.id ? "not-allowed" : "pointer", color: "var(--red)", display: "flex" }}
              >
                {deleting === i.id ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={12} />}
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 7, padding: "7px 11px", borderRadius: 7, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)", fontSize: 12, color: "var(--red)" }}>
          <AlertCircle size={13} /> {error}
        </div>
      )}
    </div>
  );
}

const codeInline: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 11,
  padding: "1px 5px", borderRadius: 4,
  background: "var(--base)", border: "1px solid var(--surface1)",
  color: "var(--text)",
};
