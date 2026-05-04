"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  GitBranch, Plus, Save, Trash2, X, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2, Zap, Pencil,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { FactorySection } from "@/components/FactorySection";

/**
 * Per-factory GitHub output destinations. Renders a collapsible
 * section inside the Factory Manager card. Lists existing
 * destinations, lets owner/admin users add/update/remove entries.
 *
 * This replaces the previous "Storage Repository" concept which
 * persisted a single owner+repo+branch per factory. The new model
 * decouples the destination (owner + PAT) from the repo: projects
 * pick one or more destinations, and the sprint push flow creates
 * a repo under each destination using the project slug.
 */

export interface OutputDestination {
  id:        string;
  name:      string;
  owner:     string;
  tokenMask: string;
  branch:    string | null;
  createdAt: string;
  updatedAt: string;
}

interface VerifyResult {
  ok:            boolean;
  tokenUser?:    string;
  ownerType?:    "User" | "Organization";
  canWriteRepo?: boolean;
  error?:        string;
}

interface FormDraft {
  name:   string;
  owner:  string;
  token:  string;
  branch: string;
  // true while the user is editing an existing row — token is optional
  // (empty means "keep the existing token").
  editId: string | null;
}

const EMPTY_FORM: FormDraft = { name: "", owner: "", token: "", branch: "", editId: null };

