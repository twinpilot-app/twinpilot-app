"use client";

import React, { useState, useEffect, useMemo } from "react";
import AppSidebar from "../../components/AppSidebar";
import { supabase } from "@/lib/supabase";
import type { AgentLevel, AgentAutonomy } from "@/lib/types";
import { Bot, ChevronRight, ToggleLeft, ToggleRight, Search } from "lucide-react";

/* ─── Types ──────────────────────────────────────────────────────────────── */

type AgentRow = {
  id: string;
  slug: string;
  name: string;
  level: AgentLevel | null;
  autonomy: AgentAutonomy;
  enabled: boolean;
  squad: {
    slug: string;
    name: string;
    color: string | null;
    display_order: number;
    category: {
      slug: string;
      name: string;
      display_order: number;
    };
  };
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function LevelBadge({ level }: { level: AgentLevel | null }) {
  if (!level) return null;
  const isSS = level === "super-specialist";
  return (
    <span style={{
      fontSize: 8, fontFamily: "var(--font-mono)",
      padding: "2px 5px", borderRadius: 4,
      background: isSS ? "var(--mauve)20" : "var(--overlay0)18",
      color: isSS ? "var(--mauve)" : "var(--overlay1)",
      textTransform: "uppercase", letterSpacing: "0.3px", fontWeight: 700,
    }}>
      {isSS ? "SS" : "S"}
    </span>
  );
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export default function AgentsPage() {
  const [agents, setAgents]   = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState("");
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  /* ── Fetch ─────────────────────────────────────────────────────────────── */
  useEffect(() => {
    supabase
      .from("agent_definitions")
      .select(`
        id, slug, name, level, autonomy, enabled,
        squad:squads (
          slug, name, color, display_order
        )
      `)
      .order("name")
      .then(({ data, error }) => {
        if (!error && data) setAgents(data as unknown as AgentRow[]);
        setLoading(false);
      });
  }, []);

  /* ── Toggle (persisted to DB) ──────────────────────────────────────────── */
  async function toggleAgent(agent: AgentRow) {
    if (toggling.has(agent.id)) return;
    const newEnabled = !agent.enabled;
    setToggling((s) => new Set(s).add(agent.id));
    // Optimistic update
    setAgents((prev) => prev.map((a) => a.id === agent.id ? { ...a, enabled: newEnabled } : a));
    await supabase.from("agent_definitions").update({ enabled: newEnabled }).eq("id", agent.id);
    setToggling((s) => { const n = new Set(s); n.delete(agent.id); return n; });
  }

  /* ── Filter ────────────────────────────────────────────────────────────── */
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return agents;
    return agents.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      a.slug.toLowerCase().includes(q) ||
      a.squad.name.toLowerCase().includes(q)
    );
  }, [agents, search]);

  /* ── Group: category → squad → agents ─────────────────────────────────── */
  const grouped = useMemo(() => {
    const catMap = new Map<string, {
      name: string;
      order: number;
      squads: Map<string, { name: string; color: string | null; order: number; agents: AgentRow[] }>;
    }>();

    for (const a of filtered) {
      const catSlug = a.squad.category.slug;
      if (!catMap.has(catSlug))
        catMap.set(catSlug, { name: a.squad.category.name, order: a.squad.category.display_order, squads: new Map() });

      const cat = catMap.get(catSlug)!;
      if (!cat.squads.has(a.squad.slug))
        cat.squads.set(a.squad.slug, { name: a.squad.name, color: a.squad.color, order: a.squad.display_order, agents: [] });

      cat.squads.get(a.squad.slug)!.agents.push(a);
    }

    return [...catMap.entries()]
      .sort((x, y) => x[1].order - y[1].order)
      .map(([slug, cat]) => ({
        slug,
        name: cat.name,
        squads: [...cat.squads.entries()]
          .sort((x, y) => x[1].order - y[1].order)
          .map(([sSlug, s]) => ({ slug: sSlug, ...s })),
      }));
  }, [filtered]);

  const enabledCount = agents.filter((a) => a.enabled).length;
  const squadCount   = new Set(agents.map((a) => a.squad.slug)).size;

  /* ── Render ────────────────────────────────────────────────────────────── */
  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", background: "var(--base)", color: "var(--text)" }}>
      <AppSidebar active="agents" />

      <main style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px" }}>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-heading)", marginBottom: 6 }}>
                Agents
              </h1>
              <p style={{ color: "var(--subtext0)", fontSize: 14 }}>
                {loading
                  ? "Loading…"
                  : `${agents.length} agents · ${enabledCount} enabled. Disabled agents are skipped during pipeline execution.`}
              </p>
            </div>

            {/* Search */}
            <div style={{ position: "relative" }}>
              <Search size={14} color="var(--overlay0)" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agents…"
                style={{
                  padding: "8px 12px 8px 32px",
                  background: "var(--surface0)", border: "1px solid var(--surface1)",
                  borderRadius: 8, color: "var(--text)", fontSize: 13, outline: "none",
                  width: 200,
                }}
              />
            </div>
          </div>

          {/* Stats bar */}
          {!loading && (
            <div style={{
              display: "flex", gap: 16, marginBottom: 28,
              padding: "14px 18px",
              background: "var(--surface0)", border: "1px solid var(--surface1)",
              borderRadius: 10,
            }}>
              {[
                { label: "Total",    value: agents.length },
                { label: "Enabled",  value: enabledCount,                        color: "var(--green)"  },
                { label: "Disabled", value: agents.length - enabledCount,        color: "var(--yellow)" },
                { label: "Squads",   value: squadCount },
              ].map((s) => (
                <div key={s.label}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: s.color ?? "var(--text)" }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: "var(--subtext0)" }}>{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--subtext0)", fontSize: 13 }}>
              Loading agents…
            </div>
          )}

          {/* Category → Squad → Agents */}
          {grouped.map((category) => (
            <div key={category.slug} style={{ marginBottom: 36 }}>

              {/* Category header */}
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: "0.8px",
                textTransform: "uppercase", color: "var(--overlay0)",
                marginBottom: 16, paddingBottom: 6,
                borderBottom: "1px solid var(--surface1)",
              }}>
                {category.name}
              </div>

              {category.squads.map((squad) => {
                const color = squad.color ?? "var(--overlay1)";
                return (
                  <div key={squad.slug} style={{ marginBottom: 24 }}>
                    {/* Squad header */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <div style={{ width: 3, height: 16, borderRadius: 2, background: color }} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--subtext1)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        {squad.name}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{squad.agents.length}</span>
                    </div>

                    {/* Agent cards */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
                      {squad.agents.map((agent) => (
                        <div key={agent.slug} style={{
                          background: "var(--surface0)", border: "1px solid var(--surface1)",
                          borderRadius: 10, padding: "14px 16px",
                          opacity: agent.enabled ? 1 : 0.5,
                          transition: "opacity 0.15s ease",
                        }}>
                          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                              <div style={{
                                width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                                background: `${color}18`,
                                display: "flex", alignItems: "center", justifyContent: "center",
                              }}>
                                <Bot size={15} color={color} strokeWidth={1.5} />
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginBottom: 1 }}>
                                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{agent.name}</span>
                                  <LevelBadge level={agent.level} />
                                </div>
                                <code style={{ fontSize: 11, color: "var(--overlay0)" }}>{agent.slug}</code>
                              </div>
                            </div>

                            {/* Toggle */}
                            <button
                              onClick={() => toggleAgent(agent)}
                              disabled={toggling.has(agent.id)}
                              style={{
                                background: "transparent", border: "none", cursor: "pointer",
                                padding: 2, flexShrink: 0,
                                opacity: toggling.has(agent.id) ? 0.4 : 1,
                                transition: "opacity 0.15s ease",
                              }}
                            >
                              {agent.enabled
                                ? <ToggleRight size={22} color="var(--green)" />
                                : <ToggleLeft  size={22} color="var(--overlay0)" />
                              }
                            </button>
                          </div>

                          <a
                            href={`/agents/${agent.slug}`}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 4,
                              marginTop: 10, fontSize: 11, color,
                              textDecoration: "none",
                            }}
                          >
                            View contract <ChevronRight size={11} />
                          </a>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {!loading && filtered.length === 0 && (
            <div style={{ textAlign: "center", padding: "48px 0", fontSize: 13, color: "var(--overlay0)" }}>
              No agents match your search.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
