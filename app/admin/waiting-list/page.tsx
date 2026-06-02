"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { ClipboardList, Trash2, Search, Copy, Check, Download, RefreshCw } from "lucide-react";

interface Lead {
  id: string;
  organization: string;
  name: string;
  email: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  converted_at: string | null;
  converted_tenant_id: string | null;
  tenant: { id: string; name: string; slug: string } | null;
}

async function fetchWithAuth(url: string, token: string, opts?: RequestInit) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...opts?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" })) as { error?: string };
    throw new Error(body.error ?? "Request failed");
  }
  return res.json();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function toCsv(rows: Lead[]): string {
  const header = ["organization", "name", "email", "created_at", "ip_address"];
  const escape = (v: string | null) => {
    if (v == null) return "";
    const needs = /[",\n]/.test(v);
    const escaped = v.replace(/"/g, '""');
    return needs ? `"${escaped}"` : escaped;
  };
  const lines = rows.map((r) => [r.organization, r.name, r.email, r.created_at, r.ip_address].map(escape).join(","));
  return [header.join(","), ...lines].join("\n");
}

export default function AdminWaitingListPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    try {
      const body = (await fetchWithAuth("/api/admin/waiting-list", session.access_token)) as { leads: Lead[] };
      setLeads(body.leads ?? []);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: string) {
    if (!confirm("Remove this lead from the waiting list?")) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    try {
      await fetchWithAuth(`/api/admin/waiting-list/${id}`, session.access_token, { method: "DELETE" });
      await load();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  function copyEmail(email: string) {
    navigator.clipboard.writeText(email);
    setCopied(email);
    setTimeout(() => setCopied(null), 2000);
  }

  async function handleSync() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const body = (await fetchWithAuth("/api/admin/waiting-list/sync", session.access_token, {
        method: "POST",
      })) as { updated: number; scanned: number };
      setSyncResult(`Reconciled ${body.updated} of ${body.scanned} pending leads.`);
      await load();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncResult(null), 5000);
    }
  }

  function downloadCsv() {
    const csv = toCsv(filtered);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `waiting-list-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((l) =>
      l.organization.toLowerCase().includes(q) ||
      l.name.toLowerCase().includes(q) ||
      l.email.toLowerCase().includes(q),
    );
  }, [leads, query]);

  const thStyle: React.CSSProperties = {
    padding: "10px 18px", textAlign: "left", fontSize: 11,
    fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase",
    letterSpacing: "0.06em", whiteSpace: "nowrap",
  };

  const tdStyle: React.CSSProperties = { padding: "12px 18px", fontSize: 13 };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 28px 80px" }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", marginBottom: 4 }}>Waiting List</h1>
        <p style={{ fontSize: 14, color: "var(--subtext0)" }}>Leads captured from the landing page sign-up modal</p>
      </div>

      {error && (
        <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)", color: "var(--red)", fontSize: 13, marginBottom: 24 }}>
          {error}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <div style={{ flex: 1, position: "relative" }}>
          <Search size={14} color="var(--overlay0)" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by organization, name, or email…"
            style={{
              width: "100%", padding: "9px 12px 9px 34px", borderRadius: 9,
              background: "var(--surface0)", border: "1px solid var(--surface1)",
              color: "var(--text)", fontSize: 13, outline: "none",
              fontFamily: "var(--font-sans)", boxSizing: "border-box",
            }}
          />
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          title="Reconcile pending leads with existing tenants"
          style={{
            padding: "9px 16px", borderRadius: 9, border: "1px solid var(--surface1)",
            background: "var(--surface0)", color: syncing ? "var(--overlay0)" : "var(--text)",
            fontSize: 12, fontWeight: 600, cursor: syncing ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-sans)",
          }}
        >
          <RefreshCw size={13} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} />
          {syncing ? "Syncing…" : "Sync"}
        </button>
        <button
          onClick={downloadCsv}
          disabled={filtered.length === 0}
          style={{
            padding: "9px 16px", borderRadius: 9, border: "1px solid var(--surface1)",
            background: "var(--surface0)", color: filtered.length === 0 ? "var(--overlay0)" : "var(--text)",
            fontSize: 12, fontWeight: 600, cursor: filtered.length === 0 ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-sans)",
          }}
        >
          <Download size={13} /> Export CSV
        </button>
      </div>

      {syncResult && (
        <div style={{
          padding: "10px 14px", borderRadius: 10,
          background: "rgba(28,191,107,0.1)", border: "1px solid rgba(28,191,107,0.3)",
          color: "var(--green)", fontSize: 13, marginBottom: 16,
        }}>
          {syncResult}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* Leads table */}
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", gap: 8 }}>
          <ClipboardList size={15} color="var(--overlay1)" />
          <span style={{ fontSize: 14, fontWeight: 700 }}>Leads</span>
          <span style={{ fontSize: 12, color: "var(--overlay0)", marginLeft: 4 }}>
            {query ? `${filtered.length} of ${leads.length}` : `${leads.length} total`}
          </span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--surface0)" }}>
              {["Organization", "Name", "Email", "Status", "Submitted", ""].map((h, i) => (
                <th key={i} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} style={{ padding: "32px 20px", textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={6} style={{ padding: "32px 20px", textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>
                {query ? "No leads match that filter." : "No sign-ups yet."}
              </td></tr>
            )}
            {filtered.map((l) => (
              <tr key={l.id} style={{ borderBottom: "1px solid var(--surface0)" }}>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{l.organization}</td>
                <td style={{ ...tdStyle, color: "var(--subtext0)" }}>{l.name}</td>
                <td style={tdStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <a href={`mailto:${l.email}`} style={{ color: "var(--blue)", textDecoration: "none", fontSize: 13 }}>
                      {l.email}
                    </a>
                    <button
                      onClick={() => copyEmail(l.email)}
                      title="Copy email"
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "flex" }}
                    >
                      {copied === l.email ? <Check size={12} color="var(--green)" /> : <Copy size={12} />}
                    </button>
                  </div>
                </td>
                <td style={tdStyle}>
                  {l.converted_at ? (
                    <a
                      href={l.tenant ? `/admin/tenants/${l.tenant.id}` : "#"}
                      style={{
                        fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 99,
                        background: "rgba(28,191,107,0.12)", color: "var(--green)",
                        textTransform: "uppercase", textDecoration: "none",
                        display: "inline-flex", alignItems: "center", gap: 5,
                      }}
                      title={l.tenant ? `Tenant: ${l.tenant.name} (${l.tenant.slug})` : "Converted"}
                    >
                      Converted{l.tenant ? ` → ${l.tenant.slug}` : ""}
                    </a>
                  ) : (
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 99,
                      background: "rgba(107,122,158,0.15)", color: "var(--overlay1)",
                      textTransform: "uppercase",
                    }}>
                      Pending
                    </span>
                  )}
                </td>
                <td style={{ ...tdStyle, fontSize: 12, color: "var(--overlay0)" }}>
                  {formatDate(l.created_at)}
                </td>
                <td style={tdStyle}>
                  <button
                    onClick={() => handleDelete(l.id)}
                    title="Remove lead"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)", padding: 4, display: "flex", opacity: 0.7 }}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
