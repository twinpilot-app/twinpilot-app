"use client";

/**
 * Hooks CRUD — Studio > Hooks tab.
 *
 * Operator-authored claude-code lifecycle hooks materialised at sprint
 * dispatch into .claude/settings.json's "hooks" section. Same shape as
 * SkillsSection / CommandsSection (factory-default ∪ project override,
 * enable/disable, slug uniqueness).
 *
 * Hooks fire on:
 *   PreToolUse / PostToolUse — before/after a tool invocation
 *   UserPromptSubmit         — when user sends a prompt
 *   Notification             — claude-code notifications
 *   Stop / SubagentStop      — session/subagent ends
 *   PreCompact               — before context compaction
 *   SessionStart / SessionEnd — session lifecycle
 *
 * Materialisation lives in writeHooksFile (services/control-plane/lib/
 * cli-executor.ts).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Pencil, ToggleLeft, ToggleRight, X, Save, AlertCircle, Eye } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { slugify } from "@/lib/slugify";

type HookEvent =
  | "PreToolUse" | "PostToolUse" | "UserPromptSubmit"
  | "Notification" | "Stop" | "SubagentStop"
  | "PreCompact" | "SessionStart" | "SessionEnd";

const EVENT_OPTIONS: { value: HookEvent; label: string; helper: string }[] = [
  { value: "PreToolUse",       label: "Before tool use",       helper: "Runs before claude invokes a tool. Matcher = tool name (Bash, Write, Edit, etc.)." },
  { value: "PostToolUse",      label: "After tool use",        helper: "Runs after claude invokes a tool. Useful for lint, log, follow-up." },
  { value: "UserPromptSubmit", label: "On user prompt",        helper: "Runs when the operator sends a prompt. Hook stdout can inject extra context." },
  { value: "Notification",     label: "On notification",       helper: "Runs for claude-code's progress / completion notifications." },
  { value: "Stop",             label: "On stop",               helper: "Runs when the session ends (success or error)." },
  { value: "SubagentStop",     label: "On subagent stop",      helper: "Runs when a subagent (Task) finishes." },
  { value: "PreCompact",       label: "Before compaction",     helper: "Runs right before claude compacts context." },
  { value: "SessionStart",     label: "Session start",         helper: "Runs when a claude-code session begins." },
  { value: "SessionEnd",       label: "Session end",           helper: "Runs when a claude-code session ends cleanly." },
];

interface HookRow {
  id:           string;
  factory_id:   string;
  project_id:   string | null;
  slug:         string;
  name:         string;
  description:  string;
  event:        HookEvent;
  matcher:      string | null;
  command:      string;
  timeout_secs: number;
  enabled:      boolean;
  origin:       "custom" | "marketplace" | "github-import" | "built-in";
  origin_id:    string | null;
  created_at:   string;
  updated_at:   string;
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 12px", borderRadius: 7,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 13, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box",
};

// Shared button styles — keep visual parity with SkillsSection +
// CommandsSection so the Studio tabs read as one family.
const btnPrimary: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 6,
  border: "none", background: "var(--blue)", color: "#fff",
  fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
};
const errBanner: React.CSSProperties = {
  fontSize: 11, color: "var(--red)", padding: "6px 10px",
  background: "rgba(255,77,77,0.08)", border: "1px solid rgba(255,77,77,0.25)",
  borderRadius: 6, marginBottom: 10, fontWeight: 600,
};
const muted: React.CSSProperties = { fontSize: 11, color: "var(--overlay0)", padding: "8px 0" };

export function HooksSection({ factoryId, canWrite }: {
  factoryId: string;
  canWrite:  boolean;
}) {
  const [rows,    setRows]    = useState<HookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing,   setEditing]   = useState<HookRow | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!factoryId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("factory_hooks")
      .select("*")
      .eq("factory_id", factoryId)
      .is("project_id", null)
      .order("event")
      .order("slug");
    setLoading(false);
    if (error) { setError(error.message); return; }
    setRows((data ?? []) as HookRow[]);
  }, [factoryId]);

  useEffect(() => { void load(); }, [load]);

  async function toggleEnabled(row: HookRow) {
    if (!canWrite) return;
    const { error } = await supabase
      .from("factory_hooks")
      .update({ enabled: !row.enabled })
      .eq("id", row.id);
    if (error) { setError(error.message); return; }
    setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, enabled: !r.enabled } : r));
  }

  async function deleteRow(row: HookRow) {
    if (!canWrite) return;
    if (!confirm(`Delete hook "${row.name}"?`)) return;
    const { error } = await supabase.from("factory_hooks").delete().eq("id", row.id);
    if (error) { setError(error.message); return; }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  }

  if (!factoryId) {
    return <div style={{ padding: 20, color: "var(--overlay0)", fontSize: 13 }}>Select a factory first.</div>;
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: 12, marginBottom: 8, flexWrap: "wrap",
      }}>
        <div style={{ flex: "1 1 240px", minWidth: 200 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Hooks
          </div>
          <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2 }}>
            Shell commands claude-code runs at lifecycle events. Materialised at sprint dispatch into <code style={{ fontFamily: "var(--font-mono)" }}>.claude/settings.json</code>.
          </div>
        </div>
        {canWrite && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button onClick={() => { setEditing(null); setShowModal(true); }} style={btnPrimary}>+ New hook</button>
          </div>
        )}
      </div>

      {error && <div style={errBanner}>{error}</div>}

      {loading && <div style={muted}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={muted}>
          No hooks yet. {canWrite && "Click \"+ New hook\" for guardrails (block writes, run lint, notify on stop)."}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((row) => {
            const isRef = row.origin === "marketplace" && !!row.origin_id;
            return (
              <div
                key={row.id}
                style={{
                  background: isRef ? "rgba(20,99,255,0.04)" : "var(--surface0)",
                  border: `1px solid ${isRef ? "rgba(20,99,255,0.3)" : "var(--surface1)"}`,
                  borderRadius: 9, padding: "11px 13px",
                  opacity: row.enabled ? 1 : 0.55, transition: "opacity 0.15s",
                  display: "flex", alignItems: "center", gap: 10,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{row.name}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(167,139,250,0.12)", color: "var(--mauve)", textTransform: "uppercase", letterSpacing: "0.04em", fontFamily: "var(--font-mono)" }}>
                      {row.event}
                    </span>
                    {row.matcher && (
                      <span style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>
                        matcher: {row.matcher}
                      </span>
                    )}
                  </div>
                  {row.description && (
                    <div style={{ fontSize: 11, color: "var(--subtext0)", marginBottom: 3, lineHeight: 1.4 }}>{row.description}</div>
                  )}
                  <code style={{ fontSize: 10, color: "var(--overlay1)", fontFamily: "var(--font-mono)", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.command}
                  </code>
                </div>
                {canWrite && (
                  <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
                    {isRef ? (
                      <button onClick={() => { setEditing(row); setShowModal(true); }} title="View (marketplace ref — read-only)" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--blue)", padding: 2 }}><Eye size={12} /></button>
                    ) : (
                      <button onClick={() => { setEditing(row); setShowModal(true); }} title="Edit" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2 }}><Pencil size={12} /></button>
                    )}
                    {!isRef && (
                      <button onClick={() => deleteRow(row)} title="Delete" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2 }}><Trash2 size={12} /></button>
                    )}
                    <button onClick={() => toggleEnabled(row)} title={row.enabled ? "Disable" : "Enable"} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 2 }}>
                      {row.enabled ? <ToggleRight size={20} color="var(--green)" /> : <ToggleLeft size={20} color="var(--overlay0)" />}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <HookEditor
          factoryId={factoryId}
          row={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function HookEditor({ factoryId, row, onClose, onSaved }: {
  factoryId: string;
  row:       HookRow | null;
  onClose:   () => void;
  onSaved:   () => void;
}) {
  const isNew = !row;
  const isRef = !isNew && row.origin === "marketplace" && !!row.origin_id;
  const [slug, setSlug]               = useState(row?.slug ?? "");
  const [name, setName]               = useState(row?.name ?? "");
  const [description, setDescription] = useState(row?.description ?? "");
  const [event, setEvent]             = useState<HookEvent>(row?.event ?? "PreToolUse");
  const [matcher, setMatcher]         = useState(row?.matcher ?? "");
  const [command, setCommand]         = useState(row?.command ?? "");
  const [timeout, setTimeout]         = useState(row?.timeout_secs ?? 60);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);

  async function save() {
    if (!slug.trim() || !name.trim() || !command.trim()) {
      setError("Slug, Name, and Command are required.");
      return;
    }
    setSaving(true);
    setError(null);
    const cleanSlug = slugify(slug.trim(), { keepDashes: true });
    const payload = {
      factory_id:   factoryId,
      project_id:   null,
      slug:         cleanSlug,
      name:         name.trim(),
      description:  description.trim().slice(0, 500),
      event,
      matcher:      matcher.trim() || null,
      command:      command.trim(),
      timeout_secs: Math.max(1, Math.min(600, Number(timeout) || 60)),
      origin:       "custom" as const,
    };
    try {
      const { error: err } = isNew
        ? await supabase.from("factory_hooks").insert(payload)
        : await supabase.from("factory_hooks").update(payload).eq("id", row!.id);
      if (err) throw new Error(err.message);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const eventHelper = EVENT_OPTIONS.find((o) => o.value === event)?.helper ?? "";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, width: "min(720px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {isNew ? "New hook" : isRef ? `View: ${row!.name}` : `Edit: ${row!.name}`}
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ padding: "16px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Slug</label>
              <input
                value={slug}
                onChange={(e) => setSlug(slugify(e.target.value, { keepDashes: true }))}
                placeholder="lint-after-edit"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                disabled={isRef || !isNew}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Lint after every Write/Edit"
                style={inputStyle}
                disabled={isRef}
              />
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Description (optional)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Why this hook exists; what it guards."
              style={inputStyle}
              disabled={isRef}
              maxLength={500}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px", gap: 10 }}>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Event</label>
              <select
                value={event}
                onChange={(e) => setEvent(e.target.value as HookEvent)}
                style={inputStyle}
                disabled={isRef}
              >
                {EVENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.value} · {opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Matcher (optional)</label>
              <input
                value={matcher}
                onChange={(e) => setMatcher(e.target.value)}
                placeholder="Bash | Write | Edit"
                style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
                disabled={isRef}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Timeout (s)</label>
              <input
                type="number"
                min={1}
                max={600}
                value={timeout}
                onChange={(e) => setTimeout(Number(e.target.value))}
                style={inputStyle}
                disabled={isRef}
              />
            </div>
          </div>
          <div style={{ fontSize: 10, color: "var(--overlay0)", lineHeight: 1.5 }}>{eventHelper}</div>

          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Command (shell)</label>
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder='echo "$CLAUDE_TOOL_INPUT" | jq -r .file_path | xargs -I{} npm run lint -- {}'
              rows={6}
              style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, fontFamily: "var(--font-mono)", fontSize: 12 }}
              disabled={isRef}
            />
            <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4, lineHeight: 1.5 }}>
              Hook receives the event payload as JSON on stdin. Stdout is read by claude-code (text or JSON for context injection).
            </div>
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
