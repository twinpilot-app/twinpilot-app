"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import {
  Dna, Code2, Globe, Layers, BookOpen, Target,
  ChevronRight, Check, AlertCircle, Save,
} from "lucide-react";

/* ── DNA sections (built-in factories) ──────────────────── */

const DNA_SECTIONS = [
  {
    id: "identity", icon: Target, label: "Product Identity", color: "#1463ff",
    description: "Who you are, what you build, and for whom.",
    fields: [
      { key: "mission",  label: "Mission statement", placeholder: "We build software factories that let small teams ship at enterprise scale." },
      { key: "domain",   label: "Primary domain",    placeholder: "SaaS / Fintech / Healthtech / E-commerce…" },
      { key: "audience", label: "Target audience",    placeholder: "Indie founders, small product teams, 1-10 people." },
    ],
  },
  {
    id: "stack", icon: Code2, label: "Tech Stack", color: "#00c2a8",
    description: "Default technologies agents will use when building projects.",
    fields: [
      { key: "language",  label: "Primary language",   placeholder: "TypeScript" },
      { key: "framework", label: "Frontend framework", placeholder: "Next.js 16 (App Router)" },
      { key: "backend",   label: "Backend / API",      placeholder: "Node.js + Hono / Fastify" },
      { key: "database",  label: "Database",           placeholder: "Supabase (PostgreSQL + Realtime)" },
      { key: "infra",     label: "Infrastructure",     placeholder: "Docker + GitHub Actions + Trigger.dev" },
      { key: "testing",   label: "Testing stack",      placeholder: "Vitest + Playwright" },
    ],
  },
  {
    id: "standards", icon: BookOpen, label: "Coding Standards", color: "#6366f1",
    description: "Rules all agents must follow when writing code.",
    fields: [
      { key: "style",    label: "Code style",         placeholder: "ESLint + Prettier. No semicolons. Single quotes." },
      { key: "coverage", label: "Test coverage",       placeholder: "≥80% for packages, ≥60% for apps." },
      { key: "commits",  label: "Commit conventions",  placeholder: "Conventional Commits: feat, fix, docs, refactor." },
      { key: "branches", label: "Branching strategy",  placeholder: "main (prod) + sprint-N branches, PRs for every sprint." },
    ],
  },
  {
    id: "regions", icon: Globe, label: "Localization", color: "#f59f00",
    description: "Default markets and languages for new projects.",
    fields: [
      { key: "defaultLocale", label: "Default locale", placeholder: "pt-BR" },
      { key: "markets",       label: "Target markets", placeholder: "Brazil, Portugal, USA (English)" },
    ],
  },
  {
    id: "context", icon: Layers, label: "Global Context", color: "#ec4899",
    description: "Free-form context injected into every agent's briefing.",
    fields: [
      { key: "context", label: "Context for all agents", placeholder: "We're a bootstrapped team. Always prioritise shipping fast over perfection." },
    ],
  },
];

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "10px 14px",
  background: "var(--crust)", border: "1px solid var(--surface1)",
  borderRadius: 8, color: "var(--text)", fontSize: 14,
  outline: "none", fontFamily: "var(--font-sans)",
  resize: "vertical" as const, boxSizing: "border-box" as const,
};

