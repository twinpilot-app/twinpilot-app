"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import AppSidebar from "@/components/AppSidebar";
import { Store, ChevronRight, GitBranch, Download, AlertCircle, Users, CircleOff, Workflow, ArrowRight, BookOpen } from "lucide-react";

interface ListingDetail {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
  category_slug: string;
  store: { id: string; slug: string; name: string; avatar: string | null; verified: boolean } | null;
  /** null when the listing is DB-backed (Built-In), populated when it is repo-backed. */
  repo: { owner: string; name: string; branch: string; factory_slug: string } | null;
}

interface AgentCard {
  slug: string;
  name: string;
  icon: string | null;
  squad: string | null;
  level: string | null;
  version: string | null;
  persona_preview: string;
  tools: string[];
  tags: string[];
  installed: boolean;
}

interface PipelineStep {
  step:       number | undefined;
  agent_slug: string;
  agent_name: string;
  agent_icon: string | null;
}

interface PipelineCard {
  id:          string;
  name:        string;
  description: string | null;
  intent:      string;
  squad:       string | null;
  steps:       PipelineStep[];
  installed:   boolean;
}

interface SkillCard {
  slug:                     string;
  name:                     string;
  description:              string;
  category:                 string | null;
  allowed_tools:            string[];
  disable_model_invocation: boolean;
  body_preview:             string;
  installed:                boolean;
}

async function fetchWithAuth(url: string, opts?: RequestInit) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      ...(opts?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; pipelines?: string[] } & Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 409 && Array.isArray(body.pipelines) && body.pipelines.length > 0) {
      throw new Error(`Agent is used in pipeline(s): ${body.pipelines.join(", ")}. Remove it from these pipelines before uninstalling.`);
    }
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return body;
}

