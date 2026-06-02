/**
 * /admin/platform-agents — list + edit Platform Agents (mig 190).
 *
 * Platform Agents are agents that belong to the platform (not to a
 * tenant), run in fixed hooks of the worker pipeline (commit.title,
 * sprint.summary, …), and are invisible to operators in Studio /
 * Sprint Plan pickers. They handle cheap LLM tasks that smooth the
 * operator experience: commit titles, sprint narratives, briefing
 * validation, failure translation, backlog refinement.
 *
 * This page is admin-only — covered by /admin/layout.tsx role gate.
 * Per-project model picker lives in Project Settings (separate UI);
 * this page is for catalog management (persona, version, kill switch).
 */
"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Bot, Save } from "lucide-react";
import { supabase } from "@/lib/supabase";

interface PlatformAgent {
  id:            string;
  slug:          string;
  name:          string;
  version:       string | null;
  enabled:       boolean;
  platform_hook: string | null;
  spec:          { description?: string; max_turns?: number; max_output_tokens?: number; tools?: string[] } | null;
  metadata:      Record<string, unknown> | null;
  updated_at:    string;
}

interface EditDraft {
  description:       string;
  max_turns:         number;
  max_output_tokens: number;
  enabled:           boolean;
}

export default function PlatformAgentsPage() {
  const [agents, setAgents] = useState<PlatformAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, EditDraft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setError("Not signed in"); setLoading(false); return; }
      const res = await fetch("/api/admin/platform-agents", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = await res.json() as { agents?: PlatformAgent[]; error?: string };
      if (!res.ok) { setError(body.error ?? `Load failed (${res.status})`); setLoading(false); return; }
      setAgents(body.agents ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function startEdit(a: PlatformAgent) {
    setExpandedId(a.id);
    setDrafts((prev) => ({
      ...prev,
      [a.id]: {
        description:       a.spec?.description ?? "",
        max_turns:         a.spec?.max_turns ?? 1,
        max_output_tokens: a.spec?.max_output_tokens ?? 200,
        enabled:           a.enabled,
      },
    }));
  }

  async function saveAgent(a: PlatformAgent) {
    const draft = drafts[a.id];
    if (!draft) return;
    setSaving(a.id);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setError("Not signed in"); setSaving(null); return; }
      const res = await fetch(`/api/admin/platform-agents/${a.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          description:       draft.description,
          max_turns:         draft.max_turns,
          max_output_tokens: draft.max_output_tokens,
          enabled:           draft.enabled,
        }),
      });
      const body = await res.json() as { agent?: PlatformAgent; error?: string; details?: { path: string[]; message: string }[] };
      if (!res.ok) {
        const detail = body.details?.length ? `: ${body.details.map((d) => `${d.path.join(".")} ${d.message}`).join("; ")}` : "";
        setError(`${body.error ?? `Save failed (${res.status})`}${detail}`);
        return;
      }
      setAgents((prev) => prev.map((x) => x.id === a.id ? body.agent! : x));
      setFlash("Saved.");
      setTimeout(() => setFlash(null), 2500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  async function toggleEnabled(a: PlatformAgent) {
    setSaving(a.id);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { setSaving(null); return; }
      const res = await fetch(`/api/admin/platform-agents/${a.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !a.enabled }),
      });
      const body = await res.json() as { agent?: PlatformAgent; error?: string };
      if (!res.ok) { setError(body.error ?? "Toggle failed"); return; }
      setAgents((prev) => prev.map((x) => x.id === a.id ? body.agent! : x));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div style={{ padding: "32px 28px", maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <Bot size={24} color="var(--mauve)" />
        <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", margin: 0 }}>Platform Agents</h1>
      </div>
      <p style={{ fontSize: 13, color: "var(--subtext0)", lineHeight: 1.55, marginBottom: 22, maxWidth: 720 }}>
        Agents that belong to the platform — they run in fixed hooks of the
        sprint flow (post-flight commit titles, sprint narratives, briefing
        validation, failure translation, …) with tight LLM budgets. They&apos;re
        invisible to operators in Studio / Sprint Plan; on any failure the
        worker falls back to a deterministic heuristic so a sprint never
        breaks because of a platform agent. Per-project model selection
        lives in Project Settings → Platform Agents.
      </p>

      {flash && (
        <div style={{ padding: "10px 14px", marginBottom: 14, borderRadius: 8, background: "rgba(28,191,107,0.1)", color: "var(--green)", fontSize: 12, border: "1px solid rgba(28,191,107,0.3)" }}>
          {flash}
        </div>
      )}
      {error && (
        <div style={{ padding: "10px 14px", marginBottom: 14, borderRadius: 8, background: "rgba(228,75,95,0.1)", color: "var(--red)", fontSize: 12, border: "1px solid rgba(228,75,95,0.3)" }}>
          {error}
        </div>
      )}

      {loading && <div style={{ color: "var(--overlay0)", fontSize: 14 }}>Loading…</div>}

      {!loading && agents.length === 0 && (
        <div style={{ padding: "24px 20px", borderRadius: 12, background: "var(--mantle)", border: "1px solid var(--surface0)", color: "var(--overlay0)", fontSize: 13 }}>
          No platform agents registered yet. Apply migration 190 to seed the catalog.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {agents.map((a) => {
          const expanded = expandedId === a.id;
          const draft = drafts[a.id];
          return (
            <div key={a.id} style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{a.name}</span>
                    <code style={{ fontSize: 11, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{a.slug}</code>
                    {a.version && <span style={{ fontSize: 10, color: "var(--overlay1)" }}>v{a.version}</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--subtext0)" }}>
                    <span>
                      Hook:{" "}
                      <code style={{ fontFamily: "var(--font-mono)", color: "var(--mauve)" }}>{a.platform_hook ?? "(none)"}</code>
                    </span>
                    <span>Tools: {(a.spec?.tools ?? []).length === 0 ? "none" : (a.spec?.tools ?? []).join(", ")}</span>
                    <span>max_turns: {a.spec?.max_turns ?? 1}</span>
                    <span>max_tokens: {a.spec?.max_output_tokens ?? 200}</span>
                  </div>
                </div>
                <button
                  onClick={() => toggleEnabled(a)}
                  disabled={saving === a.id}
                  style={{
                    padding: "5px 12px", borderRadius: 6,
                    background: a.enabled ? "rgba(28,191,107,0.15)" : "rgba(243,139,168,0.15)",
                    color: a.enabled ? "var(--green)" : "var(--red)",
                    border: `1px solid ${a.enabled ? "rgba(28,191,107,0.4)" : "rgba(243,139,168,0.4)"}`,
                    fontSize: 11, fontWeight: 700, cursor: "pointer",
                  }}
                >
                  {a.enabled ? "Enabled" : "Disabled"}
                </button>
                <button
                  onClick={() => expanded ? setExpandedId(null) : startEdit(a)}
                  style={{ padding: "5px 12px", borderRadius: 6, background: "transparent", border: "1px solid var(--surface1)", color: "var(--text)", fontSize: 11, cursor: "pointer" }}
                >
                  {expanded ? "Close" : "Edit"}
                </button>
              </div>

              {expanded && draft && (
                <div style={{ padding: "14px 18px", borderTop: "1px solid var(--surface0)", background: "var(--base)" }}>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ display: "block", fontSize: 11, color: "var(--subtext0)", marginBottom: 4 }}>Persona (spec.description)</label>
                    <textarea
                      value={draft.description}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [a.id]: { ...draft, description: e.target.value } }))}
                      rows={20}
                      style={{
                        width: "100%", fontSize: 12, fontFamily: "var(--font-mono)",
                        padding: "10px 12px", borderRadius: 8,
                        background: "var(--mantle)", border: "1px solid var(--surface1)",
                        color: "var(--text)", resize: "vertical",
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
                    <div>
                      <label style={{ display: "block", fontSize: 11, color: "var(--subtext0)", marginBottom: 4 }}>max_turns</label>
                      <input
                        type="number" min={1} max={10}
                        value={draft.max_turns}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [a.id]: { ...draft, max_turns: Number(e.target.value) || 1 } }))}
                        style={{ width: 80, fontSize: 12, padding: "6px 10px", borderRadius: 6, background: "var(--mantle)", border: "1px solid var(--surface1)", color: "var(--text)" }}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: 11, color: "var(--subtext0)", marginBottom: 4 }}>max_output_tokens</label>
                      <input
                        type="number" min={1} max={4096}
                        value={draft.max_output_tokens}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [a.id]: { ...draft, max_output_tokens: Number(e.target.value) || 200 } }))}
                        style={{ width: 100, fontSize: 12, padding: "6px 10px", borderRadius: 6, background: "var(--mantle)", border: "1px solid var(--surface1)", color: "var(--text)" }}
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => saveAgent(a)}
                    disabled={saving === a.id}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 16px", borderRadius: 8, border: "none",
                      background: "var(--blue)", color: "var(--crust)",
                      fontSize: 12, fontWeight: 700, cursor: saving === a.id ? "wait" : "pointer",
                      opacity: saving === a.id ? 0.6 : 1,
                    }}
                  >
                    <Save size={12} />
                    {saving === a.id ? "Saving…" : "Save persona"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
