"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2, AlertCircle, ChevronDown, Loader2, Eye, EyeOff, Save, Terminal, Trash2,
} from "lucide-react";

interface CliAgentMeta {
  id:          string;
  name:        string;
  icon:        string;
  description: string;
  vars:        { varName: string; providerIds: string[] }[];
}

const CLI_AGENTS: CliAgentMeta[] = [
  {
    id: "claude-code", name: "Claude Code", icon: "🧠",
    description: "Anthropic's headless coding agent",
    vars: [{ varName: "ANTHROPIC_API_KEY", providerIds: ["anthropic"] }],
  },
  {
    id: "aider", name: "Aider", icon: "🛠",
    description: "AI pair-programming in the terminal",
    vars: [
      { varName: "ANTHROPIC_API_KEY", providerIds: ["anthropic"] },
      { varName: "OPENAI_API_KEY",    providerIds: ["openai"] },
      { varName: "GEMINI_API_KEY",    providerIds: ["google"] },
      { varName: "DEEPSEEK_API_KEY",  providerIds: ["deepseek"] },
    ],
  },
  {
    id: "codex", name: "Codex", icon: "◆",
    description: "OpenAI's CLI coding agent",
    vars: [{ varName: "OPENAI_API_KEY", providerIds: ["openai"] }],
  },
  {
    id: "gemini-cli", name: "Gemini CLI", icon: "🌐",
    description: "Google's CLI agent powered by Gemini",
    vars: [{ varName: "GEMINI_API_KEY", providerIds: ["google"] }],
  },
  {
    id: "goose", name: "Goose", icon: "🪿",
    description: "Block's autonomous coding agent",
    vars: [
      { varName: "ANTHROPIC_API_KEY", providerIds: ["anthropic"] },
      { varName: "OPENAI_API_KEY",    providerIds: ["openai"] },
    ],
  },
  {
    id: "amp", name: "Amp", icon: "⚡",
    description: "Sourcegraph's AI coding agent",
    vars: [
      { varName: "ANTHROPIC_API_KEY", providerIds: ["anthropic"] },
      { varName: "OPENAI_API_KEY",    providerIds: ["openai"] },
    ],
  },
];

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai:    "OpenAI",
  google:    "Google",
  deepseek:  "DeepSeek",
};

interface CliAgentsSectionProps {
  tenantId: string;
  session:  { access_token: string } | null;
}

