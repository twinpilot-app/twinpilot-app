"use client";

import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Shield, ShieldCheck, ShieldAlert, ShieldOff, RefreshCw } from "lucide-react";

interface TableRow {
  table_name: string;
  scope: "tenant" | "core" | "public";
  isolation: "direct" | "via_factory" | "via_project" | "via_run" | "none";
  notes: string | null;
  rls_enabled: boolean | null;
  policies: Record<string, number>;
  updated_at: string;
}

const SCOPE_COLOR: Record<string, string> = {
  tenant: "var(--mauve)",
  core:   "var(--blue)",
  public: "var(--overlay1)",
};

async function fetchWithAuth(url: string) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}` } });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

function statusFor(t: TableRow): { icon: React.ReactNode; label: string; color: string } {
  const p = t.policies ?? {};
  const total = (p.select ?? 0) + (p.insert ?? 0) + (p.update ?? 0) + (p.delete ?? 0) + (p.all ?? 0);

  if (t.scope === "core" || t.scope === "public") {
    if (t.rls_enabled && total > 0) return { icon: <ShieldCheck size={14} />, label: "OK", color: "var(--green)" };
    if (t.rls_enabled && total === 0) return { icon: <ShieldAlert size={14} />, label: "RLS on, no policies", color: "var(--yellow)" };
    return { icon: <ShieldOff size={14} />, label: "RLS off", color: "var(--overlay0)" };
  }
  // tenant
  if (!t.rls_enabled) return { icon: <ShieldOff size={14} />, label: "RLS OFF (tenant table!)", color: "var(--red)" };
  if (total === 0) return { icon: <ShieldAlert size={14} />, label: "No policies", color: "var(--red)" };
  if ((p.select ?? 0) + (p.all ?? 0) === 0) return { icon: <ShieldAlert size={14} />, label: "No SELECT policy", color: "var(--yellow)" };
  if ((p.insert ?? 0) + (p.update ?? 0) + (p.all ?? 0) === 0) return { icon: <ShieldAlert size={14} />, label: "No write policy", color: "var(--yellow)" };
  return { icon: <ShieldCheck size={14} />, label: "OK", color: "var(--green)" };
}

export default function AdminRlsPage() {
  const [tables, setTables] = useState<TableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const body = (await fetchWithAuth("/api/admin/rls")) as { tables: TableRow[] };
      setTables(body.tables);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const tenantTables = tables.filter((t) => t.scope === "tenant");
  const coreTables = tables.filter((t) => t.scope === "core");
  const publicTables = tables.filter((t) => t.scope === "public");

  const tenantOk = tenantTables.filter((t) => statusFor(t).label === "OK").length;
  const tenantWarn = tenantTables.length - tenantOk;

  const thStyle: React.CSSProperties = {
    padding: "10px 16px", textAlign: "left", fontSize: 11,
    fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase",
    letterSpacing: "0.06em", whiteSpace: "nowrap",
  };
  const tdStyle: React.CSSProperties = { padding: "10px 16px", fontSize: 13 };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 28px 80px" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Shield size={22} color="var(--blue)" />
          <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", margin: 0 }}>RLS Audit</h1>
        </div>
        <p style={{ fontSize: 14, color: "var(--subtext0)", margin: "6px 0 0" }}>
          Tenant isolation contract. Every tenant-owned table must have RLS enabled and policies for the operations it participates in.
        </p>
      </div>

      {error && (
        <div style={{
          padding: "12px 16px", borderRadius: 10,
          background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)",
          color: "var(--red)", fontSize: 13, marginBottom: 20,
        }}>{error}</div>
      )}

      {/* Summary */}
      {!loading && (
        <div style={{ display: "flex", gap: 14, marginBottom: 24 }}>
          <div style={{
            flex: 1, padding: "14px 18px", borderRadius: 12,
            background: "var(--mantle)", border: "1px solid var(--surface0)",
          }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: tenantWarn > 0 ? "var(--red)" : "var(--green)" }}>
              {tenantOk}/{tenantTables.length}
            </div>
            <div style={{ fontSize: 11, color: "var(--subtext0)" }}>Tenant tables OK</div>
          </div>
          <div style={{
            flex: 1, padding: "14px 18px", borderRadius: 12,
            background: "var(--mantle)", border: "1px solid var(--surface0)",
          }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: "var(--blue)" }}>
              {coreTables.length}
            </div>
            <div style={{ fontSize: 11, color: "var(--subtext0)" }}>Core tables</div>
          </div>
          <div style={{
            flex: 1, padding: "14px 18px", borderRadius: 12,
            background: "var(--mantle)", border: "1px solid var(--surface0)",
          }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: "var(--overlay1)" }}>
              {publicTables.length}
            </div>
            <div style={{ fontSize: 11, color: "var(--subtext0)" }}>Public tables</div>
          </div>
          <button
            onClick={load}
            style={{
              padding: "9px 16px", borderRadius: 9, border: "1px solid var(--surface1)",
              background: "var(--surface0)", color: "var(--text)",
              fontSize: 12, fontWeight: 600, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
              fontFamily: "var(--font-sans)",
            }}
          >
            <RefreshCw size={13} /> Reload
          </button>
        </div>
      )}

      {loading && <div style={{ padding: "40px 0", textAlign: "center", color: "var(--overlay0)" }}>Loading…</div>}

      {!loading && (["tenant", "core", "public"] as const).map((scope) => {
        const rows = tables.filter((t) => t.scope === scope);
        if (rows.length === 0) return null;
        return (
          <div key={scope} style={{ marginBottom: 28 }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 8, marginBottom: 10,
              fontSize: 11, fontWeight: 700, color: SCOPE_COLOR[scope],
              textTransform: "uppercase", letterSpacing: "0.08em",
            }}>
              {scope} ({rows.length})
            </div>
            <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 12, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--surface0)" }}>
                    {["Table", "Isolation", "RLS", "SELECT", "INSERT", "UPDATE", "DELETE", "ALL", "Status"].map((h) => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => {
                    const s = statusFor(t);
                    const p = t.policies ?? {};
                    return (
                      <tr key={t.table_name} style={{ borderBottom: "1px solid var(--surface0)" }}>
                        <td style={tdStyle}>
                          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{t.table_name}</div>
                          {t.notes && (
                            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2 }}>{t.notes}</div>
                          )}
                        </td>
                        <td style={{ ...tdStyle, fontSize: 11, color: "var(--subtext0)", fontFamily: "var(--font-mono)" }}>
                          {t.isolation}
                        </td>
                        <td style={tdStyle}>
                          <span style={{
                            fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99,
                            background: t.rls_enabled ? "rgba(28,191,107,0.12)" : "rgba(228,75,95,0.12)",
                            color: t.rls_enabled ? "var(--green)" : "var(--red)",
                            textTransform: "uppercase",
                          }}>
                            {t.rls_enabled ? "ON" : "OFF"}
                          </span>
                        </td>
                        {(["select", "insert", "update", "delete", "all"] as const).map((op) => (
                          <td key={op} style={{ ...tdStyle, fontSize: 11, color: p[op] ? "var(--text)" : "var(--overlay0)", fontWeight: p[op] ? 600 : 400 }}>
                            {p[op] ?? 0}
                          </td>
                        ))}
                        <td style={tdStyle}>
                          <span style={{
                            display: "inline-flex", alignItems: "center", gap: 5,
                            fontSize: 11, fontWeight: 600, color: s.color,
                          }}>
                            {s.icon} {s.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
