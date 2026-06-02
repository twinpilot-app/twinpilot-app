"use client";

/**
 * Permissions CRUD — Studio > Advanced > Claude Code > Permissions.
 *
 * Operator-authored allow/ask/deny rules materialised at sprint
 * dispatch into .claude/settings.json's "permissions" key. The worker
 * (writePermissionsFile in cli-executor.ts) groups them by decision
 * and writes the upstream-shaped JSON.
 *
 * Pattern syntax (free text — Claude Code itself enforces it):
 *   · Bash                    — all uses of the Bash tool
 *   · Bash(npm run *)         — glob over the tool argument
 *   · Read(/src/**\/*.ts)      — gitignore-style path matching
 *   · WebFetch(domain:x.com)  — domain match
 *   · mcp__server__tool       — explicit MCP tool reference
 *   · mcp__server__*          — wildcard MCP server
 *
 * See https://code.claude.com/docs/en/iam.md.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Pencil, ToggleLeft, ToggleRight, X, Save, AlertCircle, ShieldAlert, ShieldQuestion, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  studioSectionContainer,
  studioBtnPrimary,
  studioInputStyle,
  studioErrBanner,
  studioMuted,
  StudioSectionHeader,
} from "@/components/StudioSectionChrome";

type Decision = "allow" | "ask" | "deny";

const DECISION_META: Record<Decision, { label: string; helper: string; color: string; bg: string; Icon: React.FC<{ size?: number; color?: string }> }> = {
  allow: { label: "Allow", helper: "Auto-approve. Use sparingly — only for safe, narrow patterns.",        color: "var(--green)",  bg: "rgba(126,190,114,0.10)",  Icon: ShieldCheck    },
  ask:   { label: "Ask",   helper: "Prompt the operator before running. Adds friction with safety net.", color: "var(--peach)",  bg: "rgba(245,194,107,0.12)",  Icon: ShieldQuestion },
  deny:  { label: "Deny",  helper: "Block at the gate — Claude Code refuses to invoke.",                  color: "var(--red)",    bg: "rgba(228,75,95,0.10)",    Icon: ShieldAlert    },
};

interface RuleRow {
  id:           string;
  factory_id:   string;
  project_id:   string | null;
  decision:     Decision;
  pattern:      string;
  description:  string;
  enabled:      boolean;
  origin:       "custom" | "marketplace" | "github-import" | "built-in";
  origin_id:    string | null;
  created_at:   string;
  updated_at:   string;
}

export function PermissionsSection({ factoryId, canWrite }: {
  factoryId: string;
  canWrite:  boolean;
}) {
  const [rows,    setRows]    = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing,   setEditing]   = useState<RuleRow | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!factoryId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("factory_permission_rules")
      .select("*")
      .eq("factory_id", factoryId)
      .is("project_id", null)
      .order("decision")
      .order("pattern");
    setLoading(false);
    if (error) { setError(error.message); return; }
    setRows((data ?? []) as RuleRow[]);
  }, [factoryId]);

  useEffect(() => { void load(); }, [load]);

  async function toggleEnabled(row: RuleRow) {
    if (!canWrite) return;
    const { error } = await supabase
      .from("factory_permission_rules")
      .update({ enabled: !row.enabled })
      .eq("id", row.id);
    if (error) { setError(error.message); return; }
    setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, enabled: !r.enabled } : r));
  }

  async function deleteRow(row: RuleRow) {
    if (!canWrite) return;
    if (!confirm(`Delete ${row.decision} rule "${row.pattern}"?`)) return;
    const { error } = await supabase.from("factory_permission_rules").delete().eq("id", row.id);
    if (error) { setError(error.message); return; }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  }

  if (!factoryId) {
    return (
      <div style={studioSectionContainer}>
        <div style={studioMuted}>Select a factory first.</div>
      </div>
    );
  }

  // Group rows by decision so the table reads like the upstream JSON.
  const grouped: Record<Decision, RuleRow[]> = { allow: [], ask: [], deny: [] };
  for (const r of rows) grouped[r.decision].push(r);

  return (
    <div style={studioSectionContainer}>
      <StudioSectionHeader
        title="Permissions"
        subtitle={
          <>
            Allow / ask / deny rules for Claude Code's tool gate. Materialised at sprint dispatch into <code style={{ fontFamily: "var(--font-mono)" }}>.claude/settings.json</code> under <code style={{ fontFamily: "var(--font-mono)" }}>permissions</code>. Precedence is deny → ask → allow.
          </>
        }
        actions={canWrite && (
          <button onClick={() => { setEditing(null); setShowModal(true); }} style={studioBtnPrimary}>
            <Plus size={14} /> New rule
          </button>
        )}
      />

      {error && <div style={studioErrBanner}>{error}</div>}

      {loading && <div style={studioMuted}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={studioMuted}>
          No permission rules yet. {canWrite && "Click \"+ New rule\" to add a deny pattern (e.g. \"Bash(rm -rf *)\") or pre-approve safe commands."}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {(["deny", "ask", "allow"] as Decision[]).map((decision) => {
            const list = grouped[decision];
            if (list.length === 0) return null;
            const meta = DECISION_META[decision];
            return (
              <div key={decision}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <meta.Icon size={14} color={meta.color} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--subtext1)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {meta.label}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--overlay0)" }}>{list.length}</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {list.map((row) => {
                    const isRef = row.origin === "marketplace" && !!row.origin_id;
                    return (
                      <div
                        key={row.id}
                        style={{
                          background: isRef ? "rgba(20,99,255,0.04)" : meta.bg,
                          border: `1px solid ${isRef ? "rgba(20,99,255,0.3)" : "var(--surface1)"}`,
                          borderRadius: 10, padding: "11px 14px",
                          opacity: row.enabled ? 1 : 0.55, transition: "opacity 0.15s",
                          display: "flex", alignItems: "center", gap: 12,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <code style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", fontWeight: 600, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {row.pattern}
                          </code>
                          {row.description && (
                            <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 3, lineHeight: 1.4 }}>{row.description}</div>
                          )}
                        </div>
                        {canWrite && (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                            <button
                              onClick={() => { setEditing(row); setShowModal(true); }}
                              title={isRef ? "View (marketplace ref — read-only)" : "Edit"}
                              style={{ background: "transparent", border: "none", cursor: "pointer", color: isRef ? "var(--blue)" : "var(--overlay0)", padding: 3 }}
                            ><Pencil size={13} /></button>
                            {!isRef && (
                              <button
                                onClick={() => deleteRow(row)}
                                title="Delete"
                                style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 3 }}
                              ><Trash2 size={13} /></button>
                            )}
                            <button
                              onClick={() => toggleEnabled(row)}
                              title={row.enabled ? "Disable" : "Enable"}
                              style={{ background: "transparent", border: "none", cursor: "pointer", padding: 3 }}
                            >
                              {row.enabled ? <ToggleRight size={20} color="var(--green)" /> : <ToggleLeft size={20} color="var(--overlay0)" />}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <PermissionEditor
          factoryId={factoryId}
          row={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function PermissionEditor({ factoryId, row, onClose, onSaved }: {
  factoryId: string;
  row:       RuleRow | null;
  onClose:   () => void;
  onSaved:   () => void;
}) {
  const isNew = !row;
  const isRef = !isNew && row.origin === "marketplace" && !!row.origin_id;
  const [decision,    setDecision]    = useState<Decision>(row?.decision ?? "deny");
  const [pattern,     setPattern]     = useState(row?.pattern ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  async function save() {
    if (!pattern.trim()) { setError("Pattern is required."); return; }
    setSaving(true);
    setError(null);
    const payload = {
      factory_id:  factoryId,
      project_id:  null,
      decision,
      pattern:     pattern.trim().slice(0, 512),
      description: description.trim().slice(0, 500),
      origin:      "custom" as const,
    };
    try {
      const { error: err } = isNew
        ? await supabase.from("factory_permission_rules").insert(payload)
        : await supabase.from("factory_permission_rules").update(payload).eq("id", row!.id);
      if (err) throw new Error(err.message);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, width: "min(640px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {isNew ? "New permission rule" : isRef ? `View: ${row!.pattern}` : `Edit: ${row!.pattern}`}
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ padding: "16px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Decision</label>
            <div style={{ display: "flex", gap: 6 }}>
              {(["deny", "ask", "allow"] as Decision[]).map((d) => {
                const meta = DECISION_META[d];
                const active = decision === d;
                return (
                  <button
                    key={d}
                    onClick={() => setDecision(d)}
                    disabled={isRef}
                    style={{
                      flex: 1,
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                      padding: "10px 12px", borderRadius: 8,
                      background: active ? meta.bg : "var(--surface0)",
                      border: `1px solid ${active ? meta.color : "var(--surface1)"}`,
                      color: active ? meta.color : "var(--subtext0)",
                      fontSize: 12, fontWeight: active ? 700 : 500,
                      cursor: isRef ? "default" : "pointer",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    <meta.Icon size={13} />
                    {meta.label}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 6, lineHeight: 1.5 }}>{DECISION_META[decision].helper}</div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Pattern</label>
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder='Bash(rm -rf *)'
              style={{ ...studioInputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
              disabled={isRef}
              maxLength={512}
            />
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4, lineHeight: 1.5 }}>
              Tool name (<code>Bash</code>), tool with arg glob (<code>Bash(npm run *)</code>), file path (<code>Edit(/src/**/*.ts)</code>), domain (<code>WebFetch(domain:api.github.com)</code>), or MCP tool (<code>mcp__server__tool</code> · <code>mcp__server__*</code>).
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Description (optional)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why this rule exists; what it guards against."
              style={studioInputStyle}
              disabled={isRef}
              maxLength={500}
            />
          </div>

          {error && (
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)", color: "var(--red)", fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
              <AlertCircle size={12} /> {error}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--surface0)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "7px 14px", borderRadius: 7, border: "1px solid var(--surface1)", background: "transparent", color: "var(--text)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
            {isRef ? "Close" : "Cancel"}
          </button>
          {!isRef && (
            <button onClick={save} disabled={saving} style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1, fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", gap: 5 }}>
              <Save size={12} /> {saving ? "Saving…" : isNew ? "Create" : "Save"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
