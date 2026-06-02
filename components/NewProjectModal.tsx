"use client";

/** Operator dialog to create a new project. Renders either as a centred
 *  overlay (`inline=false`) or embedded inside another shell
 *  (`inline=true`); the form body is the same. */
import React, { useState } from "react";
import { RefreshCw, Sparkles, X, GitBranch, AlertTriangle } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { slugify } from "@/lib/slugify";
import type { Project } from "@/components/ProjectCard";

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)",
  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 13, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box",
};

const toProjectSlug = (name: string): string => slugify(name);

export default function NewProjectModal({
  factoryId, factorySlug, onClose, onCreated, onOpenSettings, inline,
}: {
  factoryId: string;
  factorySlug: string;
  onClose: () => void;
  onCreated: (project: Project) => void;
  onOpenSettings?: (project: Project) => void;
  inline?: boolean;
}) {
  const [name,           setName]           = useState("");
  const [brief,          setBrief]          = useState("");
  const [mode,           setMode]           = useState<"new" | "adopt">("new");
  const [repoUrl,        setRepoUrl]        = useState("");
  const [saving,         setSaving]         = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const { session } = useAuth();

  async function handleCreate() {
    if (!name.trim() || !brief.trim()) { setError("Name and brief are required."); return; }
    setSaving(true); setError(null);
    if (!session) return;

    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ factoryId, name, intake_brief: brief, pipeline_id: null, mode, repo_url: repoUrl || null }),
    });
    const body = await res.json() as { project?: Project; error?: string };
    if (!res.ok) { setError(body.error ?? "Failed to create project."); setSaving(false); return; }

    const project = body.project!;
    setSaving(false);
    onCreated(project);
    onOpenSettings?.(project);
  }

  return (
    <div style={inline
      ? { flex: 1, overflowY: "auto", background: "var(--mantle)" }
      : { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }
    }>
      <div style={inline ? {} : { background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 18, width: "min(620px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid var(--surface0)", position: "sticky", top: 0, background: "var(--mantle)", zIndex: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>New Project</div>
            <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>The Intake agent will receive your brief and kick off the pipeline</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={handleCreate} disabled={saving} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 8, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1, fontFamily: "var(--font-sans)" }}>
              {saving ? <RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Sparkles size={12} />}
              Create
            </button>
            <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4 }}><X size={18} /></button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Mode */}
          <div>
            <label style={labelStyle}>Mode</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {([
                { id: "new",   label: "New project",     desc: "Start from a brief or idea" },
                { id: "adopt", label: "Adopt existing",  desc: "Factory takes over an existing project" },
              ] as const).map((m) => (
                <button key={m.id} onClick={() => setMode(m.id)} style={{
                  textAlign: "left", padding: "10px 14px", borderRadius: 10, cursor: "pointer",
                  border: `1.5px solid ${mode === m.id ? "rgba(20,99,255,0.5)" : "var(--surface1)"}`,
                  background: mode === m.id ? "rgba(20,99,255,0.08)" : "var(--surface0)",
                  fontFamily: "var(--font-sans)",
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: mode === m.id ? "#1463ff" : "var(--text)", marginBottom: 3 }}>{m.label}</div>
                  <div style={{ fontSize: 11, color: "var(--subtext0)" }}>{m.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={labelStyle}>Project name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Mobile App" style={inputStyle} autoFocus />
            {name.trim() && (
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <GitBranch size={11} color="var(--overlay0)" />
                <span style={{ fontSize: 11, color: "var(--overlay0)" }}>GitHub repo:</span>
                <code style={{ fontSize: 11, color: "var(--teal)", fontFamily: "var(--font-mono)" }}>
                  {factorySlug ? `${factorySlug}-${toProjectSlug(name)}` : toProjectSlug(name)}
                </code>
              </div>
            )}
          </div>

          <div>
            <label style={labelStyle}>
              {mode === "new" ? "Brief / spec" : "What to adopt"}
              <span style={{ fontWeight: 400, color: "var(--overlay0)", marginLeft: 6 }}>
                {mode === "new" ? "— one sentence or a full spec" : "— repo URL + description of the project"}
              </span>
            </label>
            <textarea
              value={brief} onChange={(e) => setBrief(e.target.value)}
              placeholder={mode === "new"
                ? "A meal planning app for busy parents that suggests weekly menus based on dietary preferences and automatically generates a shopping list."
                : "https://github.com/org/repo — A React Native app that tracks habits. We need to add AI-powered suggestions and fix the authentication flow."}
              rows={5}
              style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
            />
          </div>

          {mode === "adopt" && (
            <div>
              <label style={labelStyle}>Repository URL <span style={{ fontWeight: 400 }}>(optional)</span></label>
              <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo" style={inputStyle} />
            </div>
          )}

          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)", color: "var(--red)", fontSize: 13 }}>
              <AlertTriangle size={13} /> {error}
            </div>
          )}
        </div>

        {/* Footer — modal mode only */}
        {!inline && (
          <div style={{ padding: "12px 22px", borderTop: "1px solid var(--surface0)", display: "flex", gap: 10 }}>
            <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 9, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "9px", borderRadius: 9, border: "none", background: "#1463ff", color: "#fff", fontSize: 13, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1, fontFamily: "var(--font-sans)" }}>
              {saving ? <><RefreshCw size={13} style={{ animation: "spin 1s linear infinite" }} /> Creating…</> : <><Sparkles size={13} /> Create Project</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
