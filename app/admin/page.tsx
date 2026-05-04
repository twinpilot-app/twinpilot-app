"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { brand } from "@/lib/brand";
import { Users, TrendingUp, DollarSign, Activity, ArrowUpRight } from "lucide-react";

const PLAN_COLOR: Record<string, string> = {
  starter:    "#6b7a9e",
  pro:        "#1463ff",
  enterprise: "#00c2a8",
  owner:      "#a78bfa",
};

const MRR: Record<string, number> = { starter: 0, pro: 79, enterprise: 500, owner: 0 };

interface Overview {
  totalTenants:  number;
  newThisWeek:   number;
  mrr:           number;
  costThisMonth: number;
  runsThisMonth: number;
  recentTenants: { id: string; name: string; slug: string; plan: string; created_at: string }[];
}

async function fetchWithAuth(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export default function AdminOverview() {
  const [data, setData]     = useState<Overview | null>(null);
  const [error, setError]   = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return;
      try {
        const overview = await fetchWithAuth("/api/admin/overview", session.access_token) as Overview;
        setData(overview);
      } catch (e: unknown) {
        setError((e as Error).message);
      }
    });
  }, []);

  const statCard = (
    label: string,
    value: string | number,
    sub: string,
    Icon: React.FC<{ size?: number; color?: string }>,
    color: string,
  ) => (
    <div style={{
      background: "var(--mantle)", border: "1px solid var(--surface0)",
      borderRadius: 14, padding: "20px 22px",
      display: "flex", alignItems: "flex-start", gap: 16,
    }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: `${color}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon size={18} color={color} />
      </div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 800, fontFamily: "var(--font-heading)", color: "var(--text)", lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--subtext0)", marginTop: 2 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--overlay0)", marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  );

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "40px 28px 80px" }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", marginBottom: 4 }}>Platform Overview</h1>
        <p style={{ fontSize: 14, color: "var(--subtext0)" }}>{brand.holdingName} — all tenants</p>
      </div>

      {error && (
        <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)", color: "var(--red)", fontSize: 13, marginBottom: 24 }}>
          {error}
        </div>
      )}

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 32 }}>
        {statCard("Tenants",         data?.totalTenants ?? "—",                         `+${data?.newThisWeek ?? 0} this week`,     Users,      "#1463ff")}
        {statCard("MRR",             data ? `$${data.mrr.toLocaleString()}` : "—",      "Monthly recurring revenue",                TrendingUp, "#00c2a8")}
        {statCard("LLM cost / mo",   data ? `$${data.costThisMonth.toFixed(2)}` : "—",  "Agent runs this month",                    DollarSign, "#f59f00")}
        {statCard("Runs / mo",       data?.runsThisMonth ?? "—",                        "Agent executions this month",              Activity,   "#a78bfa")}
      </div>

      {/* Recent tenants */}
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Recent signups</span>
          <a href="/admin/tenants" style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--blue)", textDecoration: "none" }}>
            View all <ArrowUpRight size={12} />
          </a>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--surface0)" }}>
              {["Tenant", "Slug", "Plan", "Joined"].map((h) => (
                <th key={h} style={{ padding: "10px 20px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(data?.recentTenants ?? []).map((t) => (
              <tr key={t.id} style={{ borderBottom: "1px solid var(--surface0)" }}>
                <td style={{ padding: "12px 20px" }}>
                  <a href={`/admin/tenants/${t.id}`} style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", textDecoration: "none" }}>{t.name}</a>
                </td>
                <td style={{ padding: "12px 20px", fontSize: 12, color: "var(--subtext0)", fontFamily: "var(--font-mono)" }}>{t.slug}</td>
                <td style={{ padding: "12px 20px" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 99, background: `${PLAN_COLOR[t.plan] ?? "#6b7a9e"}18`, color: PLAN_COLOR[t.plan] ?? "#6b7a9e", textTransform: "uppercase" }}>
                    {t.plan} {MRR[t.plan] ? `· $${MRR[t.plan]}/mo` : ""}
                  </span>
                </td>
                <td style={{ padding: "12px 20px", fontSize: 12, color: "var(--overlay0)" }}>
                  {new Date(t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </td>
              </tr>
            ))}
            {!data && (
              <tr><td colSpan={4} style={{ padding: "24px 20px", textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
