"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Plus, Check, AlertCircle, Trash2, Pencil,
  ToggleLeft, ToggleRight, Star, Factory as FactoryIcon,
  ChevronRight, ChevronDown, Puzzle, Store, Info,
  GitBranch, ShieldCheck, ShieldAlert, Copy, Link2Off, RefreshCw, Upload, CircleOff,
  BookText, Wand2,
} from "lucide-react";
import PageShell from "@/components/PageShell";
import { FactoryOutputDestinations } from "@/components/FactoryOutputDestinations";
import { FactorySection } from "@/components/FactorySection";
import { HarnessPresetsSection } from "@/components/HarnessPresetsSection";
import { useAuth } from "@/lib/auth-context";
import type { FactoryInfo } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { brand } from "@/lib/brand";
import { slugify } from "@/lib/slugify";

const ORIGIN_LABEL: Record<string, { label: string; color: string }> = {
  tirsa:     { label: brand.name,       color: "#1463ff" },
  community: { label: "Community",      color: "#10b981" },
  paid:      { label: "Paid",           color: "#f59e0b" },
  custom:    { label: "My Org",         color: "#a78bfa" },
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 14px", borderRadius: 8,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 13, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box" as const,
};

type ManagerTab = "factories" | "extensions";

interface FactoryRepo {
  owner: string;
  name: string;
  branch: string;
  verify_token: string | null;
  verified_at: string | null;
}

type RepoPurpose = "marketplace" | "storage";

// The "storage" purpose was retired in favour of per-factory Output
// Destinations (factory_output_destinations) — a single factory can
// now target multiple GitHub owners instead of one shared repo. Only
// "marketplace" remains as a traditional single-repo binding.
const REPO_PURPOSES: { id: RepoPurpose; label: string; description: string }[] = [
  { id: "marketplace", label: "Marketplace Repository", description: `Repo published to the ${brand.shortName} Marketplace so others can browse/import your agents.` },
];

function repoKey(factoryId: string, purpose: RepoPurpose) {
  return `${factoryId}:${purpose}`;
}

