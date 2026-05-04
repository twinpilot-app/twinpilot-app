"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Search, ArrowUpRight } from "lucide-react";

const PLAN_COLOR: Record<string, string> = {
  starter: "#6b7a9e", pro: "#1463ff", enterprise: "#00c2a8", owner: "#a78bfa",
};

interface AdminTenant {
  id: string; name: string; slug: string; plan: string; created_at: string;
  suspended?: boolean;
  member_count: number; factory_count: number; project_count: number; cost_usd: number;
}

export default function AdminTenantsPage() {
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [query, setQuery]     = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return;
      const res = await fetch("/api/admin/tenants", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const body = await res.json() as { tenants: AdminTenant[] };
        setTenants(body.tenants);
      }
      setLoading(false);
    });
  }, []);

  const filtered = tenants.filter(
    (t) => t.name.toLowerCase().includes(query.toLowerCase()) || t.slug.includes(query.toLowerCase()),
  );

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 28px 80px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", marginBottom: 4 }}>Tenants</h1>
          <p style={{ fontSize: 14, color: "var(--subtext0)" }}>{tenants.length} workspaces registered</p>
        </div>
        {/* Search */}
        <div style={{ position: "relative" }}>
          <Search size={14} color="var(--overlay0)" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)" }} />
          <input
            placeholder="Search tenants…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              padding: "9px 14px 9px 34px", borderRadius: 9,
              background: "var(--mantle)", border: "1px solid var(--surface1)",
              color: "var(--text)", fontSize: 13, outline: "none",
              fontFamily: "var(--font-sans)", width: 220,
            }}
          />
        </div>
      </div>

      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--surface0)" }}>
              {["Tenant", "Plan", "Members", "Factories", "Projects", "LLM Cost", "Joined", ""].map((h) => (
                <th key={h} style={{ padding: "10px 18px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} style={{ padding: "32px 20px", textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={8} style={{ padding: "32px 20px", textAlign: "center", color: "var(--overlay0)", fontSize: 13 }}>No tenants found.</td></tr>
            )}
            {filtered.map((t) => (
              <tr key={t.id} style={{ borderBottom: "1px solid var(--surface0)", opacity: t.suspended ? 0.5 : 1 }}>
                <td style={{ padding: "13px 18px" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{t.slug}</div>
                </td>
                <td style={{ padding: "13px 18px" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 99, background: `${PLAN_COLOR[t.plan] ?? "#6b7a9e"}18`, color: PLAN_COLOR[t.plan] ?? "#6b7a9e", textTransform: "uppercase" }}>
                    {t.plan}
                  </span>
                  {t.suspended && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "var(--red)", textTransform: "uppercase" }}>Suspended</span>}
                </td>
                <td style={{ padding: "13px 18px", fontSize: 13, color: "var(--subtext1)", textAlign: "center" }}>{t.member_count}</td>
                <td style={{ padding: "13px 18px", fontSize: 13, color: "var(--subtext1)", textAlign: "center" }}>{t.factory_count}</td>
                <td style={{ padding: "13px 18px", fontSize: 13, color: "var(--subtext1)", textAlign: "center" }}>{t.project_count}</td>
                <td style={{ padding: "13px 18px", fontSize: 13, color: "var(--subtext1)", fontFamily: "var(--font-mono)" }}>
                  ${t.cost_usd.toFixed(2)}
                </td>
                <td style={{ padding: "13px 18px", fontSize: 12, color: "var(--overlay0)", whiteSpace: "nowrap" }}>
                  {new Date(t.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </td>
                <td style={{ padding: "13px 18px" }}>
                  <a href={`/admin/tenants/${t.id}`} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--blue)", textDecoration: "none", whiteSpace: "nowrap" }}>
                    View <ArrowUpRight size={11} />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
