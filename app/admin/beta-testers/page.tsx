"use client";

import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Rocket, Search, Copy, Check, Download, RefreshCw, CheckCircle2, XCircle } from "lucide-react";

type BetaStatus = "applied" | "approved" | "rejected" | "active" | "churned";

interface Application {
  id:           string;
  organization: string;
  name:         string;
  email:        string;
  use_case:     string | null;
  status:       BetaStatus;
  ip_address:   string | null;
  user_agent:   string | null;
  approved_at:  string | null;
  approved_by:  string | null;
  created_at:   string;
  updated_at:   string;
}

const STATUS_COLOR: Record<BetaStatus, { bg: string; fg: string; label: string }> = {
  applied:  { bg: "rgba(245,159,0,0.12)",  fg: "var(--peach)",    label: "Applied"  },
  approved: { bg: "rgba(20,99,255,0.12)",  fg: "#5b9aff",         label: "Approved" },
  rejected: { bg: "rgba(228,75,95,0.12)",  fg: "var(--red)",      label: "Rejected" },
  active:   { bg: "rgba(28,191,107,0.14)", fg: "var(--green)",    label: "Active"   },
  churned:  { bg: "rgba(107,122,158,0.14)", fg: "var(--overlay1)", label: "Churned"  },
};

const CAP = 50;

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

function toCsv(rows: Application[]): string {
  const header = ["organization", "name", "email", "status", "use_case", "created_at"];
  const escape = (v: string | null) => {
    if (v == null) return "";
    const needs = /[",\n]/.test(v);
    return needs ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = rows.map((r) => [r.organization, r.name, r.email, r.status, r.use_case, r.created_at].map(escape).join(","));
  return [header.join(","), ...lines].join("\n");
}

export default function AdminBetaTestersPage() {
  const [apps, setApps]       = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [query, setQuery]     = useState("");
  const [copied, setCopied]   = useState<string | null>(null);
  const [busy, setBusy]       = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setError("Not signed in"); setLoading(false); return; }
      const body = await fetchWithAuth("/api/admin/beta-testers", session.access_token);
      setApps(body.applications as Application[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function setStatus(id: string, status: BetaStatus) {
    setBusy(id); setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      await fetchWithAuth("/api/admin/beta-testers", session.access_token, {
        method: "PATCH",
        body: JSON.stringify({ id, status }),
      });
      setApps((prev) => prev.map((a) => a.id === id ? { ...a, status } : a));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const filtered = query.trim()
    ? apps.filter((a) => {
        const q = query.toLowerCase();
        return a.organization.toLowerCase().includes(q)
          || a.name.toLowerCase().includes(q)
          || a.email.toLowerCase().includes(q)
          || (a.use_case?.toLowerCase().includes(q) ?? false);
      })
    : apps;

  const statusCounts = apps.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});

  function downloadCsv() {
    const csv = toCsv(filtered);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `beta-testers-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ padding: "32px clamp(24px, 4vw, 40px) 80px", maxWidth: 1120, margin: "0 auto", fontFamily: "var(--font-sans)", color: "var(--text)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--font-heading)", margin: 0, display: "flex", alignItems: "center", gap: 10 }}>
            <Rocket size={20} color="var(--blue)" /> Beta Testers
          </h1>
          <div style={{ color: "var(--subtext0)", fontSize: 13, marginTop: 6 }}>
            {apps.length}/{CAP} slots · applied {statusCounts.applied ?? 0} · approved {statusCounts.approved ?? 0} · active {statusCounts.active ?? 0}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={load} disabled={loading} style={buttonStyle}>
            <RefreshCw size={13} className={loading ? "spin" : ""} /> Refresh
          </button>
          <button onClick={downloadCsv} disabled={filtered.length === 0} style={buttonStyle}>
            <Download size={13} /> Export CSV
          </button>
        </div>
      </div>

      <div style={{ position: "relative", marginBottom: 16 }}>
        <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--overlay0)" }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search org, name, email, use case…"
          style={{
            width: "100%", padding: "8px 12px 8px 32px",
            borderRadius: 8, border: "1px solid var(--surface1)",
            background: "var(--surface0)", color: "var(--text)", fontSize: 13,
            outline: "none", fontFamily: "var(--font-sans)",
          }}
        />
      </div>

      {error && (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.2)", color: "var(--red)", fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: "var(--overlay0)", fontSize: 13, padding: "40px 0", textAlign: "center" }}>
          {apps.length === 0 ? "No applications yet." : "No matches."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((a) => {
            const colors = STATUS_COLOR[a.status];
            return (
              <div key={a.id} style={{
                padding: "14px 16px", borderRadius: 10,
                background: "var(--mantle)", border: "1px solid var(--surface1)",
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{a.organization}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                        background: colors.bg, color: colors.fg,
                        textTransform: "uppercase", letterSpacing: "0.04em",
                      }}>{colors.label}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--subtext0)", marginBottom: 2 }}>{a.name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--subtext0)", fontFamily: "var(--font-mono)" }}>
                      {a.email}
                      <button
                        onClick={() => { navigator.clipboard.writeText(a.email); setCopied(a.id); setTimeout(() => setCopied(null), 1200); }}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "inline-flex" }}
                        title="Copy email"
                      >
                        {copied === a.id ? <Check size={11} color="var(--green)" /> : <Copy size={11} />}
                      </button>
                    </div>
                    {a.use_case && (
                      <div style={{
                        marginTop: 8, padding: "8px 10px",
                        background: "var(--crust)", borderRadius: 6,
                        fontSize: 12, color: "var(--subtext0)", lineHeight: 1.5,
                      }}>
                        {a.use_case}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: "right", fontSize: 11, color: "var(--overlay0)", minWidth: 120 }}>
                    {formatDate(a.created_at)}
                  </div>
                </div>

                {/* Actions — one click per target status */}
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  {(["applied", "approved", "rejected", "active", "churned"] as BetaStatus[])
                    .filter((s) => s !== a.status)
                    .map((s) => {
                      const c = STATUS_COLOR[s];
                      return (
                        <button
                          key={s}
                          disabled={busy === a.id}
                          onClick={() => setStatus(a.id, s)}
                          style={{
                            display: "inline-flex", alignItems: "center", gap: 4,
                            padding: "4px 10px", borderRadius: 6,
                            border: "1px solid var(--surface1)",
                            background: "transparent",
                            color: c.fg,
                            fontSize: 11, fontWeight: 600, cursor: busy === a.id ? "not-allowed" : "pointer",
                            fontFamily: "var(--font-sans)",
                            opacity: busy === a.id ? 0.5 : 1,
                          }}
                        >
                          {s === "approved" || s === "active" ? <CheckCircle2 size={11} /> :
                           s === "rejected" ? <XCircle size={11} /> : null}
                          → {c.label}
                        </button>
                      );
                    })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "7px 14px", borderRadius: 8,
  border: "1px solid var(--surface1)", background: "var(--surface0)",
  color: "var(--subtext1)", fontSize: 12, cursor: "pointer",
  fontFamily: "var(--font-sans)",
};