export function FactoryOutputDestinations({
  factoryId,
  canWrite,
}: {
  factoryId: string;
  /** Only owner/admin roles may mutate. Hides action buttons when false. */
  canWrite: boolean;
}) {
  const [open, setOpen]                 = useState(false);
  const [loading, setLoading]           = useState(false);
  const [items, setItems]               = useState<OutputDestination[]>([]);
  const [formOpen, setFormOpen]         = useState(false);
  const [form, setForm]                 = useState<FormDraft>(EMPTY_FORM);
  const [tokenShown, setTokenShown]     = useState(false);
  const [busy, setBusy]                 = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [flash, setFlash]               = useState<string | null>(null);
  // Verify results keyed by destination id ("form" for the unsaved
  // form). Keeping the per-row feedback here means a test in the form
  // doesn't blow away a green check on an existing row, and vice versa.
  const [verifying, setVerifying]       = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, VerifyResult>>({});

  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2200);
  }, []);

  const authedFetch = useCallback(async (path: string, init?: RequestInit) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("Not signed in");
    const res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return res.json();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await authedFetch(`/api/factory/output-destinations?factoryId=${factoryId}`);
      setItems((body.destinations ?? []) as OutputDestination[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [factoryId, authedFetch]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  /* ── Form handlers ───────────────────────────────────────── */

  function startCreate() {
    setForm(EMPTY_FORM);
    setFormOpen(true);
    setTokenShown(false);
  }

  function startEdit(dest: OutputDestination) {
    setForm({
      name:   dest.name,
      owner:  dest.owner,
      token:  "",
      branch: dest.branch ?? "",
      editId: dest.id,
    });
    setFormOpen(true);
    setTokenShown(false);
  }

  function cancel() {
    setFormOpen(false);
    setForm(EMPTY_FORM);
  }

  async function save() {
    if (!form.name.trim() || !form.owner.trim()) {
      setError("Name and owner are required.");
      return;
    }
    if (!form.editId && !form.token.trim()) {
      setError("Personal Access Token is required.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (form.editId) {
        const body: Record<string, unknown> = {
          name:   form.name.trim(),
          owner:  form.owner.trim(),
          branch: form.branch.trim() || null,
        };
        if (form.token.trim()) body.token = form.token.trim();
        await authedFetch(`/api/factory/output-destinations/${form.editId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        showFlash("Destination updated.");
      } else {
        await authedFetch(`/api/factory/output-destinations`, {
          method: "POST",
          body: JSON.stringify({
            factoryId,
            name:   form.name.trim(),
            owner:  form.owner.trim(),
            token:  form.token.trim(),
            branch: form.branch.trim() || null,
          }),
        });
        showFlash("Destination added.");
      }
      cancel();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Verify a destination against GitHub.
   *   - `savedId` → test a saved row (server uses the stored token).
   *   - otherwise → test the inline form credentials (owner + token).
   */
  async function test(savedId?: string) {
    const key = savedId ?? "form";
    setVerifying(key);
    setVerifyResults((prev) => ({ ...prev, [key]: { ok: false } }));
    try {
      const body: Record<string, unknown> = savedId
        ? { id: savedId }
        : { factoryId, owner: form.owner.trim(), token: form.token.trim() };
      const res = await authedFetch(`/api/factory/output-destinations/verify`, {
        method: "POST",
        body: JSON.stringify(body),
      }) as VerifyResult;
      setVerifyResults((prev) => ({ ...prev, [key]: res }));
    } catch (e) {
      setVerifyResults((prev) => ({ ...prev, [key]: { ok: false, error: (e as Error).message } }));
    } finally {
      setVerifying(null);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Remove destination "${name}"? Projects using it will lose this target.`)) return;
    setBusy(true);
    try {
      await authedFetch(`/api/factory/output-destinations/${id}`, { method: "DELETE" });
      showFlash("Destination removed.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <FactorySection
      title="Output Destinations"
      icon={<GitBranch size={14} />}
      subtitle={items.length > 0 ? `${items.length} configured` : "no destinations yet"}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    >
        <p style={{ fontSize: 11, color: "var(--overlay1)", margin: "0 0 10px", lineHeight: 1.5 }}>
          GitHub owners where this factory&apos;s projects push sprint artifacts. Projects select one or more
          of these (plus the global destination from Storage). Sprints auto-create missing repos using
          the project slug.
        </p>

          {loading && <div style={{ fontSize: 12, color: "var(--overlay0)" }}>Loading…</div>}

          {!loading && items.length === 0 && !formOpen && (
            <div style={{ fontSize: 12, color: "var(--overlay0)", padding: "8px 0" }}>
              No destinations yet.
            </div>
          )}

          {!loading && items.map((d) => {
            const vr = verifyResults[d.id];
            const isVerifying = verifying === d.id;
            return (
              <div key={d.id} style={{
                padding: "8px 10px", marginBottom: 6,
                background: "var(--surface0)", borderRadius: 7,
                border: "1px solid var(--surface1)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{d.name}</div>
                    <div style={{ fontSize: 11, color: "var(--subtext0)", fontFamily: "var(--font-mono)" }}>
                      {d.owner} · token {d.tokenMask}
                      {d.branch && <> · branch {d.branch}</>}
                    </div>
                  </div>
                  <button onClick={() => test(d.id)} disabled={isVerifying} title="Test this destination" style={iconBtn}>
                    {isVerifying ? <Loader2 size={12} className="spin" /> : <Zap size={12} />}
                  </button>
                  {canWrite && (
                    <>
                      <button onClick={() => startEdit(d)} title="Edit" style={iconBtn}>
                        <Pencil size={12} />
                      </button>
                      <button onClick={() => remove(d.id, d.name)} title="Remove" style={{ ...iconBtn, color: "var(--red)" }}>
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
                {vr && <VerifyFeedback result={vr} />}
              </div>
            );
          })}

          {formOpen ? (
            <div style={{
              marginTop: 6, padding: 12,
              background: "var(--crust)", borderRadius: 7,
              border: "1px solid var(--surface1)",
            }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <FieldLabel label="Name" hint="A label for this destination — e.g. “acme-prod”." />
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="acme-prod"
                  style={inputStyle}
                />

                <FieldLabel label="Owner" hint="GitHub username or organisation (no leading @, no URL)." />
                <input
                  value={form.owner}
                  onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
                  placeholder="your-org"
                  style={inputStyle}
                />

                <FieldLabel
                  label={form.editId ? "Personal Access Token (leave blank to keep)" : "Personal Access Token"}
                  hint={form.editId ? "Provide a new PAT only if rotating." : "GitHub PAT with repo scope."}
                />
                <div style={{ position: "relative" }}>
                  <input
                    name={`output-pat-${Math.random().toString(36).slice(2, 8)}`}
                    type={tokenShown ? "text" : "password"}
                    value={form.token}
                    onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
                    placeholder={form.editId ? "●●●●" : "ghp_…"}
                    autoComplete="new-password"
                    data-1p-ignore
                    data-lpignore="true"
                    spellCheck={false}
                    style={inputStyle}
                  />
                  <button
                    type="button"
                    onClick={() => setTokenShown((s) => !s)}
                    style={{
                      position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                      background: "none", border: "none", cursor: "pointer",
                      color: "var(--subtext0)", padding: 4,
                    }}
                  >
                    {tokenShown ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>

                <FieldLabel label="Branch override (optional)" hint="Leave blank to use the project's default (main)." />
                <input
                  value={form.branch}
                  onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
                  placeholder="main"
                  style={inputStyle}
                />
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={save}
                  disabled={busy}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "7px 14px", borderRadius: 7, border: "none",
                    background: "var(--blue)", color: "#fff",
                    fontSize: 12, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer",
                    fontFamily: "var(--font-sans)", opacity: busy ? 0.7 : 1,
                  }}
                >
                  {busy ? <Loader2 size={12} className="spin" /> : <Save size={12} />}
                  {form.editId ? "Update" : "Add"}
                </button>
                {/* Test button — only meaningful once the form has owner
                 *  and a token (edits can keep token empty to reuse the
                 *  saved one, but the server-side verify endpoint needs
                 *  the actual PAT when called with factoryId+owner+token,
                 *  so we disable it in edit-keeping-token mode). */}
                <button
                  type="button"
                  onClick={() => test()}
                  disabled={busy || verifying !== null || !form.owner.trim() || !form.token.trim()}
                  title={!form.token.trim() ? "Enter a token to test" : "Test these credentials against GitHub"}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "7px 14px", borderRadius: 7,
                    border: "1px solid var(--surface1)",
                    background: "transparent", color: "var(--subtext1)",
                    fontSize: 12, cursor: (busy || !form.owner.trim() || !form.token.trim()) ? "not-allowed" : "pointer",
                    fontFamily: "var(--font-sans)",
                    opacity: (!form.owner.trim() || !form.token.trim()) ? 0.5 : 1,
                  }}
                >
                  {verifying === "form" ? <Loader2 size={12} className="spin" /> : <Zap size={12} />}
                  Test
                </button>
                <button
                  type="button"
                  onClick={cancel}
                  disabled={busy}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "7px 14px", borderRadius: 7,
                    border: "1px solid var(--surface1)",
                    background: "transparent", color: "var(--subtext0)",
                    fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)",
                  }}
                >
                  <X size={12} /> Cancel
                </button>
              </div>
              {verifyResults.form && <VerifyFeedback result={verifyResults.form} />}
            </div>
          ) : canWrite && (
            <button
              type="button"
              onClick={startCreate}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                padding: "6px 12px", borderRadius: 6,
                border: "1px dashed var(--surface1)", background: "transparent",
                color: "var(--subtext0)", fontSize: 11, fontWeight: 600,
                cursor: "pointer", fontFamily: "var(--font-sans)",
                marginTop: items.length > 0 ? 4 : 0,
              }}
            >
              <Plus size={11} /> Add destination
            </button>
          )}

          {error && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--red)", display: "flex", alignItems: "center", gap: 5 }}>
              <AlertCircle size={12} /> {error}
            </div>
          )}
          {flash && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--green)", display: "flex", alignItems: "center", gap: 5 }}>
              <CheckCircle2 size={12} /> {flash}
            </div>
          )}
    </FactorySection>
  );
}