export default function MarketplaceListingDetailPage() {
  const params = useParams<{ id: string }>();
  const listingId = params.id;
  const { factoryId, factorySlug } = useAuth();

  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [pipelines, setPipelines] = useState<PipelineCard[]>([]);
  const [skills, setSkills] = useState<SkillCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});
  const [installingPipelineId, setInstallingPipelineId] = useState<string | null>(null);
  const [installingSkillSlug, setInstallingSkillSlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = (await fetchWithAuth(`/api/marketplace/listings/${listingId}`)) as {
        listing: ListingDetail;
        agents: AgentCard[];
        pipelines?: PipelineCard[];
        skills?: SkillCard[];
        warning?: string;
      };
      setListing(body.listing);
      setAgents(body.agents);
      setPipelines(body.pipelines ?? []);
      setSkills(body.skills ?? []);
      setWarning(body.warning ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [listingId]);

  /** Pipeline conflict modal state — when the install endpoint returns
   *  409 with a `conflict` block, we surface the keep / replace / cancel
   *  modal instead of throwing the raw error. */
  const [pipelineConflict, setPipelineConflict] = useState<{
    pl:   PipelineCard;
    info: { kind: "pipeline"; slug: string; existing_id: string; existing_name: string; scope: string };
  } | null>(null);

  async function installPipeline(pl: PipelineCard, opts: { mode: "install" | "clone"; onConflict?: "replace" | "cancel" }) {
    setInstallingPipelineId(pl.id);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch("/api/marketplace/install", {
        method:  "POST",
        headers: {
          Authorization:  `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ listingId: pl.id, mode: opts.mode, ...(opts.onConflict ? { onConflict: opts.onConflict } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        pipelineName?:     string;
        agentsInstalled?:  string[];
        agentsUnresolved?: string[];
        message?:          string;
        error?:            string;
        skipped?:          boolean;
        alreadyInstalled?: boolean;
        mode?:             "install" | "clone";
        conflict?:         { kind: "pipeline"; slug: string; existing_id: string; existing_name: string; scope: string };
      };
      if (res.status === 409 && body.conflict) {
        setPipelineConflict({ pl, info: body.conflict });
        return;
      }
      if (!res.ok) {
        setError(body.error ?? `Install failed (${res.status})`);
        return;
      }
      if (body.skipped) {
        setWarning(body.message ?? "Install cancelled — kept existing pipeline.");
        return;
      }
      setPipelines((cur) => cur.map((p) => p.id === pl.id ? { ...p, installed: true } : p));
      if (opts.mode === "install") {
        setWarning(body.message ?? `"${body.pipelineName ?? pl.name}" installed (reference).`);
      } else {
        const installed   = body.agentsInstalled  ?? [];
        const unresolved  = body.agentsUnresolved ?? [];
        let msg = `"${body.pipelineName ?? pl.name}" cloned.`;
        if (installed.length > 0)  msg += ` Cloned ${installed.length} agent${installed.length === 1 ? "" : "s"}: ${installed.join(", ")}.`;
        if (unresolved.length > 0) msg += ` ⚠ ${unresolved.length} agent${unresolved.length === 1 ? "" : "s"} could not be resolved: ${unresolved.join(", ")}.`;
        setWarning(msg);
      }
      // Re-fetch so installed flags on agents update too.
      void load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstallingPipelineId(null);
    }
  }

  async function uninstallPipeline(pl: PipelineCard) {
    if (!confirm(`Uninstall "${pl.name}"? This deletes the tenant copy of the pipeline.`)) return;
    setInstallingPipelineId(pl.id);
    setError(null);
    try {
      const body = (await fetchWithAuth("/api/marketplace/uninstall", {
        method: "POST",
        body:   JSON.stringify({ listingId: pl.id, kind: "pipeline" }),
      })) as { ok?: boolean; removed?: number; message?: string; projects?: string[] };
      setPipelines((cur) => cur.map((p) => p.id === pl.id ? { ...p, installed: false } : p));
      setWarning(body.message ?? "Pipeline uninstalled.");
      void load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstallingPipelineId(null);
    }
  }

  /** Install a skill from this listing — reference mode by default, falls
   *  back to clone for repo-backed listings (which don't support refs
   *  yet). The endpoint surfaces 422 REPO_REF_NOT_SUPPORTED so we can
   *  retry with mode='clone' transparently. */
  async function installSkill(sk: SkillCard, mode: "install" | "clone" = "install") {
    if (!factoryId) { setError("Select an active factory before installing."); return; }
    setInstallingSkillSlug(sk.slug);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch("/api/marketplace/import-skill", {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ listingId, skillSlug: sk.slug, targetFactoryId: factoryId, mode }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; alreadyInstalled?: boolean; mode?: "install" | "clone";
        skillName?: string; message?: string; error?: string; code?: string;
      };
      if (res.status === 422 && body.code === "REPO_REF_NOT_SUPPORTED" && mode === "install") {
        // Repo-backed listing — auto-fallback to clone.
        await installSkill(sk, "clone");
        return;
      }
      if (!res.ok) {
        setError(body.error ?? `Install failed (${res.status})`);
        return;
      }
      setSkills((cur) => cur.map((s) => s.slug === sk.slug ? { ...s, installed: true } : s));
      setWarning(body.message ?? `"${body.skillName ?? sk.name}" installed.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstallingSkillSlug(null);
    }
  }

  async function uninstallSkill(sk: SkillCard) {
    if (!confirm(`Uninstall "${sk.name}"?`)) return;
    setInstallingSkillSlug(sk.slug);
    setError(null);
    try {
      const body = (await fetchWithAuth("/api/marketplace/uninstall", {
        method: "POST",
        body:   JSON.stringify({ listingId, kind: "skill", skillSlug: sk.slug, targetFactoryId: factoryId }),
      })) as { ok?: boolean; removed?: number; message?: string };
      setSkills((cur) => cur.map((s) => s.slug === sk.slug ? { ...s, installed: false } : s));
      setWarning(body.message ?? "Skill uninstalled.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstallingSkillSlug(null);
    }
  }

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, AgentCard[]>();
    for (const a of agents) {
      const key = a.squad ?? "other";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(a);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [agents]);

  const installedCount = agents.filter((a) => a.installed).length;
  const uninstalledCount = agents.length - installedCount;
  const selectedAgents = agents.filter((a) => selected.has(a.slug));
  const selectedInstalled = selectedAgents.filter((a) => a.installed).length;
  const selectedUninstalled = selectedAgents.length - selectedInstalled;

  function toggleOne(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  }

  function selectAllUninstalled() {
    setSelected(new Set(agents.filter((a) => !a.installed).map((a) => a.slug)));
  }

  function selectAllInstalled() {
    setSelected(new Set(agents.filter((a) => a.installed).map((a) => a.slug)));
  }

  function clearSelection() { setSelected(new Set()); }

  /**
   * Install OR update an agent — the /api/marketplace/import endpoint is an
   * upsert keyed by (tenant_id, slug), so the same call both creates a new
   * row and refreshes an existing one with the latest YAML from HEAD of
   * the publisher's verified branch.
   */
  async function installOne(agentSlug: string) {
    if (!factoryId) { setError("Select an active factory before installing."); return; }
    setBusySlug(agentSlug);
    try {
      const body = (await fetchWithAuth("/api/marketplace/import", {
        method: "POST",
        body: JSON.stringify({ listingId, agentSlug, targetFactoryId: factoryId }),
      })) as { ok: boolean; agentId: string; action?: "created" | "updated"; warnings: string[] };
      if (body.warnings?.length) setWarnings((prev) => ({ ...prev, [agentSlug]: body.warnings }));
      else setWarnings((prev) => { const n = { ...prev }; delete n[agentSlug]; return n; });
      setAgents((prev) => prev.map((a) => a.slug === agentSlug ? { ...a, installed: true } : a));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusySlug(null);
    }
  }

  async function uninstallOne(agentSlug: string) {
    if (!factoryId) { setError("Select an active factory before uninstalling."); return; }
    setBusySlug(agentSlug);
    try {
      await fetchWithAuth("/api/marketplace/uninstall", {
        method: "POST",
        body: JSON.stringify({ listingId, agentSlug, targetFactoryId: factoryId }),
      });
      setAgents((prev) => prev.map((a) => a.slug === agentSlug ? { ...a, installed: false } : a));
      setWarnings((prev) => { const n = { ...prev }; delete n[agentSlug]; return n; });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusySlug(null);
    }
  }

  /**
   * Install OR reinstall every selected agent. The /api/marketplace/import
   * endpoint is an upsert keyed by (tenant_id, slug), so this one call
   * creates new rows and refreshes existing ones from HEAD of the
   * publisher's verified branch. If the selection includes agents already
   * installed, confirm first — reinstall overwrites their row.
   */
  async function bulkReinstall() {
    if (!factoryId) { setError("Select an active factory before installing."); return; }
    if (selectedAgents.length === 0) return;
    if (selectedInstalled > 0) {
      const msg = selectedInstalled === selectedAgents.length
        ? `Reinstall ${selectedInstalled} agent(s) from GitHub? Each row will be refreshed with the latest YAML.`
        : `Install ${selectedUninstalled} new agent(s) and reinstall ${selectedInstalled} existing one(s)? Existing rows will be overwritten with the latest YAML.`;
      if (!confirm(msg)) return;
    }
    setBulkBusy(true);
    try {
      for (const a of selectedAgents) {
        const body = (await fetchWithAuth("/api/marketplace/import", {
          method: "POST",
          body: JSON.stringify({ listingId, agentSlug: a.slug, targetFactoryId: factoryId }),
        })) as { warnings?: string[] };
        if (body.warnings?.length) setWarnings((prev) => ({ ...prev, [a.slug]: body.warnings! }));
        else setWarnings((prev) => { const n = { ...prev }; delete n[a.slug]; return n; });
        setAgents((prev) => prev.map((p) => p.slug === a.slug ? { ...p, installed: true } : p));
      }
      clearSelection();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkUninstall() {
    if (!factoryId) { setError("Select an active factory before uninstalling."); return; }
    const toRemove = selectedAgents.filter((a) => a.installed);
    if (toRemove.length === 0) return;
    if (!confirm(`Uninstall ${toRemove.length} agent(s) from your factory?`)) return;
    setBulkBusy(true);
    try {
      for (const a of toRemove) {
        await fetchWithAuth("/api/marketplace/uninstall", {
          method: "POST",
          body: JSON.stringify({ listingId, agentSlug: a.slug, targetFactoryId: factoryId }),
        });
        setAgents((prev) => prev.map((p) => p.slug === a.slug ? { ...p, installed: false } : p));
        setWarnings((prev) => { const n = { ...prev }; delete n[a.slug]; return n; });
      }
      clearSelection();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)", color: "var(--text)", background: "var(--base)" }}>
      <AppSidebar active="marketplace" />
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", padding: "40px 28px 80px" }}>

          {/* Breadcrumb */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--overlay0)", marginBottom: 16 }}>
            <Link href="/marketplace" style={{ color: "var(--overlay1)", textDecoration: "none" }}>Marketplace</Link>
            <ChevronRight size={12} />
            {listing?.store && (
              <>
                <Link href={`/marketplace/stores/${listing.store.slug}`} style={{ color: "var(--overlay1)", textDecoration: "none" }}>
                  {listing.store.name}
                </Link>
                <ChevronRight size={12} />
              </>
            )}
            <span style={{ color: "var(--text)" }}>{listing?.name ?? "…"}</span>
          </div>

          {loading && <div style={{ padding: "40px 0", color: "var(--overlay0)", fontSize: 14 }}>Loading…</div>}

          {error && (
            <div style={{
              padding: "12px 16px", borderRadius: 10, marginBottom: 16,
              background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)",
              color: "var(--red)", fontSize: 13,
            }}>{error}</div>
          )}

          {listing && !loading && (
            <>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 20 }}>
                <div style={{
                  width: 56, height: 56, borderRadius: 14, flexShrink: 0,
                  background: "linear-gradient(135deg, var(--mauve), #6344e0)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <Store size={28} color="#fff" strokeWidth={1.5} />
                </div>
                <div style={{ flex: 1 }}>
                  <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: "var(--font-heading)", margin: 0 }}>{listing.name}</h1>
                  {listing.description && (
                    <p style={{ fontSize: 14, color: "var(--subtext0)", margin: "6px 0 0", lineHeight: 1.5 }}>
                      {listing.description}
                    </p>
                  )}
                  {listing.repo ? (
                    <div style={{
                      display: "flex", alignItems: "center", gap: 5, marginTop: 8,
                      fontSize: 11, color: "var(--overlay0)", fontFamily: "var(--font-mono)",
                    }}>
                      <GitBranch size={11} />
                      {listing.repo.owner}/{listing.repo.name}#{listing.repo.branch} · /factories/{listing.repo.factory_slug}
                    </div>
                  ) : (
                    <div style={{
                      display: "flex", alignItems: "center", gap: 5, marginTop: 8,
                      fontSize: 11, color: "var(--overlay0)",
                    }}>
                      Platform-canonical · agents seeded by migration
                    </div>
                  )}
                </div>
              </div>

              {warning && (
                <div style={{
                  padding: "10px 14px", borderRadius: 8, marginBottom: 16,
                  background: "rgba(245,159,0,0.06)", border: "1px solid rgba(245,159,0,0.25)",
                  color: "var(--yellow)", fontSize: 12, display: "flex", alignItems: "center", gap: 8,
                }}>
                  <AlertCircle size={13} /> {warning}
                </div>
              )}

              {!factoryId && (
                <div style={{
                  padding: "10px 14px", borderRadius: 8, marginBottom: 16,
                  background: "rgba(245,159,0,0.06)", border: "1px solid rgba(245,159,0,0.25)",
                  color: "var(--yellow)", fontSize: 12,
                }}>
                  Select an active factory in <Link href="/factory-settings" style={{ color: "var(--yellow)" }}>Factory Settings</Link> to enable installs.
                </div>
              )}

              {pipelines.length > 0 && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
                    Pipelines ({pipelines.length})
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14, marginBottom: 28 }}>
                    {pipelines.map((p) => {
                      const isInstalling = installingPipelineId === p.id;
                      const intentPalette = p.intent === "discovery"
                        ? { bg: "rgba(20,99,255,0.12)",  fg: "var(--blue)"  }
                        : p.intent === "planning"
                        ? { bg: "rgba(167,139,250,0.12)", fg: "var(--mauve)" }
                        : p.intent === "review"
                        ? { bg: "rgba(245,159,0,0.12)",  fg: "var(--peach)" }
                        : { bg: "rgba(28,191,107,0.12)", fg: "var(--green)" };
                      return (
                        <div key={p.id} style={{
                          background: "var(--mantle)", border: "1px solid var(--surface0)",
                          borderRadius: 12, padding: "16px 18px",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                            <Workflow size={18} color="var(--blue)" />
                            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{p.name}</div>
                            <span style={{
                              fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                              background: intentPalette.bg, color: intentPalette.fg,
                              textTransform: "uppercase", letterSpacing: "0.04em",
                            }}>{p.intent}</span>
                            {p.squad && (
                              <span style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>
                                {p.squad}
                              </span>
                            )}
                            <div style={{ flex: 1 }} />
                            {p.installed ? (
                              <>
                                <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 600 }}>✓ installed</span>
                                <button
                                  onClick={() => void uninstallPipeline(p)}
                                  disabled={isInstalling}
                                  title="Uninstall — removes the marketplace adoption record (reference or clone)"
                                  style={{
                                    padding: "5px 10px", borderRadius: 6, border: "1px solid var(--surface1)",
                                    background: "transparent", color: isInstalling ? "var(--overlay0)" : "var(--red)",
                                    fontSize: 11, fontWeight: 600, cursor: isInstalling ? "wait" : "pointer",
                                    fontFamily: "var(--font-sans)",
                                  }}
                                >
                                  {isInstalling ? "Working…" : "Uninstall"}
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => void installPipeline(p, { mode: "install" })}
                                disabled={isInstalling}
                                title="Install — adopts the canonical pipeline as a reference. To customise, clone it from the Studio card afterwards."
                                style={{
                                  padding: "5px 12px", borderRadius: 6, border: "none",
                                  background: "var(--blue)", color: "#fff",
                                  fontSize: 11, fontWeight: 600, cursor: isInstalling ? "wait" : "pointer",
                                  fontFamily: "var(--font-sans)",
                                }}
                              >
                                {isInstalling ? "Installing…" : "Install"}
                              </button>
                            )}
                          </div>
                          {p.description && (
                            <div style={{ fontSize: 12, color: "var(--subtext0)", lineHeight: 1.5, marginBottom: 12 }}>
                              {p.description}
                            </div>
                          )}
                          {p.steps.length > 0 && (
                            <div style={{
                              display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6,
                              padding: "10px 12px", borderRadius: 6,
                              background: "var(--base)", border: "1px solid var(--surface0)",
                            }}>
                              {p.steps.map((s, idx) => (
                                <React.Fragment key={`${p.id}-${idx}`}>
                                  <span title={s.agent_slug} style={{
                                    display: "inline-flex", alignItems: "center", gap: 4,
                                    padding: "4px 8px", borderRadius: 5,
                                    background: "var(--mantle)", border: "1px solid var(--surface1)",
                                    fontSize: 11, color: "var(--text)", fontWeight: 600,
                                  }}>
                                    {s.agent_icon && <span>{s.agent_icon}</span>}
                                    <span style={{ color: "var(--overlay0)", fontFamily: "var(--font-mono)", fontSize: 9 }}>{s.step}</span>
                                    {s.agent_name}
                                  </span>
                                  {idx < p.steps.length - 1 && <ArrowRight size={12} color="var(--overlay0)" />}
                                </React.Fragment>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
                    Agents ({agents.length})
                  </div>
                </>
              )}

              {/* Skills — published from /factories/{slug}/skills/{slug}/SKILL.md
                  for repo-backed listings, or factory_skills for DB-backed.
                  Each card has Install (ref) — repo-backed listings auto-
                  fallback to clone since refs need a canonical row. */}
              {skills.length > 0 && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
                    Skills ({skills.length})
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12, marginBottom: 28 }}>
                    {skills.map((sk) => {
                      const isInstalling = installingSkillSlug === sk.slug;
                      return (
                        <div key={sk.slug} style={{
                          background: "var(--mantle)", border: "1px solid var(--surface0)",
                          borderRadius: 12, padding: "12px 14px",
                          display: "flex", flexDirection: "column", gap: 8,
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <BookOpen size={16} color="var(--mauve)" />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sk.name}</div>
                              <code style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{sk.slug}</code>
                            </div>
                            {sk.category && (
                              <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(167,139,250,0.12)", color: "var(--mauve)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                                {sk.category}
                              </span>
                            )}
                          </div>
                          {sk.description && (
                            <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5 }}>
                              {sk.description}
                            </div>
                          )}
                          {sk.body_preview && (
                            <div style={{
                              fontSize: 10, color: "var(--overlay1)", lineHeight: 1.5,
                              padding: "6px 8px", borderRadius: 5,
                              background: "var(--base)", border: "1px solid var(--surface0)",
                              maxHeight: 60, overflow: "hidden",
                              fontFamily: "var(--font-mono)",
                            }}>
                              {sk.body_preview}
                            </div>
                          )}
                          {sk.allowed_tools.length > 0 && (
                            <div style={{ fontSize: 10, color: "var(--overlay0)" }}>
                              <span style={{ fontWeight: 600, marginRight: 4 }}>Tools:</span>
                              <span style={{ fontFamily: "var(--font-mono)" }}>{sk.allowed_tools.join(", ")}</span>
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                            {sk.installed ? (
                              <>
                                <span style={{ fontSize: 11, color: "var(--green)", fontWeight: 600, padding: "6px 10px" }}>✓ installed</span>
                                <button
                                  onClick={() => uninstallSkill(sk)}
                                  disabled={!factoryId || isInstalling}
                                  style={{
                                    padding: "6px 10px", borderRadius: 7, border: "1px solid var(--surface1)",
                                    background: "transparent", color: isInstalling ? "var(--overlay0)" : "var(--red)",
                                    fontSize: 11, fontWeight: 700, cursor: (!factoryId || isInstalling) ? "not-allowed" : "pointer",
                                    fontFamily: "var(--font-sans)",
                                  }}
                                >
                                  {isInstalling ? "…" : "Uninstall"}
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => installSkill(sk)}
                                disabled={!factoryId || isInstalling}
                                title="Install — adopts the canonical skill as a reference. Updates from the publisher propagate."
                                style={{
                                  flex: 1,
                                  padding: "6px 10px", borderRadius: 7, border: "none",
                                  background: (isInstalling || !factoryId) ? "var(--surface1)" : "var(--mauve)",
                                  color: (isInstalling || !factoryId) ? "var(--overlay0)" : "#fff",
                                  fontSize: 11, fontWeight: 700,
                                  cursor: (!factoryId || isInstalling) ? "not-allowed" : "pointer",
                                  display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                                  fontFamily: "var(--font-sans)",
                                }}
                              >
                                <Download size={11} /> {isInstalling ? "Installing…" : "Install"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {factoryId && factorySlug && agents.length > 0 && (
                <div style={{
                  padding: "10px 14px", borderRadius: 10, marginBottom: 16,
                  background: "var(--mantle)", border: "1px solid var(--surface0)",
                  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                }}>
                  <div style={{ fontSize: 11, color: "var(--overlay0)" }}>
                    Target: <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{factorySlug}</code>
                    <span style={{ marginLeft: 10 }}>
                      Installed <strong style={{ color: "var(--green)" }}>{installedCount}</strong>
                      {" · "}
                      Available <strong style={{ color: "var(--text)" }}>{uninstalledCount}</strong>
                    </span>
                  </div>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={selectAllUninstalled}
                    disabled={uninstalledCount === 0}
                    style={{
                      padding: "5px 10px", borderRadius: 6, border: "1px solid var(--surface1)",
                      background: "transparent", color: uninstalledCount === 0 ? "var(--overlay0)" : "var(--subtext0)",
                      fontSize: 11, fontWeight: 600, cursor: uninstalledCount === 0 ? "not-allowed" : "pointer",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    Select uninstalled
                  </button>
                  <button
                    onClick={selectAllInstalled}
                    disabled={installedCount === 0}
                    style={{
                      padding: "5px 10px", borderRadius: 6, border: "1px solid var(--surface1)",
                      background: "transparent", color: installedCount === 0 ? "var(--overlay0)" : "var(--subtext0)",
                      fontSize: 11, fontWeight: 600, cursor: installedCount === 0 ? "not-allowed" : "pointer",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    Select installed
                  </button>
                  {selectedAgents.length > 0 && (
                    <button
                      onClick={clearSelection}
                      style={{
                        padding: "5px 10px", borderRadius: 6, border: "1px solid var(--surface1)",
                        background: "transparent", color: "var(--subtext0)",
                        fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
                      }}
                    >
                      Clear ({selectedAgents.length})
                    </button>
                  )}
                  <button
                    onClick={bulkReinstall}
                    disabled={!factoryId || bulkBusy || selectedAgents.length === 0}
                    title="Install or reinstall from the publisher's latest YAML. Existing rows are refreshed in place."
                    style={{
                      padding: "5px 12px", borderRadius: 6, border: "none",
                      background: (!factoryId || bulkBusy || selectedAgents.length === 0) ? "var(--surface1)" : "var(--mauve)",
                      color: (!factoryId || bulkBusy || selectedAgents.length === 0) ? "var(--overlay0)" : "#fff",
                      fontSize: 11, fontWeight: 700,
                      cursor: (!factoryId || bulkBusy || selectedAgents.length === 0) ? "not-allowed" : "pointer",
                      display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--font-sans)",
                    }}
                  >
                    <Download size={11} /> (Re)Install {selectedAgents.length > 0 ? `(${selectedAgents.length})` : ""}
                  </button>
                  <button
                    onClick={bulkUninstall}
                    disabled={!factoryId || bulkBusy || selectedInstalled === 0}
                    style={{
                      padding: "5px 12px", borderRadius: 6, border: "1px solid var(--surface1)",
                      background: "transparent",
                      color: (!factoryId || bulkBusy || selectedInstalled === 0) ? "var(--overlay0)" : "var(--red)",
                      fontSize: 11, fontWeight: 700,
                      cursor: (!factoryId || bulkBusy || selectedInstalled === 0) ? "not-allowed" : "pointer",
                      display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--font-sans)",
                    }}
                  >
                    <CircleOff size={11} /> Uninstall {selectedInstalled > 0 ? `(${selectedInstalled})` : ""}
                  </button>
                </div>
              )}

              {agents.length === 0 && !warning && (
                <div style={{
                  padding: "32px 20px", textAlign: "center",
                  background: "var(--mantle)", border: "1px solid var(--surface0)",
                  borderRadius: 12, color: "var(--overlay0)", fontSize: 13,
                }}>
                  No agents found in this factory yet.
                </div>
              )}

              {grouped.map(([squad, items]) => (
                <div key={squad} style={{ marginBottom: 24 }}>
                  <div style={{
                    display: "flex", alignItems: "center", gap: 6,
                    fontSize: 11, fontWeight: 700, color: "var(--overlay0)",
                    textTransform: "uppercase", letterSpacing: "0.08em",
                    marginBottom: 10,
                  }}>
                    <Users size={12} /> {squad} ({items.length})
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
                    {items.map((a) => {
                      const isBusy = busySlug === a.slug || bulkBusy;
                      const isSelected = selected.has(a.slug);
                      const warns = warnings[a.slug];
                      return (
                        <div key={a.slug} style={{
                          background: "var(--mantle)",
                          border: `1px solid ${isSelected ? "rgba(124,92,252,0.4)" : "var(--surface0)"}`,
                          borderRadius: 12, padding: "12px 14px",
                          display: "flex", flexDirection: "column", gap: 8,
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleOne(a.slug)}
                              disabled={!factoryId}
                              style={{ accentColor: "var(--mauve)", cursor: factoryId ? "pointer" : "not-allowed" }}
                            />
                            <span style={{ fontSize: 18 }}>{a.icon ?? "🤖"}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <div style={{ fontSize: 13, fontWeight: 700 }}>{a.name}</div>
                                {a.installed && (
                                  <span style={{
                                    fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99,
                                    background: "rgba(28,191,107,0.12)", color: "var(--green)",
                                    textTransform: "uppercase", letterSpacing: "0.04em",
                                  }}>
                                    Installed
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>
                                {a.slug}{a.version ? ` · v${a.version}` : ""}
                                {a.level ? ` · ${a.level}` : ""}
                              </div>
                            </div>
                          </div>
                          {a.persona_preview && (
                            <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5 }}>
                              {a.persona_preview}
                            </div>
                          )}
                          {a.tools.length > 0 && (
                            <div style={{ fontSize: 10, color: "var(--overlay0)" }}>
                              <span style={{ fontWeight: 600, marginRight: 4 }}>Tools:</span>
                              <span style={{ fontFamily: "var(--font-mono)" }}>{a.tools.join(", ")}</span>
                            </div>
                          )}

                          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                            <button
                              onClick={() => installOne(a.slug)}
                              disabled={!factoryId || isBusy}
                              title={a.installed ? "Reinstall from the publisher's latest YAML (existing row is refreshed)" : "Install this agent from the publisher's repo"}
                              style={{
                                flex: 1,
                                padding: "6px 10px", borderRadius: 7, border: "none",
                                background: (isBusy || !factoryId) ? "var(--surface1)" : "var(--mauve)",
                                color: (isBusy || !factoryId) ? "var(--overlay0)" : "#fff",
                                fontSize: 11, fontWeight: 700,
                                cursor: (!factoryId || isBusy) ? "not-allowed" : "pointer",
                                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                                fontFamily: "var(--font-sans)",
                              }}
                            >
                              <Download size={11} /> {isBusy ? "Working…" : a.installed ? "(Re)Install" : "Install"}
                            </button>
                            {a.installed && (
                              <button
                                onClick={() => uninstallOne(a.slug)}
                                disabled={!factoryId || isBusy}
                                style={{
                                  flex: 1,
                                  padding: "6px 10px", borderRadius: 7, border: "1px solid var(--surface1)",
                                  background: "transparent",
                                  color: isBusy ? "var(--overlay0)" : "var(--red)",
                                  fontSize: 11, fontWeight: 700,
                                  cursor: (!factoryId || isBusy) ? "not-allowed" : "pointer",
                                  display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                                  fontFamily: "var(--font-sans)",
                                }}
                              >
                                <CircleOff size={11} /> {isBusy ? "…" : "Uninstall"}
                              </button>
                            )}
                          </div>

                          {warns && warns.length > 0 && (
                            <div style={{
                              fontSize: 10, color: "var(--yellow)",
                              padding: "6px 8px", borderRadius: 6,
                              background: "rgba(245,159,0,0.06)", border: "1px solid rgba(245,159,0,0.2)",
                            }}>
                              {warns.map((w, i) => <div key={i}>{w}</div>)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}

        </div>
      </div>

      {pipelineConflict && (() => {
        const info = pipelineConflict.info;
        const pl   = pipelineConflict.pl;
        const busy = installingPipelineId === pl.id;
        return (
          <div
            onClick={busy ? undefined : () => setPipelineConflict(null)}
            style={{
              position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.55)",
              display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%", maxWidth: 460,
                background: "var(--mantle)", border: "1px solid var(--surface0)",
                borderRadius: 14, padding: "22px 24px",
                boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
                fontFamily: "var(--font-sans)", color: "var(--text)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <AlertCircle size={18} color="var(--peach)" />
                <div style={{ fontSize: 15, fontWeight: 800, fontFamily: "var(--font-heading)" }}>
                  Pipeline already installed
                </div>
              </div>
              <p style={{ fontSize: 13, color: "var(--subtext0)", lineHeight: 1.55, margin: "0 0 12px" }}>
                A pipeline named <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{info.slug}</code>{" "}
                already exists in {info.scope}:
              </p>
              <div style={{
                padding: "10px 12px", borderRadius: 8, marginBottom: 16,
                background: "var(--base)", border: "1px solid var(--surface0)",
                fontSize: 12, color: "var(--text)",
              }}>
                <div style={{ fontWeight: 700 }}>{info.existing_name}</div>
                <div style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                  {info.existing_id}
                </div>
              </div>
              <p style={{ fontSize: 11, color: "var(--overlay1)", lineHeight: 1.5, margin: "0 0 16px" }}>
                <strong style={{ color: "var(--text)" }}>Replace</strong> deletes the existing pipeline copy and installs the marketplace version in its place. Projects referencing the old copy will block the replace until reassigned.{" "}
                <strong style={{ color: "var(--text)" }}>Keep existing</strong> closes this dialog without changes.
              </p>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => {
                    const target = pipelineConflict.pl;
                    setPipelineConflict(null);
                    void installPipeline(target, { mode: "clone", onConflict: "cancel" });
                  }}
                  disabled={busy}
                  style={{
                    padding: "7px 14px", borderRadius: 7, border: "1px solid var(--surface1)",
                    background: "transparent", color: "var(--subtext0)",
                    fontSize: 12, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer",
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  Cancel install
                </button>
                <button
                  onClick={() => setPipelineConflict(null)}
                  disabled={busy}
                  style={{
                    padding: "7px 14px", borderRadius: 7, border: "1px solid var(--surface1)",
                    background: "transparent", color: "var(--text)",
                    fontSize: 12, fontWeight: 700, cursor: busy ? "not-allowed" : "pointer",
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  Keep existing
                </button>
                <button
                  onClick={() => {
                    const target = pipelineConflict.pl;
                    setPipelineConflict(null);
                    void installPipeline(target, { mode: "clone", onConflict: "replace" });
                  }}
                  disabled={busy}
                  style={{
                    padding: "7px 14px", borderRadius: 7, border: "none",
                    background: busy ? "var(--surface1)" : "var(--red)",
                    color: busy ? "var(--overlay0)" : "#fff",
                    fontSize: 12, fontWeight: 700, cursor: busy ? "wait" : "pointer",
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  {busy ? "Replacing…" : "Replace"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
