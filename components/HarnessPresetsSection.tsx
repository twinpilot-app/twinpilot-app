"use client";

/**
 * HarnessPresetsSection — Factory Manager panel listing the factory's
 * harness presets. BL-26 Phase 4.
 *
 * Slice 1 shipped a JSON textarea editor; this slice 2 adds a field-by-
 * field form for the known keys (cli/model/max_turns/effort/...) plus a
 * JSON tab as escape hatch for fields the form doesn't surface.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, Wand2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { FactorySection } from "@/components/FactorySection";

interface HarnessPreset {
  id:          string;
  slug:        string;
  name:        string;
  description: string | null;
  config:      Record<string, unknown>;
  created_at:  string;
  updated_at:  string;
}

interface Props {
  factoryId: string;
  canWrite:  boolean;
}

/** Subset of CliAgentOverride that's stable enough to surface as a
 *  dedicated form field. Keys not listed here can still be set via the
 *  JSON tab — the worker reads everything that fits the override
 *  shape. */
type FieldKey =
  | "cli"
  | "model"
  | "auth_mode"
  | "max_turns"
  | "timeout_secs"
  | "effort"
  | "append_system_prompt"
  | "planMode"
  | "budgetUsd";

const SUPPORTED_CLIS = ["claude-code", "aider", "codex", "plandex", "goose", "amp", "gemini-cli"] as const;
const AUTH_MODES     = ["api-key", "oauth"] as const;
const EFFORTS        = ["low", "medium", "high", "max"] as const;

const FIELD_LABEL: Record<FieldKey, string> = {
  cli:                 "CLI",
  model:               "Model",
  auth_mode:           "Auth mode",
  max_turns:           "Max turns",
  timeout_secs:        "Timeout (s)",
  effort:              "Effort",
  append_system_prompt:"Append to system prompt",
  planMode:            "Plan mode (no writes)",
  budgetUsd:           "Budget (USD)",
};

interface EditingState {
  id:          string | null;
  name:        string;
  slug:        string;
  description: string;
  /** Structured form state — fields the form explicitly knows about. */
  form:        Record<FieldKey, string>;
  /** Anything the form doesn't render. Round-tripped through the JSON
   *  tab + saved alongside the form fields. */
  extras:      Record<string, unknown>;
  /** Which tab is active. JSON shows the full merged config. */
  tab:         "fields" | "json";
  /** Pending JSON text in the JSON tab. Parsed on save. */
  jsonText:    string;
}

function emptyForm(): Record<FieldKey, string> {
  return {
    cli:                  "",
    model:                "",
    auth_mode:            "",
    max_turns:            "",
    timeout_secs:         "",
    effort:               "",
    append_system_prompt: "",
    planMode:             "",
    budgetUsd:            "",
  };
}

const KNOWN_KEYS = new Set<FieldKey>([
  "cli", "model", "auth_mode", "max_turns", "timeout_secs",
  "effort", "append_system_prompt", "planMode", "budgetUsd",
]);

/** Split an existing config into form fields + extras (anything not in
 *  KNOWN_KEYS gets passed through untouched). */
function configToEditingState(cfg: Record<string, unknown>): { form: Record<FieldKey, string>; extras: Record<string, unknown> } {
  const form = emptyForm();
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (KNOWN_KEYS.has(k as FieldKey)) {
      const key = k as FieldKey;
      if (key === "planMode") {
        form[key] = v === true ? "true" : v === false ? "false" : "";
      } else if (v == null) {
        form[key] = "";
      } else {
        form[key] = String(v);
      }
    } else {
      extras[k] = v;
    }
  }
  return { form, extras };
}

/** Build a config object from the form + extras. Empty strings drop
 *  the field (no key emitted) so an empty form means "preset has no
 *  opinion on this dimension". */
function editingStateToConfig(form: Record<FieldKey, string>, extras: Record<string, unknown>): Record<string, unknown> {
  const cfg: Record<string, unknown> = { ...extras };
  for (const [k, v] of Object.entries(form)) {
    if (v === "") continue;
    const key = k as FieldKey;
    if (key === "max_turns" || key === "timeout_secs" || key === "budgetUsd") {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      cfg[key] = n;
    } else if (key === "planMode") {
      cfg[key] = v === "true";
    } else {
      cfg[key] = v;
    }
  }
  return cfg;
}

