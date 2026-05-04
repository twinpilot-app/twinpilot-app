"use client";

import { useState, useMemo, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import type { AgentLevel, AgentAutonomy, AgentOrigin } from "@/lib/types";

/* ─── Types ──────────────────────────────────────────────────────────────── */

type AgentRow = {
  id: string;
  slug: string;
  name: string;
  level: AgentLevel | null;
  autonomy: AgentAutonomy;
  origin: AgentOrigin;
  enabled: boolean;
  squad: {
    slug: string;
    name: string;
    color: string | null;
    display_order: number;
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

function AutonomyBadge({ autonomy }: { autonomy: AgentAutonomy }) {
  return (
    <span style={{
      fontSize: 9, fontFamily: "var(--font-mono)",
      padding: "2px 6px", borderRadius: 4,
      background: autonomy === "auto" ? "var(--green)20" : "var(--yellow)20",
      color: autonomy === "auto" ? "var(--green)" : "var(--yellow)",
    }}>
      {autonomy.toUpperCase()}
    </span>
  );
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export default function AgentCatalog() {
  const [agents, setAgents]             = useState<AgentRow[]>([]);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState("");
  const [selectedSquad, setSelectedSquad]       = useState<string | null>(null);
  const [hovered, setHovered]           = useState<string | null>(null);

  /* ── Fetch from DB ─────────────────────────────────────────────────────── */
  useEffect(() => {
    supabase
      .from("agent_definitions")
      .select(`
        id, slug, name, level, autonomy, origin, enabled,
        squad:squads (
          slug, name, color, display_order
        )
      `)
      .eq("enabled", true)
      .order("name")
      .then(({ data, error }) => {
        if (!error && data) setAgents(data as unknown as AgentRow[]);
        setLoading(false);
      });
  }, []);

  /* ── Derived lists ─────────────────────────────────────────────────────── */

  const squads = useMemo(() => {
    const seen = new Map<string, { name: string; color: string | null; order: number }>();
    for (const a of agents) {
      if (!seen.has(a.squad.slug))
        seen.set(a.squad.slug, {
          name: a.squad.name,
          color: a.squad.color,
          order: a.squad.display_order,
        });
    }
    return [...seen.entries()]
      .sort((x, y) => x[1].order - y[1].order)
      .map(([slug, v]) => ({ slug, ...v }));
  }, [agents]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return agents.filter((a) => {
      if (selectedSquad    && a.squad.slug !== selectedSquad)             return false;
      if (q && !a.name.toLowerCase().includes(q) &&
               !a.slug.toLowerCase().includes(q) &&
               !a.squad.name.toLowerCase().includes(q))                  return false;
      return true;
    });
  }, [agents, search, selectedSquad]);

  const grouped = useMemo(() => {
    const map = new Map<string, AgentRow[]>();
    for (const a of filtered) {
      if (!map.has(a.squad.slug)) map.set(a.squad.slug, []);
      map.get(a.squad.slug)!.push(a);
    }
    return map;
  }, [filtered]);

  if (loading) return (
    <div style={{ padding: 32, textAlign: "center", color: "var(--subtext0)", fontSize: 13 }}>
      Loading agents…
    </div>
  );

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div>
      {/* Search bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Search agents…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1, padding: "8px 12px", borderRadius: 8, fontSize: 13,
            outline: "none",
            background: "var(--surface0)", border: "1px solid var(--surface1)",
            color: "var(--text)", fontFamily: "var(--font-sans)",
          }}
        />
        <span style={{ fontSize: 11, color: "var(--subtext0)", fontVariantNumeric: "tabular-nums" }}>
          {filtered.length}/{agents.length}
        </span>
      </div>

      {/* Squad pills */}
      {squads.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 20 }}>
          {squads.map((s) => (
            <button
              key={s.slug}
              onClick={() => setSelectedSquad(selectedSquad === s.slug ? null : s.slug)}
              style={pillStyle(selectedSquad === s.slug, s.color ?? "var(--overlay1)")}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* Agent grid by squad */}
      {squads.filter((s) => grouped.has(s.slug)).map((squad) => {
        const squadAgents = grouped.get(squad.slug)!;
        const color = squad.color ?? "var(--overlay1)";
        return (
          <div key={squad.slug} style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, paddingLeft: 2 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                {squad.name}
              </span>
              <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{squadAgents.length}</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
              {squadAgents.map((agent) => {
                const isHovered = hovered === agent.slug;
                return (
                  <div
                    key={agent.slug}
                    onMouseEnter={() => setHovered(agent.slug)}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      display: "flex", flexDirection: "column",
                      padding: "12px 14px 10px",
                      borderRadius: 14,
                      background: isHovered ? "var(--surface0)" : "var(--mantle)",
                      border: `1px solid ${isHovered ? "var(--surface1)" : "transparent"}`,
                      cursor: "default",
                      transition: "all 0.2s ease",
                      transform: isHovered ? "translateY(-2px)" : "none",
                    }}
                  >
                    {/* Header row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: 9,
                        background: `${color}15`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 12, fontWeight: 700, color,
                        boxShadow: isHovered ? `0 4px 14px ${color}20` : "none",
                        transition: "all 0.2s ease",
                      }}>
                        {agent.name.charAt(0)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }} className="truncate">
                          {agent.name}
                        </div>
                        <code style={{ fontSize: 9, color: "var(--overlay0)" }}>{agent.slug}</code>
                      </div>
                    </div>

                    {/* Badges */}
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                      <AutonomyBadge autonomy={agent.autonomy} />
                      <LevelBadge level={agent.level} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {filtered.length === 0 && !loading && (
        <div style={{ textAlign: "center", padding: "48px 0", fontSize: 13, color: "var(--overlay0)" }}>
          No agents match your search.
        </div>
      )}
    </div>
  );
}

/* ─── Shared pill style helper ───────────────────────────────────────────── */

function pillStyle(active: boolean, color: string): React.CSSProperties {
  return {
    padding: "3px 10px", borderRadius: 20,
    fontSize: 10, fontWeight: 600,
    textTransform: "uppercase", letterSpacing: "0.4px",
    cursor: "pointer",
    background: active ? color : "var(--surface0)",
    color: active ? "#fff" : "var(--overlay0)",
    border: `1px solid ${active ? color : "var(--surface1)"}`,
    transition: "all 0.15s ease",
  };
}
