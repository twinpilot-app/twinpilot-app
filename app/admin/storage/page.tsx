"use client";

/**
 * Admin → Storage page.
 *
 * Reads /api/admin/storage (which wraps the admin_storage_usage RPC,
 * migration 176) and renders three views:
 *   1. Database total + measured-at timestamp
 *   2. Top tables by total bytes (with index/table split + row count)
 *   3. Per-tenant row counts across factories, projects, sprints,
 *      agents, skills, commands, hooks, marketplace_installs
 *
 * Per-tenant absolute bytes aren't computed — bytes per row depend on
 * column shapes that vary table-to-table. Row counts + table-level
 * totals are enough to decide if a tenant is the source of growth.
 */
import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Database, RefreshCw, AlertCircle } from "lucide-react";

interface TableRow {
  name:        string;
  total_bytes: number;
  table_bytes: number;
  index_bytes: number;
  rows_est:    number;
}

interface TenantRow {
  tenant_id:            string;
  tenant_slug:          string;
  tenant_name:          string;
  tenant_plan:          string | null;
  factories:            number;
  projects:             number;
  sprints:              number;
  agents:               number;
  skills:               number;
  commands:             number;
  hooks:                number;
  marketplace_installs: number;
  total_rows:           number;
}

interface StorageReport {
  database_total_bytes: number;
  measured_at:          string;
  tables:               TableRow[];
  tenants:              TenantRow[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

export default function AdminStoragePage() {
  const [data,    setData]    = useState<StorageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { setLoading(false); return; }
      try {
        const res = await fetch("/api/admin/storage", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const body = await res.json() as StorageReport & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
        if (!cancelled) setData(body);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [refreshTick]);

  return (
    <div style={{ padding: "28px 32px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <Database size={20} color="var(--blue)" />
            <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", margin: 0 }}>Storage</h1>
          </div>
          <div style={{ fontSize: 12, color: "var(--overlay0)" }}>
            Database total + per-table sizes + per-tenant row counts. Updated on demand.
          </div>
        </div>
        <button
          onClick={() => setRefreshTick((n) => n + 1)}
          disabled={loading}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "7px 14px", borderRadius: 8,
            border: "1px solid var(--surface1)",
            background: "transparent", color: "var(--text)",
            fontSize: 12, fontWeight: 600, cursor: loading ? "wait" : "pointer",
            fontFamily: "var(--font-sans)",
          }}
        >
          <RefreshCw size={13} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div style={{
          padding: "10px 14px", borderRadius: 8, marginBottom: 16,
          background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)",
          color: "var(--red)", fontSize: 12, display: "flex", alignItems: "center", gap: 8,
        }}>
          <AlertCircle size={13} /> {error}
        </div>
      )}

      {loading && !data && (
        <div style={{ padding: 40, textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>
      )}

      {data && (
        <>
          {/* Database total card */}
          <div style={{
            padding: "16px 20px", borderRadius: 12, marginBottom: 24,
            background: "linear-gradient(135deg, rgba(20,99,255,0.08) 0%, rgba(20,99,255,0.02) 100%)",
            border: "1px solid rgba(20,99,255,0.25)",
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--blue)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Database total
            </div>
            <div style={{ fontSize: 32, fontWeight: 800, fontFamily: "var(--font-heading)", color: "var(--text)" }}>
              {formatBytes(data.database_total_bytes)}
            </div>
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 6 }}>
              Measured at {new Date(data.measured_at).toLocaleString()}
            </div>
          </div>

          {/* Top tables by size */}
          <div style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: "var(--text)" }}>Top tables by size</h2>
            <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 10, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--crust)", borderBottom: "1px solid var(--surface0)" }}>
                    <th style={{ textAlign: "left",  padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Table</th>
                    <th style={{ textAlign: "right", padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total</th>
                    <th style={{ textAlign: "right", padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Table</th>
                    <th style={{ textAlign: "right", padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Indexes</th>
                    <th style={{ textAlign: "right", padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tables.slice(0, 25).map((t) => (
                    <tr key={t.name} style={{ borderBottom: "1px solid var(--surface0)" }}>
                      <td style={{ padding: "7px 12px", fontFamily: "var(--font-mono)", color: "var(--text)" }}>{t.name}</td>
                      <td style={{ padding: "7px 12px", textAlign: "right", color: "var(--text)", fontWeight: 600 }}>{formatBytes(t.total_bytes)}</td>
                      <td style={{ padding: "7px 12px", textAlign: "right", color: "var(--subtext0)" }}>{formatBytes(t.table_bytes)}</td>
                      <td style={{ padding: "7px 12px", textAlign: "right", color: "var(--subtext0)" }}>{formatBytes(t.index_bytes)}</td>
                      <td style={{ padding: "7px 12px", textAlign: "right", color: "var(--subtext0)" }}>{formatNum(t.rows_est)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.tables.length > 25 && (
                <div style={{ padding: "8px 12px", fontSize: 10, color: "var(--overlay0)", borderTop: "1px solid var(--surface0)", textAlign: "center" }}>
                  Showing top 25 of {data.tables.length} tables.
                </div>
              )}
            </div>
          </div>

          {/* Per-tenant breakdown */}
          <div>
            <h2 style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: "var(--text)" }}>Tenants by content row count</h2>
            <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 10, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 900 }}>
                <thead>
                  <tr style={{ background: "var(--crust)", borderBottom: "1px solid var(--surface0)" }}>
                    {["Tenant", "Plan", "Factories", "Projects", "Sprints", "Agents", "Skills", "Commands", "Hooks", "Installs", "Total"].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 0 || i === 1 ? "left" : "right", padding: "8px 10px", fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.tenants.map((t) => (
                    <tr key={t.tenant_id} style={{ borderBottom: "1px solid var(--surface0)" }}>
                      <td style={{ padding: "7px 10px", color: "var(--text)" }}>
                        <div style={{ fontWeight: 600 }}>{t.tenant_name}</div>
                        <code style={{ fontSize: 9, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{t.tenant_slug}</code>
                      </td>
                      <td style={{ padding: "7px 10px" }}>
                        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "var(--surface0)", color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                          {t.tenant_plan ?? "—"}
                        </span>
                      </td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>{formatNum(t.factories)}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>{formatNum(t.projects)}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>{formatNum(t.sprints)}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>{formatNum(t.agents)}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>{formatNum(t.skills)}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>{formatNum(t.commands)}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>{formatNum(t.hooks)}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right" }}>{formatNum(t.marketplace_installs)}</td>
                      <td style={{ padding: "7px 10px", textAlign: "right", color: "var(--text)", fontWeight: 600 }}>{formatNum(t.total_rows)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 8, lineHeight: 1.6 }}>
              Per-tenant row counts across the most operator-relevant tables. Bytes per row depend on column shapes that vary table-to-table — combined with the table-level totals above, the row counts identify the source of growth without an exact byte-per-tenant join.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