export function HarnessPresetsSection({ factoryId, canWrite }: Props) {
  const [open, setOpen]         = useState(false);
  const [presets, setPresets]   = useState<HarnessPreset[]>([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [editing, setEditing]   = useState<EditingState | null>(null);
  const [busy, setBusy]         = useState(false);

  const refresh = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch(`/api/factory/harness-presets?factoryId=${encodeURIComponent(factoryId)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = await res.json() as { presets?: HarnessPreset[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Failed (${res.status})`);
      setPresets(body.presets ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [factoryId, open]);

  useEffect(() => { void refresh(); }, [refresh]);

  function startNew() {
    setEditing({
      id: null,
      name: "",
      slug: "",
      description: "",
      form: emptyForm(),
      extras: {},
      tab: "fields",
      jsonText: "{}",
    });
  }

  function startEdit(p: HarnessPreset) {
    const { form, extras } = configToEditingState(p.config ?? {});
    setEditing({
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description ?? "",
      form,
      extras,
      tab: "fields",
      jsonText: JSON.stringify(p.config ?? {}, null, 2),
    });
  }

  /** Switch tabs while preserving edits. Each direction reconciles the
   *  pending state with the other view so flipping back-and-forth doesn't
   *  drop changes. */
  function switchTab(next: "fields" | "json") {
    if (!editing || editing.tab === next) return;
    if (next === "json") {
      const merged = editingStateToConfig(editing.form, editing.extras);
      setEditing({ ...editing, tab: "json", jsonText: JSON.stringify(merged, null, 2) });
    } else {
      try {
        const parsed = JSON.parse(editing.jsonText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("Config must be a JSON object");
        }
        const { form, extras } = configToEditingState(parsed as Record<string, unknown>);
        setEditing({ ...editing, tab: "fields", form, extras });
        setError(null);
      } catch (e) {
        setError(`Cannot switch to fields — invalid JSON: ${(e as Error).message}`);
      }
    }
  }

  async function save() {
    if (!editing) return;
    let parsed: Record<string, unknown>;
    if (editing.tab === "json") {
      try {
        const j = JSON.parse(editing.jsonText);
        if (typeof j !== "object" || j === null || Array.isArray(j)) {
          throw new Error("Config must be a JSON object");
        }
        parsed = j as Record<string, unknown>;
      } catch (e) {
        setError(`Invalid JSON: ${(e as Error).message}`);
        return;
      }
    } else {
      parsed = editingStateToConfig(editing.form, editing.extras);
    }

    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");

      const isUpdate = editing.id !== null;
      const url = isUpdate
        ? `/api/factory/harness-presets/${editing.id}`
        : `/api/factory/harness-presets`;
      const method = isUpdate ? "PATCH" : "POST";
      const payload: Record<string, unknown> = {
        name:        editing.name,
        slug:        editing.slug || undefined,
        description: editing.description || null,
        config:      parsed,
      };
      if (!isUpdate) payload.factoryId = factoryId;

      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Failed (${res.status})`);
      setEditing(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete preset "${name}"? Agents that reference it will fall back to their own config.`)) return;
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch(`/api/factory/harness-presets/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Failed (${res.status})`);
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const newButton = open && canWrite && !editing ? (
    <button
      onClick={(e) => { e.stopPropagation(); startNew(); }}
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "4px 10px", borderRadius: 6, border: "none",
        background: "var(--blue)", color: "#fff",
        fontSize: 11, fontWeight: 600, cursor: "pointer",
      }}
    >
      <Plus size={12} /> New preset
    </button>
  ) : null;

  return (
    <FactorySection
      title="Harness Presets"
      icon={<Wand2 size={14} />}
      subtitle={presets.length === 0 ? "no presets configured" : `${presets.length} configured`}
      right={newButton}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
          <div style={{ fontSize: 11, color: "var(--subtext0)", marginBottom: 10, lineHeight: 1.5 }}>
            Reusable agent harness bundles — cli, model, max_turns, effort, append_system_prompt, etc.
            Per-agent overrides reference a preset by id; the worker merges <code>preset.config</code> under
            the override at dispatch (override fields always win).
          </div>

          {error && (
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)", color: "var(--red)", fontSize: 12, marginBottom: 10 }}>
              {error}
            </div>
          )}

          {loading && <div style={{ fontSize: 12, color: "var(--overlay0)" }}>Loading…</div>}

          {!loading && presets.length === 0 && !editing && (
            <div style={{ fontSize: 12, color: "var(--overlay0)", padding: "12px 0" }}>
              No presets yet. Click <strong>New preset</strong> to create the first one.
            </div>
          )}

          {!editing && presets.map((p) => (
            <div key={p.id} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 10px", borderRadius: 6,
              background: "var(--base)", border: "1px solid var(--surface0)",
              marginBottom: 6,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                  {p.name} <span style={{ fontSize: 10, fontWeight: 400, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>·  @{p.slug}</span>
                </div>
                {p.description && (
                  <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 2 }}>{p.description}</div>
                )}
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
                  {Object.keys(p.config).length} key{Object.keys(p.config).length === 1 ? "" : "s"}: {Object.keys(p.config).slice(0, 4).join(", ")}{Object.keys(p.config).length > 4 ? "…" : ""}
                </div>
              </div>
              {canWrite && (
                <>
                  <button onClick={() => startEdit(p)} style={{ background: "none", border: "1px solid var(--surface1)", borderRadius: 5, padding: "4px 10px", fontSize: 11, color: "var(--subtext0)", cursor: "pointer" }}>
                    Edit
                  </button>
                  <button
                    onClick={() => remove(p.id, p.name)}
                    disabled={busy}
                    title="Delete preset"
                    style={{ background: "none", border: "none", color: "var(--red)", cursor: "pointer", padding: 4, display: "flex", opacity: busy ? 0.4 : 0.7 }}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
            </div>
          ))}

          {editing && (
            <PresetEditor
              editing={editing}
              setEditing={setEditing}
              onCancel={() => setEditing(null)}
              onSave={save}
              onSwitchTab={switchTab}
              busy={busy}
            />
          )}
    </FactorySection>
  );
}