async function callRepoApi<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export default function FactoryManagerPage() {
  const router = useRouter();
  const { session, loading: authLoading, tenantId, factories, factoryId, setActiveFactory, refreshFactories, memberRole } = useAuth();

  const [tab, setTab] = useState<ManagerTab>("factories");
  const [showNewFactory, setShowNewFactory]       = useState(false);
  const [showNewExtension, setShowNewExtension]   = useState(false);
  const [newForm, setNewForm]       = useState({ name: "", slug: "", extendsId: "", inheritsId: "" });
  const [saving, setSaving]         = useState(false);
  const [formError, setFormError]   = useState<string | null>(null);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [editForm, setEditForm]     = useState({ name: "", slug: "", avatar: "", maxConcurrentProjects: 1 });
  const [message, setMessage]       = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [expandedFactory, setExpandedFactory] = useState<string | null>(null);
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);
  const [repoState, setRepoState] = useState<Record<string, FactoryRepo | null>>({});
  const [repoForm, setRepoForm] = useState<Record<string, { owner: string; repo: string; branch: string }>>({});
  const [repoBusy, setRepoBusy] = useState<string | null>(null);
  const [publishState, setPublishState] = useState<Record<string, { listingId: string | null; storeSlug: string | null; visibility: "public" | "private" | null }>>({});
  const [publishBusy, setPublishBusy] = useState<string | null>(null);
  const [visibilityBusy, setVisibilityBusy] = useState<string | null>(null);

  // Factory guidelines (Phase 4a). Per-factory expansion + draft state +
  // save-busy flag. Loaded lazily on expand to avoid pulling text bodies
  // for every factory at page mount.
  const [expandedGuidelines, setExpandedGuidelines] = useState<string | null>(null);
  const [expandedSkills, setExpandedSkills] = useState<string | null>(null);
  const [guidelinesDraft, setGuidelinesDraft]       = useState<Record<string, string>>({});
  const [guidelinesLoaded, setGuidelinesLoaded]     = useState<Record<string, boolean>>({});
  const [guidelinesBusy, setGuidelinesBusy]         = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);


  const myFactories = factories.filter((f) => (f.type ?? "factory") === "factory");
  const myExtensions = factories.filter((f) => f.type === "extension");

  const refreshAll = useCallback(async () => { await refreshFactories(); }, [refreshFactories]);
  useEffect(() => { if (tenantId) refreshAll(); }, [tenantId, refreshAll]);

  const isFirstTime = !authLoading && session && tenantId && factories.length === 0;

  function canDelete(f: FactoryInfo): boolean {
    // Marketplace-installed (has listing_id) tirsa/paid cannot be deleted, only disabled.
    // Everything else (custom, community, pre-migration) is deletable.
    if (f.listing_id && (f.origin === "tirsa" || f.origin === "paid")) return false;
    return true;
  }

  function getExtensionsFor(factoryId: string): FactoryInfo[] {
    return myExtensions.filter((e) => e.extends_factory_id === factoryId);
  }

  async function createFactory() {
    if (!newForm.name.trim() || !newForm.slug.trim()) { setFormError("Name and slug are required."); return; }
    if (!tenantId) return;
    setSaving(true); setFormError(null);

    const { data, error } = await supabase.from("factories")
      .insert({
        tenant_id: tenantId, name: newForm.name.trim(), slug: newForm.slug.trim(),
        category: newForm.slug.trim(),
        origin: "custom", type: "factory", enabled: true,
        config: { max_concurrent_projects: 3, default_provider: "anthropic", default_model: "claude-sonnet-4-6" },
      })
      .select("id").single();
    setSaving(false);
    if (error) { setFormError(error.message); return; }
    // Create inheritance if selected
    if (newForm.inheritsId && data) {
      await supabase.from("factory_inheritance").insert({ factory_id: data.id, inherits_id: newForm.inheritsId });
    }
    if (factories.length === 0 && data) setActiveFactory(data.id);
    await refreshFactories();
    setShowNewFactory(false);
    setNewForm({ name: "", slug: "", extendsId: "", inheritsId: "" });
    showMsg("success", "Factory created.");
  }

  async function createExtension() {
    if (!newForm.name.trim() || !newForm.slug.trim()) { setFormError("Name and slug are required."); return; }
    if (!newForm.extendsId) { setFormError("Select a factory to extend."); return; }
    if (!tenantId) return;
    setSaving(true); setFormError(null);
    const parent = factories.find((f) => f.id === newForm.extendsId);
    const { error } = await supabase.from("factories")
      .insert({
        tenant_id: tenantId, name: newForm.name.trim(), slug: newForm.slug.trim(),
        category: parent?.category ?? "custom", origin: "custom", type: "extension",
        extends_factory_id: newForm.extendsId, enabled: true, config: {},
      });
    setSaving(false);
    if (error) { setFormError(error.message); return; }
    await refreshFactories();
    setShowNewExtension(false);
    setNewForm({ name: "", slug: "", extendsId: "", inheritsId: "" });
    showMsg("success", "Extension created.");
  }

  async function toggleFactory(f: FactoryInfo) {
    await supabase.from("factories").update({ enabled: !f.enabled }).eq("id", f.id);
    await refreshFactories();
    showMsg("success", `"${f.name}" ${!f.enabled ? "enabled" : "disabled"}.`);
  }

  async function updateFactory(id: string) {
    if (!editForm.name.trim()) { setFormError("Name is required."); return; }
    const max = Math.round(editForm.maxConcurrentProjects);
    if (!Number.isFinite(max) || max < 1 || max > 10) {
      setFormError("Max concurrent projects must be between 1 and 10."); return;
    }
    setSaving(true); setFormError(null);

    // Merge into existing config so we don't drop other keys (default_provider, etc).
    const { data: existing } = await supabase.from("factories")
      .select("config").eq("id", id).single();
    const prevConfig = (existing?.config as Record<string, unknown> | null) ?? {};
    const nextConfig = { ...prevConfig, max_concurrent_projects: max };

    const { error } = await supabase.from("factories")
      .update({
        name:   editForm.name.trim(),
        slug:   editForm.slug.trim(),
        avatar: editForm.avatar.trim() || null,
        config: nextConfig,
      })
      .eq("id", id);
    setSaving(false);
    if (error) { setFormError(error.message); return; }
    await refreshFactories();
    setEditingId(null);
    showMsg("success", "Updated.");
  }

  async function openEdit(f: FactoryInfo) {
    const { data } = await supabase.from("factories")
      .select("config").eq("id", f.id).maybeSingle();
    const cfg = (data?.config as Record<string, unknown> | null) ?? {};
    const max = Number(cfg.max_concurrent_projects);
    setEditForm({
      name: f.name,
      slug: f.slug,
      avatar: f.avatar ?? "",
      maxConcurrentProjects: Number.isFinite(max) && max >= 1 ? max : 1,
    });
    setEditingId(f.id);
    setFormError(null);
  }

  async function deleteFactory(f: FactoryInfo) {
    if (!canDelete(f)) { showMsg("error", `"${f.name}" cannot be deleted — only disabled.`); return; }
    const { data: projects } = await supabase.from("projects").select("id").eq("factory_id", f.id).limit(1);
    if (projects && projects.length > 0) { showMsg("error", `Cannot delete "${f.name}" — it has projects.`); return; }
    if (!confirm(`Delete "${f.name}"? This cannot be undone.`)) return;
    const { error } = await supabase.from("factories").delete().eq("id", f.id);
    if (error) { showMsg("error", `Delete failed: ${error.message}`); return; }
    // If deleted factory was active, set to none
    if (f.id === factoryId && tenantId) {
      try { localStorage.setItem(`tirsa_active_factory_${tenantId}`, "__none__"); } catch { /* noop */ }
    }
    await refreshFactories();
    showMsg("success", "Deleted.");
  }

  function makeActive(f: FactoryInfo) {
    setActiveFactory(f.id);
    showMsg("success", `"${f.name}" is now active.`);
  }

  function showMsg(type: "success" | "error", text: string) {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3500);
  }

  /* ── Marketplace publish handlers ── */
  // The owner-facing query deliberately omits the `visibility = 'public'`
  // filter so the Factory Manager can show the publisher their own private
  // listings (they need to be able to flip them back to public). Public
  // browse paths in /api/marketplace/* apply that filter.
  async function loadPublishState(factoryId: string) {
    const { data } = await supabase
      .from("marketplace_listings")
      .select("id, store_id, visibility")
      .eq("metadata->>factory_id", factoryId)
      .eq("listing_type", "factory")
      .eq("status", "active")
      .not("factory_repo_id", "is", null)
      .maybeSingle();
    if (!data) {
      setPublishState((prev) => ({ ...prev, [factoryId]: { listingId: null, storeSlug: null, visibility: null } }));
      return;
    }
    let storeSlug: string | null = null;
    if (data.store_id) {
      const { data: store } = await supabase.from("marketplace_stores").select("slug").eq("id", data.store_id).maybeSingle();
      storeSlug = store?.slug ?? null;
    }
    const visibility = (data.visibility as "public" | "private" | null) ?? "public";
    setPublishState((prev) => ({ ...prev, [factoryId]: { listingId: data.id, storeSlug, visibility } }));
  }

  async function publishFactory(factoryId: string) {
    setPublishBusy(factoryId);
    try {
      const res = await callRepoApi<{ listingId: string; storeSlug: string }>("/api/marketplace/publish", { factoryId });
      // Newly created listings default to visibility='public' at the column
      // level; keep the local state in sync.
      setPublishState((prev) => ({ ...prev, [factoryId]: { listingId: res.listingId, storeSlug: res.storeSlug, visibility: "public" } }));
      showMsg("success", "Factory published to Marketplace.");
    } catch (e) {
      showMsg("error", (e as Error).message);
    } finally {
      setPublishBusy(null);
    }
  }

  async function unpublishFactory(factoryId: string) {
    if (!confirm("Remove this factory from the Marketplace? The listing is deleted; agents already imported by others remain in their factories. To temporarily hide instead, use the Public/Private toggle.")) return;
    setPublishBusy(factoryId);
    try {
      await callRepoApi("/api/marketplace/unpublish", { factoryId });
      setPublishState((prev) => ({ ...prev, [factoryId]: { listingId: null, storeSlug: null, visibility: null } }));
      showMsg("success", "Factory removed from Marketplace.");
    } catch (e) {
      showMsg("error", (e as Error).message);
    } finally {
      setPublishBusy(null);
    }
  }

  // Soft toggle: flips the listing's visibility column without touching the
  // listing row itself. Browse paths filter by visibility='public', so
  // private listings vanish from the Marketplace but stay editable here.
  async function setListingVisibility(factoryId: string, listingId: string, next: "public" | "private") {
    setVisibilityBusy(factoryId);
    try {
      const { data: { session: sess } } = await supabase.auth.getSession();
      if (!sess) throw new Error("Not signed in");
      const res = await fetch(`/api/marketplace/listings/${listingId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.access_token}` },
        body:    JSON.stringify({ visibility: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Visibility update failed (${res.status})`);
      }
      setPublishState((prev) => {
        const cur = prev[factoryId] ?? { listingId, storeSlug: null, visibility: null };
        return { ...prev, [factoryId]: { ...cur, visibility: next } };
      });
      showMsg("success", next === "public" ? "Listing is now public." : "Listing is now private (hidden from Marketplace).");
    } catch (e) {
      showMsg("error", (e as Error).message);
    } finally {
      setVisibilityBusy(null);
    }
  }

  /* ── Repository section handlers ── */
  async function loadRepoState(factoryId: string, purpose: RepoPurpose) {
    const k = repoKey(factoryId, purpose);
    const { data, error } = await supabase
      .from("factory_repos")
      .select("owner, name, branch, verify_token, verified_at")
      .eq("factory_id", factoryId)
      .eq("purpose", purpose)
      .maybeSingle();
    if (error) return;
    setRepoState((prev) => ({ ...prev, [k]: (data as FactoryRepo | null) ?? null }));
    if (!repoForm[k]) {
      setRepoForm((prev) => ({
        ...prev,
        [k]: {
          owner: data?.owner ?? "",
          repo: data?.name ?? "",
          branch: data?.branch ?? "main",
        },
      }));
    }
    if (purpose === "marketplace" && data?.verified_at) {
      void loadPublishState(factoryId);
    }
  }

  function openRepoSection(factoryId: string, purpose: RepoPurpose) {
    const k = repoKey(factoryId, purpose);
    const next = expandedRepo === k ? null : k;
    setExpandedRepo(next);
    if (next) void loadRepoState(factoryId, purpose);
  }

  async function configureRepo(factoryId: string, purpose: RepoPurpose) {
    const k = repoKey(factoryId, purpose);
    const form = repoForm[k];
    if (!form?.owner.trim() || !form?.repo.trim()) {
      showMsg("error", "Owner and repo are required.");
      return;
    }
    setRepoBusy(k);
    try {
      await callRepoApi("/api/factory/repo/configure", {
        factoryId,
        purpose,
        owner: form.owner.trim(),
        repo: form.repo.trim(),
        branch: form.branch.trim() || "main",
      });
      await loadRepoState(factoryId, purpose);
      showMsg("success", "Token generated. Commit the file to verify.");
    } catch (e) {
      showMsg("error", (e as Error).message);
    } finally {
      setRepoBusy(null);
    }
  }

  async function verifyRepo(factoryId: string, purpose: RepoPurpose) {
    const k = repoKey(factoryId, purpose);
    setRepoBusy(k);
    try {
      const res = await callRepoApi<{ verified: boolean; reason?: string }>("/api/factory/repo/verify", { factoryId, purpose });
      if (res.verified) {
        await loadRepoState(factoryId, purpose);
        showMsg("success", "Repository verified.");
      } else {
        showMsg("error", res.reason ?? "Verification failed.");
      }
    } catch (e) {
      showMsg("error", (e as Error).message);
    } finally {
      setRepoBusy(null);
    }
  }

  async function unlinkRepo(factoryId: string, purpose: RepoPurpose) {
    if (!confirm("Unlink the repository? You'll need to re-verify to reconnect.")) return;
    const k = repoKey(factoryId, purpose);
    setRepoBusy(k);
    try {
      await callRepoApi("/api/factory/repo/unlink", { factoryId, purpose });
      await loadRepoState(factoryId, purpose);
      setRepoForm((prev) => ({ ...prev, [k]: { owner: "", repo: "", branch: "main" } }));
      showMsg("success", "Repository unlinked.");
    } catch (e) {
      showMsg("error", (e as Error).message);
    } finally {
      setRepoBusy(null);
    }
  }

  /* ── Inline extension row (inside factory card) ── */
  function ExtensionRow({ ext }: { ext: FactoryInfo }) {
    const origin = ORIGIN_LABEL[ext.origin ?? "custom"] ?? ORIGIN_LABEL.custom;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--surface0)" }}>
        <Puzzle size={12} color="#a78bfa" style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1 }}>{ext.name}</span>
        {ext.origin !== "custom" && <span title={`Origin: ${origin.label}`} style={{ display: "inline-flex", alignItems: "center", cursor: "help", color: origin.color }}><Info size={12} /></span>}
        <button onClick={() => toggleFactory(ext)} style={{ background: "none", border: "none", cursor: "pointer", color: ext.enabled ? "var(--green)" : "var(--overlay0)", padding: 2, display: "flex" }}>
          {ext.enabled ? <ToggleRight size={15} /> : <ToggleLeft size={15} />}
        </button>
        {canDelete(ext) && (
          <button onClick={() => deleteFactory(ext)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)", padding: 2, display: "flex", opacity: 0.5 }}>
            <Trash2 size={12} />
          </button>
        )}
      </div>
    );
  }

  /* ── Factory card renderer (not a component — avoids remount on state change) ── */
  function renderFactoryCard(f: FactoryInfo) {
    const isActive = f.id === factoryId;
    const isEditing = editingId === f.id;
    const origin = ORIGIN_LABEL[f.origin ?? "custom"] ?? ORIGIN_LABEL.custom;
    const deletable = canDelete(f);
    const extensions = getExtensionsFor(f.id);
    const isExpanded = expandedFactory === f.id;

    return (
      <div style={{
        marginBottom: 8, borderRadius: 12, overflow: "hidden",
        border: `1.5px solid ${isActive ? "rgba(20,99,255,0.4)" : f.enabled ? "var(--surface1)" : "var(--surface0)"}`,
        background: isActive ? "rgba(20,99,255,0.04)" : f.enabled ? "var(--mantle)" : "var(--crust)",
        opacity: f.enabled ? 1 : 0.6,
      }}>
        <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 10 }}>
          {isEditing ? (
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                <input value={editForm.name} onChange={(e) => { const v = e.target.value; setEditForm((f) => ({ ...f, name: v, slug: slugify(v) })); }} placeholder="Name" style={{ ...inputStyle, flex: 1 }} />
                <input value={editForm.slug} onChange={(e) => { const v = e.target.value; setEditForm((f) => ({ ...f, slug: slugify(v) })); }} placeholder="slug" style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono)", fontSize: 11 }} />
              </div>
              <div style={{ marginBottom: 8 }}>
                <input value={editForm.avatar} onChange={(e) => setEditForm({ ...editForm, avatar: e.target.value })} placeholder="Avatar URL (optional)" style={{ ...inputStyle, fontSize: 11 }} />
              </div>
              <div style={{ marginBottom: 8 }}>
                <label style={{ display: "block", fontSize: 10, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4, fontFamily: "var(--font-sans)" }}>
                  Max concurrent projects
                  <span style={{ fontWeight: 400, marginLeft: 6, color: "var(--overlay0)" }}>
                    how many projects in this factory may run sprints in parallel
                  </span>
                </label>
                <input
                  type="number" min={1} max={10} step={1}
                  value={editForm.maxConcurrentProjects}
                  onChange={(e) => setEditForm({ ...editForm, maxConcurrentProjects: Number(e.target.value) || 1 })}
                  style={{ ...inputStyle, width: 120, fontSize: 12, fontFamily: "var(--font-mono)" }}
                />
              </div>
              {formError && editingId === f.id && <div style={{ color: "var(--red)", fontSize: 11, marginBottom: 6 }}>{formError}</div>}
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => updateFactory(f.id)} disabled={saving} style={{ padding: "4px 12px", borderRadius: 6, border: "none", background: "#1463ff", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Save</button>
                <button onClick={() => { setEditingId(null); setFormError(null); }} style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              {f.avatar && <img src={f.avatar} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: f.enabled ? "var(--text)" : "var(--overlay0)" }}>{f.name}</span>
                  {f.origin !== "custom" && <span title={`Origin: ${origin.label}`} style={{ display: "inline-flex", alignItems: "center", cursor: "help", color: origin.color }}><Info size={13} /></span>}
                </div>
                <div style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)", marginTop: 2 }}>{f.slug}</div>
                {f.inherits && f.inherits.length > 0 && (
                  <div style={{ fontSize: 10, color: "var(--subtext0)", marginTop: 3, display: "flex", alignItems: "center", gap: 4 }}>
                    inherits: {f.inherits.map((pid) => { const p = factories.find((ff) => ff.id === pid); return p?.name ?? pid.slice(0, 8); }).join(", ")}
                  </div>
                )}
              </div>
              {isActive && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--blue)", display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}><Star size={11} /> Active</span>}
              {!isActive && f.enabled && <button onClick={() => makeActive(f)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", flexShrink: 0 }}>Set active</button>}
              <button onClick={() => toggleFactory(f)} title={f.enabled ? "Disable" : "Enable"} style={{ background: "none", border: "none", cursor: "pointer", color: f.enabled ? "var(--green)" : "var(--overlay0)", padding: 4, display: "flex", flexShrink: 0 }}>
                {f.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
              </button>
              <button onClick={() => { void openEdit(f); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4, display: "flex", flexShrink: 0 }}><Pencil size={13} /></button>
              {deletable ? (
                <button onClick={() => deleteFactory(f)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)", padding: 4, display: "flex", opacity: 0.6, flexShrink: 0 }}><Trash2 size={13} /></button>
              ) : <div style={{ width: 21, flexShrink: 0 }} />}
            </>
          )}
        </div>

        {/* Extensions — custom squads/agents attached to this factory. */}
        {!isEditing && (
          <FactorySection
            title="Extensions"
            icon={<Puzzle size={14} />}
            subtitle={
              extensions.length === 0
                ? "no extensions attached"
                : `${extensions.length} attached · ${extensions.filter((e) => e.enabled).length} active`
            }
            open={isExpanded}
            onToggle={() => setExpandedFactory(isExpanded ? null : f.id)}
          >
            {extensions.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--overlay0)" }}>No extensions attached.</div>
            ) : (
              extensions.map((ext) => <ExtensionRow key={ext.id} ext={ext} />)
            )}
            <button
              onClick={() => { setShowNewExtension(true); setNewForm({ ...newForm, extendsId: f.id }); setFormError(null); setTab("factories"); }}
              style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 6, border: "1px dashed var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}
            >
              <Plus size={10} /> Add extension
            </button>
          </FactorySection>
        )}

        {/* Factory-level guidelines (Phase 4a). Above repo sections so
         *  it's visible without scrolling past output destinations. */}
        {!isEditing && renderGuidelinesSection(f)}

        {/* Factory-default skills (Phase 5 Slice A). Apply to every project
         *  in this factory unless overridden at the project level. */}
        {!isEditing && (
          <FactorySection
            title="Skills"
            icon={<Star size={14} />}
            subtitle="moved to Studio → Skills"
            open={expandedSkills === f.id}
            onToggle={() => setExpandedSkills(expandedSkills === f.id ? null : f.id)}
          >
            <div style={{
              padding: "12px 14px", borderRadius: 8,
              background: "var(--surface0)", border: "1px solid var(--surface1)",
              fontSize: 12, color: "var(--subtext0)", lineHeight: 1.6,
            }}>
              Skill management moved to <a href="/studio" style={{ color: "var(--blue)", fontWeight: 600, textDecoration: "none" }}>Studio → Skills</a>.
              The editor, GitHub import, and adoption of canonical skills (via Marketplace) all live there now,
              keeping Factory Settings focused on factory-level configuration.
            </div>
          </FactorySection>
        )}

        {/* Collapsible repository sections — one per purpose */}
        {!isEditing && REPO_PURPOSES.map((p) => (
          <React.Fragment key={p.id}>
            {renderRepoSection(f, p.id, p.label, p.description)}
          </React.Fragment>
        ))}

        {/* Output destinations: replaces the previous Storage Repository
         *  concept. A factory can register multiple (name, owner, PAT)
         *  destinations; projects inside pick which to push to. */}
        {!isEditing && (
          <FactoryOutputDestinations
            factoryId={f.id}
            canWrite={memberRole === "platform_admin" || memberRole === "admin"}
          />
        )}

        {/* BL-26 Phase 4 — Harness presets. Reusable agent harness bundles
         *  (cli, model, max_turns, effort, append_system_prompt, …). Per-
         *  agent overrides reference a preset by id; the worker merges
         *  preset.config under the override at dispatch. */}
        {!isEditing && (
          <HarnessPresetsSection
            factoryId={f.id}
            canWrite={memberRole === "platform_admin" || memberRole === "admin"}
          />
        )}
      </div>
    );
  }

  /* ── Marketplace publish control (shown when marketplace repo is verified) ── */
  function renderPublishControl(f: FactoryInfo) {
    const pub = publishState[f.id];
    const published = !!pub?.listingId;
    const visibility = pub?.visibility ?? null;
    const isPrivate  = published && visibility === "private";
    const busy       = publishBusy    === f.id;
    const visBusy    = visibilityBusy === f.id;

    return (
      <div style={{
        marginTop: 10, padding: "10px 12px", borderRadius: 8,
        background: published ? "rgba(124,92,252,0.06)" : "var(--surface0)",
        border: `1px solid ${published ? "rgba(124,92,252,0.25)" : "var(--surface1)"}`,
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}>
        <Store size={14} color={published ? "var(--mauve)" : "var(--overlay1)"} />
        <div style={{ flex: 1, fontSize: 11, minWidth: 220 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text)", fontWeight: 600 }}>
            {published ? "Published to Marketplace" : "Not published"}
            {published && (
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99,
                textTransform: "uppercase", letterSpacing: "0.04em",
                background: isPrivate ? "rgba(245,159,0,0.12)" : "rgba(28,191,107,0.12)",
                color:      isPrivate ? "var(--peach)"          : "var(--green)",
              }}>
                {isPrivate ? "Private" : "Public"}
              </span>
            )}
          </div>
          <div style={{ color: "var(--overlay0)", marginTop: 2 }}>
            {published
              ? (isPrivate
                  ? <>Hidden from the Marketplace. Toggle Public to make it browseable again.</>
                  : <>Visible at <code style={{ fontFamily: "var(--font-mono)" }}>/marketplace/stores/{pub.storeSlug}</code></>)
              : "Click Publish to list this factory in the community Marketplace."}
          </div>
        </div>
        {/* Public/Private toggle — only when there is a listing to flip. */}
        {published && (
          <button
            onClick={() => setListingVisibility(f.id, pub.listingId!, isPrivate ? "public" : "private")}
            disabled={visBusy}
            title={isPrivate ? "Make this listing browseable in the public Marketplace." : "Hide this listing from the public Marketplace. The listing row stays — flip back any time."}
            style={{
              padding: "5px 10px", borderRadius: 6, border: "1px solid var(--surface1)",
              background: "var(--surface0)", color: "var(--text)",
              fontSize: 10, fontWeight: 700,
              cursor: visBusy ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", gap: 4,
              fontFamily: "var(--font-sans)",
              opacity: visBusy ? 0.6 : 1,
            }}
          >
            {isPrivate ? "Make Public" : "Make Private"}
          </button>
        )}
        {published ? (
          <button onClick={() => unpublishFactory(f.id)} disabled={busy} style={{
            padding: "5px 10px", borderRadius: 6, border: "1px solid var(--surface1)",
            background: "transparent", color: "var(--red)", fontSize: 10, fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 4,
            fontFamily: "var(--font-sans)",
          }}>
            <CircleOff size={10} /> Remove from Marketplace
          </button>
        ) : (
          <button onClick={() => publishFactory(f.id)} disabled={busy} style={{
            padding: "5px 12px", borderRadius: 6, border: "none",
            background: busy ? "var(--surface1)" : "var(--mauve)", color: "#fff",
            fontSize: 11, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--font-sans)",
          }}>
            <Upload size={10} /> {busy ? "Publishing…" : "Publish"}
          </button>
        )}
      </div>
    );
  }

  /* ── Repository section renderer (per purpose) ── */
  /* ── Guidelines section (Phase 4a) ────────────────────────────────── */
  async function toggleGuidelines(f: FactoryInfo) {
    const opening = expandedGuidelines !== f.id;
    setExpandedGuidelines(opening ? f.id : null);
    if (opening && !guidelinesLoaded[f.id]) {
      // Lazy fetch — only when the operator expands. The auth-context's
      // FactoryInfo doesn't carry guidelines (it's a list view), so we
      // pull the column on demand.
      const { data } = await supabase
        .from("factories")
        .select("guidelines")
        .eq("id", f.id)
        .maybeSingle();
      const text = (data?.guidelines as string | null) ?? "";
      setGuidelinesDraft((prev) => ({ ...prev, [f.id]: text }));
      setGuidelinesLoaded((prev) => ({ ...prev, [f.id]: true }));
    }
  }

  async function saveGuidelines(f: FactoryInfo) {
    const text = (guidelinesDraft[f.id] ?? "").trim();
    setGuidelinesBusy(f.id);
    try {
      const { error } = await supabase
        .from("factories")
        .update({ guidelines: text.length > 0 ? text : null })
        .eq("id", f.id);
      if (error) throw new Error(error.message);
      setMessage({ type: "success", text: `Guidelines saved for "${f.name}".` });
    } catch (e) {
      setMessage({ type: "error", text: (e as Error).message });
    } finally {
      setGuidelinesBusy(null);
    }
  }

  function renderGuidelinesSection(f: FactoryInfo) {
    const open = expandedGuidelines === f.id;
    const draft = guidelinesDraft[f.id] ?? "";
    const loaded = guidelinesLoaded[f.id];
    const busy = guidelinesBusy === f.id;
    const canWrite = memberRole === "platform_admin" || memberRole === "admin";

    const legacyBadge = (
      <span style={{
        fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
        background: "rgba(254,166,73,0.12)", color: "var(--peach)",
        textTransform: "uppercase", letterSpacing: "0.04em",
      }}>legacy</span>
    );

    return (
      <FactorySection
        title="Factory Guidelines"
        icon={<BookText size={14} />}
        badge={legacyBadge}
        subtitle="always-on text injected into every agent — prefer Skills (category=guideline) below"
        open={open}
        onToggle={() => void toggleGuidelines(f)}
      >
        {!loaded ? (
          <div style={{ fontSize: 11, color: "var(--overlay0)" }}>Loading…</div>
        ) : (
          <>
            <textarea
              value={draft}
              onChange={(e) => setGuidelinesDraft((prev) => ({ ...prev, [f.id]: e.target.value }))}
              placeholder="Markdown guidelines for the factory. Examples: Conventional Commits style, branch naming, default test framework, language conventions, security rules, deployment policy. Empty = no factory-level rules."
              rows={10}
              disabled={!canWrite}
              style={{
                width: "100%", padding: 10, fontSize: 12, fontFamily: "var(--font-mono, monospace)",
                background: "var(--base)", color: "var(--text)",
                border: "1px solid var(--surface1)", borderRadius: 6,
                resize: "vertical", boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
              <button
                disabled={!canWrite || busy}
                onClick={() => void saveGuidelines(f)}
                style={{
                  padding: "6px 14px", borderRadius: 6, border: "none",
                  background: "var(--blue)", color: "#fff",
                  fontSize: 11, fontWeight: 600,
                  cursor: canWrite && !busy ? "pointer" : "not-allowed",
                  opacity: canWrite && !busy ? 1 : 0.6,
                }}
              >
                {busy ? "Saving…" : "Save guidelines"}
              </button>
            </div>
            {!canWrite && (
              <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 6 }}>
                Read-only — only factory owners/admins can edit guidelines.
              </div>
            )}
          </>
        )}
      </FactorySection>
    );
  }

  function renderRepoSection(f: FactoryInfo, purpose: RepoPurpose, label: string, description: string) {
    const k = repoKey(f.id, purpose);
    const isExpanded = expandedRepo === k;
    const state = repoState[k];
    const form = repoForm[k] ?? { owner: "", repo: "", branch: "main" };
    const verified = !!state?.verified_at;
    const pending = !verified && !!state?.verify_token && !!state?.owner;
    const busy = repoBusy === k;

    let statusLabel: string;
    let statusColor: string;
    if (verified) { statusLabel = "verified"; statusColor = "var(--green)"; }
    else if (pending) { statusLabel = "pending verification"; statusColor = "var(--yellow)"; }
    else if (state?.owner) { statusLabel = "configured, not verified"; statusColor = "var(--overlay1)"; }
    else { statusLabel = "not connected"; statusColor = "var(--overlay0)"; }

    const filePath = `factories/${f.slug}/.twinpilot-verify`;

    const statusBadge = (
      <span style={{
        fontSize: 10, color: statusColor, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: "0.04em",
      }}>
        {statusLabel}
      </span>
    );

    return (
      <FactorySection
        title={label}
        icon={<GitBranch size={14} />}
        subtitle={description}
        right={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {statusBadge}
            {verified && <ShieldCheck size={13} color="var(--green)" />}
          </span>
        }
        open={isExpanded}
        onToggle={() => openRepoSection(f.id, purpose)}
      >
        <div>
          <div style={{ fontSize: 10, color: "var(--overlay0)", marginBottom: 10, lineHeight: 1.5 }}>
            {description}
          </div>
            {verified && state ? (
              <>
                <div style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 12px", borderRadius: 8,
                  background: "rgba(28,191,107,0.06)", border: "1px solid rgba(28,191,107,0.25)",
                }}>
                  <ShieldCheck size={14} color="var(--green)" />
                  <div style={{ flex: 1, fontSize: 11 }}>
                    <div style={{ color: "var(--text)", fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                      {state.owner}/{state.name}#{state.branch}
                    </div>
                    <div style={{ color: "var(--overlay0)", marginTop: 2 }}>
                      Verified {new Date(state.verified_at!).toLocaleDateString()} · repo path: <code style={{ fontFamily: "var(--font-mono)" }}>factories/{f.slug}/</code>
                    </div>
                  </div>
                  <button onClick={() => unlinkRepo(f.id, purpose)} disabled={busy} style={{
                    padding: "5px 10px", borderRadius: 6, border: "1px solid var(--surface1)",
                    background: "transparent", color: "var(--red)", fontSize: 10, fontWeight: 700,
                    cursor: busy ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 4,
                    fontFamily: "var(--font-sans)",
                  }}>
                    <Link2Off size={10} /> Unlink
                  </button>
                </div>
                {purpose === "marketplace" && renderPublishControl(f)}
              </>
            ) : (
              <>
                {/* Config form */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px", gap: 6, marginBottom: 8 }}>
                  <input
                    placeholder="owner"
                    value={form.owner}
                    onChange={(e) => setRepoForm((p) => ({ ...p, [k]: { ...form, owner: e.target.value } }))}
                    style={{ ...inputStyle, fontSize: 11, fontFamily: "var(--font-mono)" }}
                  />
                  <input
                    placeholder="repo"
                    value={form.repo}
                    onChange={(e) => setRepoForm((p) => ({ ...p, [k]: { ...form, repo: e.target.value } }))}
                    style={{ ...inputStyle, fontSize: 11, fontFamily: "var(--font-mono)" }}
                  />
                  <input
                    placeholder="main"
                    value={form.branch}
                    onChange={(e) => setRepoForm((p) => ({ ...p, [k]: { ...form, branch: e.target.value } }))}
                    style={{ ...inputStyle, fontSize: 11, fontFamily: "var(--font-mono)" }}
                  />
                </div>

                <div style={{ display: "flex", gap: 6, marginBottom: pending ? 10 : 0 }}>
                  <button onClick={() => configureRepo(f.id, purpose)} disabled={busy} style={{
                    padding: "5px 12px", borderRadius: 6, border: "none",
                    background: busy ? "var(--surface1)" : "#1463ff", color: "#fff",
                    fontSize: 11, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer",
                    fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", gap: 4,
                  }}>
                    <RefreshCw size={10} /> {pending ? "Rotate token" : "Generate token"}
                  </button>
                  {pending && (
                    <button onClick={() => unlinkRepo(f.id, purpose)} disabled={busy} style={{
                      padding: "5px 10px", borderRadius: 6, border: "1px solid var(--surface1)",
                      background: "transparent", color: "var(--subtext0)", fontSize: 11,
                      cursor: busy ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)",
                    }}>
                      Cancel
                    </button>
                  )}
                </div>

                {pending && state && (
                  <div style={{
                    padding: "10px 12px", borderRadius: 8,
                    background: "rgba(245,159,0,0.06)", border: "1px solid rgba(245,159,0,0.25)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 11, fontWeight: 700, color: "var(--yellow)" }}>
                      <ShieldAlert size={12} /> Commit this file to prove ownership
                    </div>
                    <div style={{ fontSize: 10, color: "var(--subtext0)", marginBottom: 6 }}>
                      Path in repo:
                    </div>
                    <div style={{
                      fontFamily: "var(--font-mono)", fontSize: 11,
                      padding: "6px 10px", borderRadius: 6,
                      background: "var(--crust)", border: "1px solid var(--surface0)",
                      marginBottom: 8, display: "flex", alignItems: "center", gap: 6,
                    }}>
                      <code style={{ flex: 1, color: "var(--text)" }}>{filePath}</code>
                      <button
                        onClick={() => { navigator.clipboard.writeText(filePath); showMsg("success", "Path copied."); }}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "flex" }}
                      >
                        <Copy size={11} />
                      </button>
                    </div>
                    <div style={{ fontSize: 10, color: "var(--subtext0)", marginBottom: 6 }}>
                      File content (exactly, no trailing whitespace):
                    </div>
                    <div style={{
                      fontFamily: "var(--font-mono)", fontSize: 11,
                      padding: "6px 10px", borderRadius: 6,
                      background: "var(--crust)", border: "1px solid var(--surface0)",
                      marginBottom: 10, display: "flex", alignItems: "center", gap: 6,
                      wordBreak: "break-all",
                    }}>
                      <code style={{ flex: 1, color: "var(--text)" }}>{state.verify_token}</code>
                      <button
                        onClick={() => { navigator.clipboard.writeText(state.verify_token!); showMsg("success", "Token copied."); }}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "flex", flexShrink: 0 }}
                      >
                        <Copy size={11} />
                      </button>
                    </div>
                    <button onClick={() => verifyRepo(f.id, purpose)} disabled={busy} style={{
                      padding: "6px 14px", borderRadius: 6, border: "none",
                      background: busy ? "var(--surface1)" : "var(--green)", color: "#fff",
                      fontSize: 11, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer",
                      fontFamily: "var(--font-sans)", display: "flex", alignItems: "center", gap: 5,
                    }}>
                      <ShieldCheck size={11} /> {busy ? "Verifying…" : "Verify"}
                    </button>
                  </div>
                )}
              </>
            )}
        </div>
      </FactorySection>
    );
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: "8px 20px", borderRadius: 8, border: "none",
    background: active ? "var(--surface0)" : "transparent",
    color: active ? "var(--text)" : "var(--overlay0)",
    fontSize: 13, fontWeight: active ? 700 : 500, cursor: "pointer",
    fontFamily: "var(--font-sans)",
  });

  return (
    <PageShell active="factory-settings" maxWidth={720}>
          {/* Custom header: icon tile + title, matches the other
           *  "primary section" pages like /profile. Keeps its own
           *  layout rather than using PageShell's title block so the
           *  gradient tile can sit flush with the text. */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, flexShrink: 0, background: "linear-gradient(135deg, #1463ff, #0f4ed0)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <FactoryIcon size={24} color="#fff" strokeWidth={1.5} />
            </div>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: "var(--font-heading)", marginBottom: 2 }}>Factory Manager</h1>
              <p style={{ fontSize: 13, color: "var(--subtext0)", margin: 0 }}>Manage factories and extensions. Edit components in Studio.</p>
            </div>
          </div>

          {/* No factory selected — neon alert */}
          {!factoryId && !isFirstTime && (
            <div style={{
              margin: "20px 0", padding: "14px 18px", borderRadius: 10,
              background: "rgba(245,159,0,0.05)",
              border: "1px solid rgba(245,159,0,0.25)",
              boxShadow: "0 0 16px rgba(245,159,0,0.08), inset 0 0 10px rgba(245,159,0,0.03)",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                background: "#f59f00",
                boxShadow: "0 0 6px 2px rgba(245,159,0,0.5), 0 0 14px 4px rgba(245,159,0,0.2)",
              }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#f5c542" }}>
                No factory selected. Enable or install a factory to access Studio and Office.
              </span>
            </div>
          )}

          {/* First-time banner */}
          {isFirstTime && (
            <div style={{
              margin: "20px 0", padding: "18px 20px", borderRadius: 10,
              background: "rgba(20,99,255,0.04)",
              border: "1px solid rgba(20,99,255,0.2)",
              boxShadow: "0 0 16px rgba(20,99,255,0.08), inset 0 0 10px rgba(20,99,255,0.03)",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
                background: "#1463ff",
                boxShadow: "0 0 6px 2px rgba(20,99,255,0.5), 0 0 14px 4px rgba(20,99,255,0.2)",
              }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "#5b9aff" }}>
                Welcome! Install a factory from the <a href="/marketplace" style={{ color: "#7db5ff", textDecoration: "underline" }}>Marketplace</a> or create a custom one below.
              </span>
            </div>
          )}

          {/* Message */}
          {message && (
            <div style={{ margin: "16px 0", padding: "10px 16px", borderRadius: 10, fontSize: 13, display: "flex", alignItems: "center", gap: 8, background: message.type === "success" ? "rgba(28,191,107,0.08)" : "rgba(228,75,95,0.08)", border: `1px solid ${message.type === "success" ? "rgba(28,191,107,0.3)" : "rgba(228,75,95,0.3)"}`, color: message.type === "success" ? "var(--green)" : "var(--red)" }}>
              {message.type === "success" ? <Check size={14} /> : <AlertCircle size={14} />} {message.text}
            </div>
          )}

          {/* Quick links */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 20, marginBottom: 20 }}>
            <a href="/marketplace" style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 16px", borderRadius: 8, background: "linear-gradient(135deg, #1463ff 0%, #0f4ed0 100%)", color: "#fff", fontSize: 12, fontWeight: 700, textDecoration: "none", fontFamily: "var(--font-sans)" }}>
              <Store size={13} /> Go to Marketplace
            </a>
            {factoryId && (
              <a href="/studio" style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 16px", borderRadius: 8, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext1)", fontSize: 12, fontWeight: 700, textDecoration: "none", fontFamily: "var(--font-sans)" }}>
                Go to Studio
              </a>
            )}
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid var(--surface0)", marginBottom: 20 }}>
            {([
              { id: "factories" as ManagerTab, label: `My Factories (${myFactories.length})` },
              { id: "extensions" as ManagerTab, label: `Extensions Catalog (${myExtensions.length})` },
            ]).map((t) => {
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} style={{
                  padding: "10px 20px", border: "none",
                  background: "transparent",
                  color: active ? "var(--text)" : "var(--overlay0)",
                  fontSize: 13, fontWeight: active ? 700 : 500,
                  cursor: "pointer", fontFamily: "var(--font-sans)",
                  borderBottom: active ? "2px solid var(--blue)" : "2px solid transparent",
                  marginBottom: -1,
                }}>
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* ── My Factories tab ── */}
          {tab === "factories" && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", marginBottom: 12 }}>
                <button onClick={() => { setShowNewFactory(true); setShowNewExtension(false); setFormError(null); }} style={{
                  display: "flex", alignItems: "center", gap: 5, padding: "5px 14px", borderRadius: 7, border: "none",
                  background: "linear-gradient(135deg, #1463ff 0%, #0f4ed0 100%)", color: "#fff",
                  fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)",
                }}>
                  <Plus size={12} /> New Factory
                </button>
              </div>

              {showNewFactory && (
                <div style={{ marginBottom: 12, padding: "16px", borderRadius: 10, background: "var(--mantle)", border: "1px solid var(--surface0)" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>New Custom Factory</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <input value={newForm.name} onChange={(e) => { const v = e.target.value; setNewForm((f) => ({ ...f, name: v, slug: slugify(v) })); }} placeholder="Name" style={inputStyle} />
                    <input value={newForm.slug} onChange={(e) => { const v = e.target.value; setNewForm((f) => ({ ...f, slug: slugify(v) })); }} placeholder="slug" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4 }}>Inherits from <span style={{ fontWeight: 400, color: "var(--overlay0)" }}>(optional)</span></label>
                    <select value={newForm.inheritsId} onChange={(e) => setNewForm({ ...newForm, inheritsId: e.target.value })} style={{ ...inputStyle, cursor: "pointer" }}>
                      <option value="">None — blank factory</option>
                      {myFactories.filter((f) => f.id !== factoryId).map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </div>
                  {formError && <div style={{ color: "var(--red)", fontSize: 11, marginBottom: 8 }}>{formError}</div>}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={createFactory} disabled={saving} style={{ padding: "6px 16px", borderRadius: 7, border: "none", background: "#1463ff", color: "#fff", fontSize: 11, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)" }}>{saving ? "Creating…" : "Create"}</button>
                    <button onClick={() => setShowNewFactory(false)} style={{ padding: "6px 16px", borderRadius: 7, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Cancel</button>
                  </div>
                </div>
              )}

              {/* New extension form (triggered from inside a factory card) */}
              {showNewExtension && tab === "factories" && (
                <div style={{ marginBottom: 12, padding: "16px", borderRadius: 10, background: "var(--mantle)", border: "1px solid rgba(167,139,250,0.2)" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                    <Puzzle size={14} color="#a78bfa" /> New Extension for {factories.find((f) => f.id === newForm.extendsId)?.name ?? "…"}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <input value={newForm.name} onChange={(e) => { const v = e.target.value; setNewForm((f) => ({ ...f, name: v, slug: slugify(v) })); }} placeholder="Extension name" style={inputStyle} />
                    <input value={newForm.slug} onChange={(e) => setNewForm({ ...newForm, slug: slugify(e.target.value) })} placeholder="slug" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
                  </div>
                  <p style={{ fontSize: 11, color: "var(--subtext0)", marginBottom: 10, lineHeight: 1.5 }}>
                    Extensions add custom squads and agents. Edit them in Studio.
                  </p>
                  {formError && <div style={{ color: "var(--red)", fontSize: 11, marginBottom: 8 }}>{formError}</div>}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={createExtension} disabled={saving} style={{ padding: "6px 16px", borderRadius: 7, border: "none", background: "#6d28d9", color: "#fff", fontSize: 11, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)" }}>{saving ? "Creating…" : "Create"}</button>
                    <button onClick={() => setShowNewExtension(false)} style={{ padding: "6px 16px", borderRadius: 7, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Cancel</button>
                  </div>
                </div>
              )}

              {myFactories.length === 0 && !showNewFactory && (
                <div style={{ textAlign: "center", padding: "36px 16px", color: "var(--overlay0)", fontSize: 13 }}>
                  No factories yet. Install one from the <a href="/marketplace" style={{ color: "var(--blue)", textDecoration: "none" }}>Marketplace</a> or create a custom factory.
                </div>
              )}

              {myFactories.map((f) => <React.Fragment key={f.id}>{renderFactoryCard(f)}</React.Fragment>)}
            </div>
          )}

          {/* ── Extensions Catalog tab ── */}
          {tab === "extensions" && (
            <div>
              <p style={{ fontSize: 13, color: "var(--subtext0)", marginBottom: 16 }}>
                All extensions across your factories. Each extension adds custom squads and agents to its parent factory.
              </p>

              {myExtensions.length === 0 ? (
                <div style={{ textAlign: "center", padding: "36px 16px", color: "var(--overlay0)" }}>
                  <Puzzle size={28} style={{ marginBottom: 8, opacity: 0.4 }} />
                  <div style={{ fontSize: 13 }}>No extensions yet. Add one from a factory&apos;s Extensions section.</div>
                </div>
              ) : (
                myExtensions.map((ext) => {
                  const parent = myFactories.find((f) => f.id === ext.extends_factory_id);
                  const origin = ORIGIN_LABEL[ext.origin ?? "custom"] ?? ORIGIN_LABEL.custom;
                  return (
                    <div key={ext.id} style={{
                      marginBottom: 6, borderRadius: 10, padding: "12px 16px",
                      border: `1.5px solid ${ext.enabled ? "rgba(167,139,250,0.2)" : "var(--surface0)"}`,
                      background: ext.enabled ? "rgba(167,139,250,0.03)" : "var(--crust)",
                      opacity: ext.enabled ? 1 : 0.6,
                      display: "flex", alignItems: "center", gap: 10,
                    }}>
                      <Puzzle size={16} color="#a78bfa" style={{ flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{ext.name}</span>
                          {ext.origin !== "custom" && <span title={`Origin: ${origin.label}`} style={{ display: "inline-flex", alignItems: "center", cursor: "help", color: origin.color }}><Info size={12} /></span>}
                        </div>
                        <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2 }}>
                          <span style={{ fontFamily: "var(--font-mono)" }}>{ext.slug}</span>
                          {parent && <> · extends <strong style={{ color: "var(--subtext0)" }}>{parent.name}</strong></>}
                        </div>
                      </div>
                      <button onClick={() => toggleFactory(ext)} style={{ background: "none", border: "none", cursor: "pointer", color: ext.enabled ? "var(--green)" : "var(--overlay0)", padding: 4, display: "flex", flexShrink: 0 }}>
                        {ext.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                      </button>
                      {canDelete(ext) && (
                        <button onClick={() => deleteFactory(ext)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)", padding: 4, display: "flex", opacity: 0.6, flexShrink: 0 }}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
    </PageShell>
  );
}