/* ── Styles / small pieces ──────────────────────────────── */

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "7px 10px", borderRadius: 6,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 12, outline: "none",
  fontFamily: "var(--font-sans)",
};

const iconBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 24, height: 24, borderRadius: 5,
  border: "none", background: "transparent",
  color: "var(--overlay1)", cursor: "pointer",
};

function VerifyFeedback({ result }: { result: VerifyResult }) {
  // Three outcome bands, all inline (no toast) so the user's eye
  // doesn't leave the destination row:
  //   green  — ok && canWriteRepo
  //   peach  — ok but write not confirmed (warning text in `error`)
  //   red    — token/owner invalid
  const color =
    !result.ok                   ? "var(--red)"   :
    result.canWriteRepo === true ? "var(--green)" :
                                   "var(--peach)";
  const Icon = result.ok && result.canWriteRepo ? CheckCircle2 : AlertCircle;
  const text =
    !result.ok ? (result.error ?? "Verification failed.")
    : result.canWriteRepo
      ? `OK — token belongs to "${result.tokenUser}"${result.ownerType ? `, owner is a ${result.ownerType}` : ""}.`
      : (result.error ?? "Token works but write access to this owner could not be confirmed.");
  return (
    <div style={{
      marginTop: 8, padding: "6px 10px",
      fontSize: 11, color, lineHeight: 1.5,
      display: "flex", alignItems: "flex-start", gap: 6,
      background: !result.ok ? "rgba(228,75,95,0.07)"
        : result.canWriteRepo ? "rgba(28,191,107,0.07)"
        : "rgba(245,159,0,0.07)",
      border: `1px solid ${!result.ok ? "rgba(228,75,95,0.2)"
        : result.canWriteRepo ? "rgba(28,191,107,0.25)"
        : "rgba(245,159,0,0.25)"}`,
      borderRadius: 6,
    }}>
      <Icon size={12} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{text}</span>
    </div>
  );
}

function FieldLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--subtext0)" }}>{label}</div>
      {hint && <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 1 }}>{hint}</div>}
    </div>
  );
}