function PresetEditor({
  editing, setEditing, onCancel, onSave, onSwitchTab, busy,
}: {
  editing:     EditingState;
  setEditing:  (s: EditingState) => void;
  onCancel:    () => void;
  onSave:      () => void;
  onSwitchTab: (t: "fields" | "json") => void;
  busy:        boolean;
}) {
  const setForm = (key: FieldKey, value: string) =>
    setEditing({ ...editing, form: { ...editing.form, [key]: value } });

  const extrasCount = useMemo(() => Object.keys(editing.extras).length, [editing.extras]);

  return (
    <div style={{ background: "var(--base)", border: "1px solid var(--surface1)", borderRadius: 8, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>{editing.id ? "Edit preset" : "New preset"}</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onCancel}
          style={{ background: "none", border: "none", color: "var(--overlay0)", cursor: "pointer", padding: 4, display: "flex" }}
        >
          <X size={14} />
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8, marginBottom: 8 }}>
        <input
          placeholder="Name (e.g. Engineering default)"
          value={editing.name}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          style={inputStyle}
        />
        <input
          placeholder="slug (auto from name if empty)"
          value={editing.slug}
          onChange={(e) => setEditing({ ...editing, slug: e.target.value })}
          style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
        />
      </div>

      <input
        placeholder="Description (optional)"
        value={editing.description}
        onChange={(e) => setEditing({ ...editing, description: e.target.value })}
        style={{ ...inputStyle, marginBottom: 12 }}
      />

      {/* Tab switcher — Fields ⇄ JSON */}
      <div style={{ display: "flex", gap: 4, marginBottom: 10, borderBottom: "1px solid var(--surface1)" }}>
        {(["fields", "json"] as const).map((t) => (
          <button
            key={t}
            onClick={() => onSwitchTab(t)}
            style={{
              padding: "5px 12px", border: "none", background: "transparent",
              fontSize: 11, fontWeight: 600,
              color: editing.tab === t ? "var(--text)" : "var(--overlay0)",
              borderBottom: editing.tab === t ? "2px solid var(--blue)" : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {t === "fields" ? "Fields" : "JSON"}
            {t === "fields" && extrasCount > 0 && (
              <span style={{ marginLeft: 6, fontSize: 9, color: "var(--mauve)" }}>
                +{extrasCount} extra{extrasCount === 1 ? "" : "s"}
              </span>
            )}
          </button>
        ))}
      </div>

      {editing.tab === "fields" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <FormSelect
            label={FIELD_LABEL.cli}
            value={editing.form.cli}
            options={SUPPORTED_CLIS}
            onChange={(v) => setForm("cli", v)}
            placeholder="(no preference)"
          />
          <FormInput
            label={FIELD_LABEL.model}
            value={editing.form.model}
            onChange={(v) => setForm("model", v)}
            placeholder="e.g. sonnet-4.6"
          />
          <FormSelect
            label={FIELD_LABEL.auth_mode}
            value={editing.form.auth_mode}
            options={AUTH_MODES}
            onChange={(v) => setForm("auth_mode", v)}
            placeholder="(infer from mode)"
          />
          <FormSelect
            label={FIELD_LABEL.effort}
            value={editing.form.effort}
            options={EFFORTS}
            onChange={(v) => setForm("effort", v)}
            placeholder="(default)"
          />
          <FormInput
            label={FIELD_LABEL.max_turns}
            value={editing.form.max_turns}
            onChange={(v) => setForm("max_turns", v)}
            placeholder="20"
            type="number"
          />
          <FormInput
            label={FIELD_LABEL.timeout_secs}
            value={editing.form.timeout_secs}
            onChange={(v) => setForm("timeout_secs", v)}
            placeholder="600"
            type="number"
          />
          <FormInput
            label={FIELD_LABEL.budgetUsd}
            value={editing.form.budgetUsd}
            onChange={(v) => setForm("budgetUsd", v)}
            placeholder="(no cap)"
            type="number"
          />
          <FormSelect
            label={FIELD_LABEL.planMode}
            value={editing.form.planMode}
            options={["true", "false"]}
            onChange={(v) => setForm("planMode", v)}
            placeholder="(off)"
          />
          <div style={{ gridColumn: "1 / -1" }}>
            <FormTextarea
              label={FIELD_LABEL.append_system_prompt}
              value={editing.form.append_system_prompt}
              onChange={(v) => setForm("append_system_prompt", v)}
              placeholder="Extra instructions injected at model level via --append-system-prompt"
              rows={3}
            />
          </div>
          {extrasCount > 0 && (
            <div style={{ gridColumn: "1 / -1", padding: "6px 8px", borderRadius: 5, background: "var(--surface0)", fontSize: 10, color: "var(--mauve)", lineHeight: 1.5 }}>
              <strong>{extrasCount}</strong> extra key{extrasCount === 1 ? "" : "s"} preserved through the JSON tab: <code>{Object.keys(editing.extras).join(", ")}</code>. Edit them on the JSON tab.
            </div>
          )}
        </div>
      ) : (
        <>
          <textarea
            value={editing.jsonText}
            onChange={(e) => setEditing({ ...editing, jsonText: e.target.value })}
            rows={14}
            spellCheck={false}
            style={{
              width: "100%", padding: "8px 10px", borderRadius: 6,
              background: "var(--surface0)", border: "1px solid var(--surface1)",
              color: "var(--text)", fontSize: 12, outline: "none",
              fontFamily: "var(--font-mono)", resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
            JSON object. Anything you put here is saved verbatim — use the JSON tab when you need a key the Fields tab doesn&apos;t expose.
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          onClick={onSave}
          disabled={busy || !editing.name.trim()}
          style={{
            display: "flex", alignItems: "center", gap: 4,
            padding: "6px 14px", borderRadius: 6, border: "none",
            background: busy ? "var(--surface1)" : "var(--blue)",
            color: busy ? "var(--overlay0)" : "#fff",
            fontSize: 12, fontWeight: 600,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          <Save size={12} /> {busy ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onCancel}
          style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 12, cursor: "pointer" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FormInput({
  label, value, onChange, placeholder, type,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: "text" | "number";
}) {
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <input
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={inputStyle}
      />
    </div>
  );
}

function FormTextarea({
  label, value, onChange, placeholder, rows,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; rows?: number;
}) {
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows ?? 2}
        style={{ ...inputStyle, resize: "vertical", lineHeight: 1.4 }}
      />
    </div>
  );
}

function FormSelect({
  label, value, options, onChange, placeholder,
}: {
  label: string; value: string; options: readonly string[];
  onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div>
      <label style={fieldLabelStyle}>{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      >
        <option value="">{placeholder ?? "—"}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "7px 10px", borderRadius: 6,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 12, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box",
};

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10, fontWeight: 600,
  color: "var(--subtext0)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