export default function DnaPage() {
  const router = useRouter();
  const { session, loading: authLoading, factoryId, factoryName, factories } = useAuth();
  const activeFactory = factories.find((f) => f.id === factoryId);

  const [values, setValues]             = useState<Record<string, string>>({});
  const [activeSection, setActiveSection] = useState("identity");
  const [saving, setSaving]             = useState(false);
  const [message, setMessage]           = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [loaded, setLoaded]             = useState(false);

  // Built-in factories (from marketplace) get full DNA sections; custom get simplified
  const isBuiltIn = activeFactory?.origin === "tirsa" || activeFactory?.origin === "paid";

  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  // Redirect if no factory
  useEffect(() => {
    if (!authLoading && session && !factoryId) router.replace("/factory-settings");
  }, [authLoading, session, factoryId, router]);

  // Load DNA from factories.dna
  useEffect(() => {
    if (!factoryId) return;
    supabase.from("factories").select("dna").eq("id", factoryId).single()
      .then(({ data }) => {
        if (data?.dna && typeof data.dna === "object") {
          setValues(data.dna as Record<string, string>);
        }
        setLoaded(true);
      });
  }, [factoryId]);

  function update(key: string, val: string) {
    setValues((v) => ({ ...v, [key]: val }));
    setMessage(null);
  }

  const save = useCallback(async () => {
    if (!factoryId) return;
    setSaving(true);
    setMessage(null);
    const { error } = await supabase.from("factories").update({ dna: values }).eq("id", factoryId);
    setSaving(false);
    if (error) {
      setMessage({ type: "error", text: error.message });
    } else {
      setMessage({ type: "success", text: "DNA saved." });
      setTimeout(() => setMessage(null), 3000);
    }
  }, [factoryId, values]);

  if (!loaded && factoryId) {
    return (
      <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", background: "var(--base)", color: "var(--text)" }}>
        <AppSidebar active="dna" />
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>
      </div>
    );
  }

  // ── Custom factory: simplified view ──
  if (!isBuiltIn) {
    return (
      <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", background: "var(--base)", color: "var(--text)" }}>
        <AppSidebar active="dna" />
        <div style={{ flex: 1, overflowY: "auto" }}>
          <div style={{ maxWidth: 600, margin: "0 auto", padding: "40px 24px 80px" }}>

            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: "linear-gradient(135deg, #1463ff, #6366f1)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Dna size={24} color="#fff" strokeWidth={1.5} />
              </div>
              <div>
                <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--font-heading)", marginBottom: 2 }}>Factory DNA</h1>
                <p style={{ fontSize: 13, color: "var(--subtext0)", margin: 0 }}>
                  {factoryName ?? "Custom Factory"} — identity and values
                </p>
              </div>
            </div>

            <p style={{ fontSize: 13, color: "var(--subtext0)", marginBottom: 28, marginTop: 16, lineHeight: 1.6 }}>
              Describe the mission, vision, and values for your factory.
              This context is injected into every agent briefing to align their output with your goals.
            </p>

            {/* Mission */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--subtext1)", marginBottom: 6 }}>Mission</label>
              <textarea
                style={{ ...inputStyle, minHeight: 80 }}
                placeholder="What does this factory do? What problems does it solve?"
                value={values.mission ?? ""}
                onChange={(e) => update("mission", e.target.value)}
                rows={3}
              />
            </div>

            {/* Vision */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--subtext1)", marginBottom: 6 }}>Vision</label>
              <textarea
                style={{ ...inputStyle, minHeight: 80 }}
                placeholder="Where is this factory heading? What's the long-term goal?"
                value={values.vision ?? ""}
                onChange={(e) => update("vision", e.target.value)}
                rows={3}
              />
            </div>

            {/* Values */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--subtext1)", marginBottom: 6 }}>Values</label>
              <textarea
                style={{ ...inputStyle, minHeight: 100 }}
                placeholder="What principles guide this factory? What trade-offs do agents make?"
                value={values.values ?? ""}
                onChange={(e) => update("values", e.target.value)}
                rows={4}
              />
            </div>

            {/* Global context */}
            <div style={{ marginBottom: 28 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--subtext1)", marginBottom: 6 }}>Global Context</label>
              <textarea
                style={{ ...inputStyle, minHeight: 100 }}
                placeholder="Any additional context for agents — tech preferences, constraints, team size…"
                value={values.context ?? ""}
                onChange={(e) => update("context", e.target.value)}
                rows={4}
              />
            </div>

            {/* Save */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button onClick={save} disabled={saving} style={{
                display: "flex", alignItems: "center", gap: 7,
                padding: "10px 24px", borderRadius: 9, border: "none",
                background: "linear-gradient(135deg, #1463ff 0%, #0f4ed0 100%)",
                color: "#fff", fontSize: 14, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
                fontFamily: "var(--font-sans)", opacity: saving ? 0.7 : 1,
              }}>
                <Save size={15} /> {saving ? "Saving…" : "Save DNA"}
              </button>
              {message && (
                <span style={{ fontSize: 12, fontWeight: 500, color: message.type === "success" ? "var(--green)" : "var(--red)", display: "flex", alignItems: "center", gap: 5 }}>
                  {message.type === "success" ? <Check size={13} /> : <AlertCircle size={13} />}
                  {message.text}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Built-in factory: full DNA sections ──
  const current = DNA_SECTIONS.find((s) => s.id === activeSection)!;
  const Icon = current.icon;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", background: "var(--base)", color: "var(--text)" }}>
      <AppSidebar active="dna" />

      <main style={{ flex: 1, overflowY: "auto", display: "flex" }}>

        {/* Section list */}
        <div style={{
          width: 220, minWidth: 220, height: "100%",
          borderRight: "1px solid var(--surface0)",
          padding: "24px 10px",
          display: "flex", flexDirection: "column", gap: 2,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.08em", padding: "0 8px", marginBottom: 4 }}>
            {factoryName ?? "Factory"} DNA
          </div>
          <div style={{ fontSize: 10, color: "var(--overlay0)", padding: "0 8px", marginBottom: 10 }}>
            Injected into every agent briefing.
          </div>
          {DNA_SECTIONS.map((s) => {
            const SIcon = s.icon;
            const active = s.id === activeSection;
            const filled = s.fields.some((f) => values[f.key]);
            return (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px", borderRadius: 8,
                  background: active ? "var(--surface0)" : "transparent",
                  border: "none", cursor: "pointer", textAlign: "left",
                  color: active ? "var(--text)" : "var(--subtext0)",
                  fontSize: 13, fontWeight: active ? 600 : 400,
                  borderLeft: active ? "2px solid var(--blue)" : "2px solid transparent",
                  fontFamily: "var(--font-sans)",
                }}
              >
                <SIcon size={15} color={active ? s.color : "var(--overlay1)"} strokeWidth={1.5} />
                <span style={{ flex: 1 }}>{s.label}</span>
                {filled && <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)" }} />}
              </button>
            );
          })}
        </div>

        {/* Form */}
        <div style={{ flex: 1, overflowY: "auto", padding: "32px 32px" }}>
          <div style={{ maxWidth: 600 }}>

            {/* Section header */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: `${current.color}18`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Icon size={18} color={current.color} strokeWidth={1.5} />
              </div>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{current.label}</h2>
                <p style={{ fontSize: 13, color: "var(--subtext0)", margin: 0 }}>{current.description}</p>
              </div>
            </div>

            {/* Fields */}
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {current.fields.map((f) => (
                <div key={f.key}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--subtext1)", marginBottom: 6 }}>
                    {f.label}
                  </label>
                  <textarea
                    style={{ ...inputStyle, minHeight: f.key === "context" ? 120 : 48 }}
                    placeholder={f.placeholder}
                    value={values[f.key] ?? ""}
                    onChange={(e) => update(f.key, e.target.value)}
                    rows={f.key === "context" ? 5 : 2}
                  />
                </div>
              ))}
            </div>

            {/* Save + navigate */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 28 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button onClick={save} disabled={saving} style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "10px 24px", borderRadius: 8, border: "none",
                  background: "linear-gradient(135deg, #1463ff 0%, #0f4ed0 100%)",
                  color: "#fff", fontSize: 14, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer",
                  fontFamily: "var(--font-sans)", opacity: saving ? 0.7 : 1,
                }}>
                  <Save size={15} /> {saving ? "Saving…" : "Save DNA"}
                </button>
                {message && (
                  <span style={{ fontSize: 12, fontWeight: 500, color: message.type === "success" ? "var(--green)" : "var(--red)", display: "flex", alignItems: "center", gap: 5 }}>
                    {message.type === "success" ? <Check size={13} /> : <AlertCircle size={13} />}
                    {message.text}
                  </span>
                )}
              </div>

              {(() => {
                const idx = DNA_SECTIONS.findIndex((s) => s.id === activeSection);
                const next = DNA_SECTIONS[idx + 1];
                if (!next) return null;
                return (
                  <button onClick={() => setActiveSection(next.id)}
                    style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: "none", color: "var(--subtext0)", fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                    Next: {next.label} <ChevronRight size={14} />
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