export default function CliAgentsSection({ tenantId, session }: CliAgentsSectionProps) {
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [cliConfigured, setCliConfigured] = useState<Record<string, { preview: string; updatedAt: string }>>({});

  /* Provider keys (shared with /providers page) */
  useEffect(() => {
    if (!tenantId || !session) return;
    fetch(`/api/settings/integrations?tenantId=${tenantId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (res) => {
        if (res.ok) {
          const body = await res.json() as { configured: string[] };
          setConfigured(new Set(body.configured));
        }
      });
  }, [tenantId, session]);

  /* CLI-specific keys */
  const fetchCliKeys = useCallback(async () => {
    if (!tenantId || !session) return;
    try {
      const res = await fetch(`/api/cli/providers?tenantId=${tenantId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (res.ok) {
        const body = await res.json() as { configured: Record<string, { preview: string; updatedAt: string }> };
        setCliConfigured(body.configured ?? {});
      }
    } catch { /* ignore */ }
  }, [tenantId, session]);

  useEffect(() => { if (tenantId && session) fetchCliKeys(); }, [tenantId, session, fetchCliKeys]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <div style={{ width: 38, height: 38, borderRadius: 9, background: "rgba(138,180,248,0.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Terminal size={19} color="var(--blue)" />
        </div>
        <div>
          <h2 style={{ fontSize: 17, fontWeight: 700, fontFamily: "var(--font-heading)", margin: 0 }}>
            CLI Agents
          </h2>
          <p style={{ color: "var(--subtext0)", fontSize: 12, margin: 0, marginTop: 2 }}>
            Configure API keys for headless CLI agents. You can reuse keys from API Providers or set
            CLI-specific keys.
          </p>
        </div>
      </div>

      <div style={{ height: 1, background: "var(--surface1)", margin: "16px 0" }} />

      {CLI_AGENTS.map((agent) => (
        <CliAgentCard
          key={agent.id}
          agent={agent}
          configured={configured}
          cliConfigured={cliConfigured}
          tenantId={tenantId}
          session={session}
          onCliSaved={() => fetchCliKeys()}
        />
      ))}
    </div>
  );
}

/* ── CliAgentCard ───────────────────────────────────────────────────────────── */

interface CliAgentCardProps {
  agent:         CliAgentMeta;
  configured:    Set<string>;
  cliConfigured: Record<string, { preview: string; updatedAt: string }>;
  tenantId:      string;
  session:       { access_token: string } | null;
  onCliSaved:    () => void;
}

function CliAgentCard({ agent, configured, cliConfigured, tenantId, session, onCliSaved }: CliAgentCardProps) {
  const [open,     setOpen]     = useState(false);
  const [useOwn,   setUseOwn]   = useState<Record<string, boolean>>({});
  const [values,   setValues]   = useState<Record<string, string>>({});
  const [showKey,  setShowKey]  = useState<Record<string, boolean>>({});
  const [saving,   setSaving]   = useState<Record<string, boolean>>({});
  const [saved,    setSaved]    = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [error,    setError]    = useState<string | null>(null);

  const hasAnyKey = agent.vars.some((v) => {
    const providerHas = v.providerIds.some((pid) => configured.has(`${pid}:${v.varName}`));
    const cliHas = !!cliConfigured[v.varName];
    return providerHas || cliHas;
  });

  async function handleSave(varName: string) {
    const val = values[varName]?.trim();
    if (!val) { setError("Enter a value to save"); return; }
    setSaving((s) => ({ ...s, [varName]: true })); setError(null);
    try {
      const res = await fetch("/api/cli/providers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ tenantId, varName, value: val }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? "Save failed");
      }
      setSaved((s) => ({ ...s, [varName]: true }));
      setTimeout(() => setSaved((s) => ({ ...s, [varName]: false })), 3000);
      setValues((v) => ({ ...v, [varName]: "" }));
      onCliSaved();
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setSaving((s) => ({ ...s, [varName]: false })); }
  }

  async function handleDelete(varName: string) {
    setDeleting((s) => ({ ...s, [varName]: true })); setError(null);
    try {
      const res = await fetch("/api/cli/providers", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ tenantId, varName }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? "Delete failed");
      }
      onCliSaved();
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setDeleting((s) => ({ ...s, [varName]: false })); }
  }

  return (
    <div style={{
      background: "var(--mantle)",
      border: hasAnyKey ? "1px solid rgba(28,191,107,0.3)" : "1px solid var(--surface1)",
      borderRadius: 12, overflow: "hidden", marginBottom: 8, transition: "border-color 0.2s",
    }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <div style={{
          width: 38, height: 38, borderRadius: 9, flexShrink: 0,
          background: "rgba(138,180,248,0.1)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19,
        }}>
          {agent.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{agent.name}</span>
            {hasAnyKey ? (
              <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11, color: "var(--green)", fontWeight: 600 }}>
                <CheckCircle2 size={11} /> Ready
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "var(--overlay0)" }}>Not configured</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 1 }}>
            {agent.description}
          </div>
        </div>
        <ChevronDown size={14} color="var(--overlay0)" style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>

      {open && (
        <div style={{ borderTop: "1px solid var(--surface0)", padding: "16px" }}>
          <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 14 }}>
            Needs: {agent.vars.map((v) => v.varName).join(", ")}
            <span style={{ marginLeft: 6, fontStyle: "italic" }}>
              ({agent.vars.length > 1 ? "any one is enough" : "required"})
            </span>
          </div>

          {agent.vars.map((v) => {
            const providerHas = v.providerIds.some((pid) => configured.has(`${pid}:${v.varName}`));
            const cliHas = !!cliConfigured[v.varName];
            const isUseOwn = useOwn[v.varName] ?? false;
            const providerName = PROVIDER_NAMES[v.providerIds[0] ?? ""] ?? v.providerIds[0];

            return (
              <div key={v.varName} style={{ marginBottom: 14, padding: "12px 14px", background: "var(--surface0)", borderRadius: 9 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <code style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{v.varName}</code>
                    {(providerHas || cliHas) && (
                      <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--green)", fontWeight: 600 }}>
                        <CheckCircle2 size={10} /> {cliHas ? "CLI key set" : "Provider key"}
                      </span>
                    )}
                  </div>
                  {cliHas && (
                    <button
                      onClick={() => handleDelete(v.varName)}
                      disabled={!!deleting[v.varName]}
                      title="Remove CLI-specific key"
                      style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 6, border: "1px solid rgba(237,67,55,0.2)", background: "rgba(237,67,55,0.06)", color: "var(--red)", fontSize: 10, cursor: deleting[v.varName] ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)" }}
                    >
                      {deleting[v.varName] ? <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={10} />}
                      Remove
                    </button>
                  )}
                </div>

                {providerHas && !cliHas && (
                  <div style={{ fontSize: 11, color: "var(--subtext0)", marginBottom: 8 }}>
                    Using key from <strong>{providerName}</strong> provider.
                  </div>
                )}

                {providerHas && !cliHas && (
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 11, color: "var(--subtext1)", marginBottom: isUseOwn ? 10 : 0 }}>
                    <input
                      type="checkbox"
                      checked={isUseOwn}
                      onChange={(e) => setUseOwn((s) => ({ ...s, [v.varName]: e.target.checked }))}
                      style={{ accentColor: "#1463ff" }}
                    />
                    Set a CLI-specific key instead
                  </label>
                )}

                {(!providerHas || isUseOwn || cliHas) && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <div style={{ position: "relative", flex: 1 }}>
                      <input
                        type={showKey[v.varName] ? "text" : "password"}
                        placeholder={cliHas ? `•••••••••• (${cliConfigured[v.varName].preview}) — paste to update` : "Paste API key…"}
                        value={values[v.varName] ?? ""}
                        onChange={(e) => setValues((s) => ({ ...s, [v.varName]: e.target.value }))}
                        style={{ width: "100%", padding: "7px 32px 7px 10px", background: "var(--mantle)", border: "1px solid var(--surface1)", borderRadius: 7, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey((s) => ({ ...s, [v.varName]: !s[v.varName] }))}
                        style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 3 }}
                      >
                        {showKey[v.varName] ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    </div>
                    <button
                      onClick={() => handleSave(v.varName)}
                      disabled={!!saving[v.varName]}
                      style={{ display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", borderRadius: 7, border: "none", background: saved[v.varName] ? "rgba(28,191,107,0.15)" : "#1463ff", color: saved[v.varName] ? "var(--green)" : "#fff", fontSize: 11, fontWeight: 600, cursor: saving[v.varName] ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)", whiteSpace: "nowrap" }}
                    >
                      {saving[v.varName]
                        ? <><Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> Saving…</>
                        : saved[v.varName]
                        ? <><CheckCircle2 size={11} /> Saved</>
                        : <><Save size={11} /> Save</>}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", borderRadius: 7, background: "rgba(237,67,55,0.1)", border: "1px solid rgba(237,67,55,0.2)", color: "var(--red)", fontSize: 12 }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
