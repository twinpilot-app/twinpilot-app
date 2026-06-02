"use client";

import React, { useEffect, useState, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import AppSidebar from "@/components/AppSidebar";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import MD_COMPONENTS from "@/lib/md-components";
import { slugify } from "@/lib/slugify";
import type { AgentLevel, AgentAutonomy } from "@/lib/types";
import {
  Plus, Play, Zap, GitBranch, Shield, ChevronRight, ChevronDown,
  X, Sparkles, AlertTriangle, Trash2, Bot, BookText, Terminal, ToggleLeft, ToggleRight,
  Search, Users, Layers, FileText, Eye, EyeOff, Network, ArrowRight, ArrowLeft,
  Pencil, Wrench, CheckSquare, Square, FolderKanban, Copy, Download, Upload, Save, Loader2,
  Settings2, Cpu, ShieldCheck, Package,
} from "lucide-react";
import { SkillsSection } from "@/components/SkillsSection";
import { CommandsSection } from "@/components/CommandsSection";
import { HooksSection } from "@/components/HooksSection";
import { OutputStylesSection } from "@/components/OutputStylesSection";
import { PermissionsSection } from "@/components/PermissionsSection";
import { PipManagerSection } from "@/components/PipManagerSection";
// SIPOC matrix removed — agents come from DB, pipeline builder uses allAgents

/** Lazy-loaded behind the Studio "Projects" panel switch. */
const ProjectsPageInner = dynamic(
  () => import("@/app/projects/page").then((m) => m.ProjectsPageInner),
  { ssr: false },
);

/* ═══════════════════════════════════════════════════════════════════════════
   TYPES
═══════════════════════════════════════════════════════════════════════════ */

interface PipelineStep {
  step: number; agent: string; gate: "human" | null; phase: number; phaseName: string;
}
interface Pipeline {
  id: string; slug: string; name: string; description: string | null;
  type: "system" | "custom"; category: string; plan_required: string;
  /** Migration 169 — pipeline-level intent. Filters the per-intent pickers
   *  in Project Settings and surfaces a badge in the pipeline list. */
  intent?: "discovery" | "planning" | "execution" | "review";
  /** mig 191 — null = factory/canonical scope; uuid = project-scope. */
  project_id?: string | null;
  factory_id?: string | null;
  steps: PipelineStep[]; is_active: boolean; created_at: string;
}
interface StepContractInput { from_step: number; artifact: string; required: boolean }
interface StepContractOutput { artifact: string; format: string; quality: string }
interface StepContracts { inputs: StepContractInput[]; outputs: StepContractOutput[]; acceptance: string }

type UserRole = "platform_admin" | "admin" | "member" | null;

type AgentRow = {
  id: string; slug: string; name: string;
  level: AgentLevel | null; enabled: boolean;
  origin: string;
  origin_id: string | null;
  parent_slug: string | null;
  metadata: Record<string, unknown>;
  spec: Record<string, unknown> | null;
  squad: string | null;
  version: string | null;
  tenant_id: string | null;
  factory_id: string | null;
  /** mig 191 — null = factory/canonical scope; uuid = project-scope. */
  project_id: string | null;
  icon: string | null;
  tags: string[];
};
/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════════════════ */

const PLAN_MAX_CUSTOM: Record<string, number> = { starter: Infinity, pro: Infinity, enterprise: Infinity, owner: Infinity };
const PLAN_MAX_STEPS:  Record<string, number> = { starter: Infinity, pro: Infinity, enterprise: Infinity, owner: Infinity };
const PLAN_COLOR: Record<string, string>      = { starter: "#6b7a9e", pro: "#1463ff", enterprise: "#00c2a8", owner: "#a78bfa" };

const AGENT_ICON: Record<string, string> = {
  intake: "📥", scout: "🔭", research: "🔬", "product-owner": "🎯", finance: "💰",
  monetization: "💳", portfolio: "📁", architect: "🏗", devops: "🚀",
  plm: "📋", spec: "📐", design: "🎨", brand: "✨", eval: "⚖️",
  security: "🛡", compliance: "⚖️", privacy: "🔒", "b2b-sales": "🤝",
  developer: "⚙️", qa: "✅", debt: "🔧", docs: "📝", review: "👁",
  release: "📦", growth: "📈", experiment: "🧪", localization: "🌍",
  data: "📊", "executive-ux": "🖥", commandops: "⚡", support: "🎧",
  incident: "🚨",
};
const PHASE_COLOR: Record<string, string> = {
  discovery: "#1463ff", tap: "#00c2a8", "spec-design": "#a78bfa",
  governance: "#e44b5f", strategy: "#f59f00", "build-qa": "#00b4d8",
  review: "#a78bfa", release: "#00c2a8", operations: "#6b7a9e",
  "command-center": "#1463ff", encerramento: "#6b7a9e",
  analysis: "#1463ff", spec: "#a78bfa", build: "#00b4d8", deploy: "#00c2a8",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 12px", borderRadius: 8,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 13, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box",
};


/* ═══════════════════════════════════════════════════════════════════════════
   SHARED: COLLAPSIBLE SECTION HEADER
═══════════════════════════════════════════════════════════════════════════ */

function SectionHeader({ label, count, open, onToggle, action }: {
  label: string; count: number; open: boolean; onToggle: () => void; action?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: open ? 8 : 0, userSelect: "none" }}>
      <button onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 5, flex: 1, background: "transparent", border: "none", cursor: "pointer", padding: "4px 0", color: "var(--overlay0)", fontFamily: "var(--font-sans)" }}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
        <span style={{ fontSize: 10, background: "var(--surface1)", borderRadius: 99, padding: "0 5px", lineHeight: "16px" }}>{count}</span>
      </button>
      {action}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   PIPELINE BUILDER MODAL (visual, SIPOC-aware)
═══════════════════════════════════════════════════════════════════════════ */

const AGENT_ICON_MAP: Record<string, string> = {
  intake: "📥", scout: "🔭", research: "🔬", "product-owner": "🎯",
  finance: "💰", monetization: "💳", portfolio: "📁", architect: "🏗",
  devops: "🚀", plm: "📋", spec: "📐", design: "🎨", brand: "✨", eval: "⚖️",
  security: "🛡", compliance: "⚖️", privacy: "🔒", "b2b-sales": "🤝",
  developer: "⚙️", qa: "✅", debt: "🔧", docs: "📝", review: "👁",
  release: "📦", growth: "📈", experiment: "🧪", localization: "🌍",
  data: "📊", "executive-ux": "🖥", commandops: "⚡", support: "🎧",
  incident: "🚨", "data-engineer": "🛢", "ml-engineer": "🤖",
  "sprint-push": "🚀",
};

const SUGGESTED_PHASES = [
  "discovery", "spec-design", "build-qa", "review",
  "governance", "release", "operations", "strategy", "command-center",
];

function PipelineBuilderModal({
  maxSteps, tenantId, plan,
  pipeline,
  onClose,
  onCreated,
  onUpdated,
  factoryName,
  factoryOrigin,
  factoryId,
  factoryProjects,
}: {
  maxSteps: number; tenantId: string; plan: string;
  pipeline?: Pipeline;
  onClose: () => void;
  onCreated: (p: Pipeline) => void;
  onUpdated?: (p: Pipeline) => void;
  factoryName?: string | null;
  factoryOrigin?: string;
  factoryId?: string | null;
  factoryProjects: { id: string; name: string; slug: string }[];
}) {
  const isEdit = !!pipeline;
  const { session: authSession } = useAuth();
  const [name,        setName]        = useState(pipeline?.name ?? "");
  const [slugVal,     setSlugVal]     = useState(pipeline?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [description, setDescription] = useState(pipeline?.description ?? "");
  const [intent,      setIntent]      = useState<"discovery" | "planning" | "execution" | "review">(
    (pipeline?.intent ?? "execution") as "discovery" | "planning" | "execution" | "review",
  );
  const [steps,       setSteps]       = useState<PipelineStep[]>(pipeline?.steps ?? []);
  const [pipelineMode, setPipelineMode] = useState<"sequential" | "sipoc">((pipeline as Record<string, unknown> | undefined)?.mode as "sequential" | "sipoc" ?? "sequential");
  // mig 191 — Save-to picker. null = factory-scope (project_id IS NULL),
  // string = project-scope. Mirrors AgentsTab's pattern. Pre-fill from
  // existing pipeline on edit so the operator sees current scope.
  const [saveProjectId, setSaveProjectId] = useState<string | null>(pipeline?.project_id ?? null);
  // Phases — derived from steps, editable as containers
  const phases = (() => {
    const map = new Map<number, { name: string; steps: (PipelineStep & { idx: number })[] }>();
    steps.forEach((s, idx) => {
      if (!map.has(s.phase)) map.set(s.phase, { name: s.phaseName, steps: [] });
      map.get(s.phase)!.steps.push({ ...s, idx });
    });
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  })();
  // Pending phases — phases created but with no agents yet
  const [pendingPhases, setPendingPhases] = useState<{ num: number; name: string }[]>([]);
  const maxExistingPhase = Math.max(0, ...phases.map(([n]) => n), ...pendingPhases.map((p) => p.num));
  const nextPhaseNum = maxExistingPhase + 1;
  // Merge real phases (from steps) + pending phases
  const allPhases: [number, { name: string; steps: (PipelineStep & { idx: number })[] }][] = [
    ...phases,
    ...pendingPhases
      .filter((pp) => !phases.find(([n]) => n === pp.num))
      .map((pp) => [pp.num, { name: pp.name, steps: [] }] as [number, { name: string; steps: (PipelineStep & { idx: number })[] }]),
  ].sort((a, b) => a[0] - b[0]);
  const [activePhase, setActivePhase] = useState<number>(phases.length > 0 ? phases[phases.length - 1]![0] : 1);
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [search,       setSearch]       = useState("");
  const [editStepIdx, setEditStepIdx] = useState<number | null>(null);
  const [previewAgent, setPreviewAgent] = useState<{ slug: string; name: string; spec: Record<string, unknown> | null } | null>(null);
  const [showModeHelp, setShowModeHelp] = useState(false);
  const [allAgents, setAllAgents] = useState<{ id: string; slug: string; name: string; squad: string | null; level: string | null; parent_slug: string | null; origin: string; tenant_id: string | null; spec: Record<string, unknown> | null }[]>([]);

  useEffect(() => {
    if (!tenantId) return;
    // Pipeline builder picker — agents the tenant has actually adopted:
    //  · own (tenant_id = tenantId) — created in factory or cloned
    //  · refs (marketplace_installs) — canonical agents the tenant
    //    installed (kind='agent' direct, or kind='pipeline' derived).
    // /api/marketplace/installed-agents resolves the refs server-side
    // and joins canonicals; we merge with tenant-owned rows.
    Promise.all([
      supabase
        .from("agent_definitions")
        .select("id, slug, name, squad, level, parent_slug, tenant_id, origin, factory_id, spec")
        .eq("enabled", true)
        .eq("tenant_id", tenantId),
      authSession
        ? fetch(`/api/marketplace/installed-agents?tenantId=${tenantId}`, {
            headers: { Authorization: `Bearer ${authSession.access_token}` },
          }).then((r) => r.ok ? r.json() : { agents: [] })
        : Promise.resolve({ agents: [] }),
    ]).then(([ownRes, refsRes]) => {
      // PIP RE agents (squad starts with `pip-` per mig 200) are
      // inception machinery — surface them under PIP Manager, not in
      // the generic Studio agent picker. Slug also starts with `pip-`,
      // but squad is the more durable signal (slug could collide with
      // a custom).
      const isPipAgent = (slug: string | null | undefined, squad: string | null | undefined) =>
        (squad ?? "").startsWith("pip-") || (slug ?? "").startsWith("pip-");
      const typed = (ownRes.data ?? []) as { id: string; slug: string; name: string; squad: string | null; level: string | null; parent_slug: string | null; tenant_id: string | null; origin: string; factory_id: string | null; spec: Record<string, unknown> | null }[];
      const own = typed.filter((a) => {
        if (isPipAgent(a.slug, a.squad)) return false;
        if (!factoryId) return true;
        return a.factory_id == null || a.factory_id === factoryId;
      });
      const refs = ((refsRes as { agents?: Array<Record<string, unknown>> }).agents ?? [])
        .filter((a) => !a.broken && !isPipAgent(a.slug as string | undefined, a.squad as string | undefined))
        .map((a) => ({
          id:          a.id as string,
          slug:        a.slug as string,
          name:        a.name as string,
          squad:       (a.squad as string | null) ?? null,
          level:       (a.level as string | null) ?? null,
          parent_slug: (a.parent_slug as string | null) ?? null,
          origin:      (a.origin as string) ?? "built-in",
          tenant_id:   (a.tenant_id as string | null) ?? null,
          spec:        (a.spec as Record<string, unknown> | null) ?? null,
        }));
      // mig 188: same-slug agents from different origins coexist as
      // distinct rows. Dedup by id (not slug) so both show in the picker.
      const ownIds = new Set(own.map((a) => a.id));
      const merged = [
        ...own.map(({ id, slug, name, squad, level, parent_slug, origin, tenant_id, spec }) => ({
          id, slug, name, squad, level, parent_slug, origin, tenant_id, spec,
        })),
        ...refs.filter((a) => !ownIds.has(a.id)),
      ];
      setAllAgents(merged);
    }).catch(() => { /* ignore — picker just stays empty */ });
  }, [tenantId, factoryId, authSession]);

  const sq = search.toLowerCase();
  // Squad visibility for pipeline builder (persisted to factory config)
  const [pipelineHiddenSquads, setPipelineHiddenSquads] = useState<Set<string>>(new Set());
  const pipelineHasUngrouped = allAgents.some((a) => !a.squad);
  const pipelineAllSquads = [
    ...new Set(allAgents.map((a) => a.squad).filter(Boolean)),
    ...(pipelineHasUngrouped ? ["__ungrouped__"] : []),
  ].sort() as string[];

  useEffect(() => {
    if (!factoryId) return;
    supabase.from("factories").select("config").eq("id", factoryId).single()
      .then(({ data }) => {
        const cfg = data?.config as Record<string, unknown> | null;
        const hidden = cfg?.hidden_squads;
        if (Array.isArray(hidden)) setPipelineHiddenSquads(new Set(hidden as string[]));
      });
  }, [factoryId]);

  async function togglePipelineSquad(squad: string) {
    const next = new Set(pipelineHiddenSquads);
    if (next.has(squad)) next.delete(squad); else next.add(squad);
    setPipelineHiddenSquads(next);
    if (!factoryId) return;
    const { data } = await supabase.from("factories").select("config").eq("id", factoryId).single();
    const cfg = (data?.config as Record<string, unknown>) ?? {};
    await supabase.from("factories").update({ config: { ...cfg, hidden_squads: [...next] } }).eq("id", factoryId);
  }
  // mig 188: PickerAgent carries id (for stable React keys when same-slug
  // agents from different origins coexist) AND tenant_id (so the picker can
  // render an origin badge — e.g. "BUILT-IN" vs the publisher tenant).
  type PickerAgent = { id: string; slug: string; name: string; level: string | null; parent_slug: string | null; tenant_id: string | null; origin: string; children: PickerAgent[] };
  const agentsBySquad = (() => {
    const map = new Map<string, PickerAgent[]>();
    const allFiltered: (typeof allAgents[0])[] = [];
    for (const a of allAgents) {
      const key = a.squad ?? "__ungrouped__";
      if (pipelineHiddenSquads.has(key)) continue;
      if (!sq || a.slug.includes(sq) || a.name.toLowerCase().includes(sq)) {
        allFiltered.push(a);
      }
    }
    // Children are matched by parent_slug. With mig 188, multiple super-
    // specialists could share a slug — we still surface them all (each gets
    // its own row keyed by id).
    const superSpecSlugs = new Set(allFiltered.filter((a) => a.level === "super-specialist").map((a) => a.slug));
    for (const a of allFiltered) {
      if (a.level === "super-specialist") continue;
      const key = a.squad ?? "__ungrouped__";
      if (!map.has(key)) map.set(key, []);
      const children = allFiltered
        .filter((c) => c.parent_slug === a.slug && superSpecSlugs.has(c.slug))
        .map((c) => ({ id: c.id, slug: c.slug, name: c.name, level: "super-specialist" as string | null, parent_slug: a.slug as string | null, tenant_id: c.tenant_id, origin: c.origin, children: [] as PickerAgent[] }));
      map.get(key)!.push({ id: a.id, slug: a.slug, name: a.name, level: a.level, parent_slug: a.parent_slug, tenant_id: a.tenant_id, origin: a.origin, children });
    }
    for (const a of allFiltered) {
      if (a.level !== "super-specialist") continue;
      const parentInSet = allFiltered.some((p) => p.slug === a.parent_slug && p.level !== "super-specialist");
      if (!parentInSet) {
        const key = a.squad ?? "__ungrouped__";
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ id: a.id, slug: a.slug, name: a.name, level: a.level, parent_slug: a.parent_slug, tenant_id: a.tenant_id, origin: a.origin, children: [] });
      }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  })();

  // mig 188: addStep takes both slug AND agent_id so the worker can resolve
  // the exact row when two same-slug agents coexist. Pure-slug refs (steps
  // built before mig 188) keep working via slug-priority fallback.
  function addStep(agentSlug: string, agentId: string) {
    if (steps.length >= maxSteps) return;
    const realPhase = phases.find(([n]) => n === activePhase);
    const pendingPhase = pendingPhases.find((p) => p.num === activePhase);
    const pName = realPhase ? realPhase[1].name : (pendingPhase?.name ?? `Phase ${activePhase}`);
    setSteps((prev) => [
      ...prev,
      { step: prev.length + 1, agent: agentSlug, agent_id: agentId, gate: null, phase: activePhase, phaseName: pName },
    ]);
    if (pendingPhase) {
      setPendingPhases((prev) => prev.filter((p) => p.num !== activePhase));
    }
  }

  function addPhase() {
    const num = nextPhaseNum;
    setPendingPhases((prev) => [...prev, { num, name: "" }]);
    setActivePhase(num);
  }

  function removePhase(phaseNum: number) {
    setSteps((prev) => prev.filter((s) => s.phase !== phaseNum).map((s, i) => ({ ...s, step: i + 1 })));
    setPendingPhases((prev) => prev.filter((p) => p.num !== phaseNum));
    if (activePhase === phaseNum) {
      const remaining = allPhases.filter(([n]) => n !== phaseNum);
      setActivePhase(remaining.length > 0 ? remaining[remaining.length - 1]![0] : 1);
    }
  }

  function renamePhase(phaseNum: number, newName: string) {
    setSteps((prev) => prev.map((s) => s.phase === phaseNum ? { ...s, phaseName: newName } : s));
    setPendingPhases((prev) => prev.map((p) => p.num === phaseNum ? { ...p, name: newName } : p));
  }

  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step: i + 1 })));
  }

  async function handleSave() {
    if (!name.trim()) { setError("Pipeline name is required."); return; }
    if (!isEdit && !slugVal.trim()) { setError("Slug is required."); return; }
    // Clean: renumber phases sequentially by position, renumber steps
    const phaseOrder = [...new Set(steps.map((s) => s.phase))];
    const phaseMap = new Map(phaseOrder.map((oldNum, i) => [oldNum, i + 1]));
    const cleanSteps = steps.map((s, i) => ({
      ...s,
      step: i + 1,
      phase: phaseMap.get(s.phase) ?? 1,
      phaseName: s.phaseName || `Phase ${phaseMap.get(s.phase) ?? 1}`,
    }));
    if (cleanSteps.length === 0) { setError("Add at least one step."); return; }
    setSaving(true); setError(null);
    if (!authSession) return;

    let res: Response;
    if (isEdit && pipeline) {
      res = await fetch(`/api/pipelines/${pipeline.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authSession.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, steps: cleanSteps, mode: pipelineMode, intent, projectId: saveProjectId }),
      });
    } else {
      res = await fetch("/api/pipelines", {
        method: "POST",
        headers: { Authorization: `Bearer ${authSession.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, slug: slugVal, name, description, steps: cleanSteps, factoryId, mode: pipelineMode, intent, projectId: saveProjectId }),
      });
    }

    setSaving(false);
    if (res.ok) {
      const body = await res.json() as { pipeline: Pipeline };
      if (isEdit) onUpdated?.(body.pipeline);
      else onCreated(body.pipeline);
    } else {
      const body = await res.json() as { error?: string; details?: { path: string[]; message: string }[] };
      // Surface Zod field-level detail when the server returned it — turns
      // "Request body failed validation" into something diagnosable.
      const detail = body.details?.length
        ? `: ${body.details.map((d) => `${d.path.join(".") || "(root)"} ${d.message}`).join("; ")}`
        : "";
      setError(`${body.error ?? (isEdit ? "Failed to update pipeline." : "Failed to create pipeline.")}${detail}`);
    }
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--mantle)" }}>
        {/* Header — compact: title + meta fields + mode + actions */}
        <div style={{ padding: "10px 20px", borderBottom: "1px solid var(--surface0)", flexShrink: 0 }}>
          {/* Row 1: title + inputs + actions */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input value={name} onChange={(e) => { const v = e.target.value; setName(v); setError(null); if (!slugTouched) setSlugVal(slugify(v)); }} placeholder="Pipeline name" style={{ ...inputStyle, fontWeight: 700, fontSize: 14, flex: 1, padding: "5px 10px" }} />
            {!isEdit && (
              <input value={slugVal} onChange={(e) => { setSlugTouched(true); setSlugVal(slugify(e.target.value, { keepDashes: true })); }} placeholder="slug" style={{ ...inputStyle, fontFamily: "var(--font-mono)", width: 120, fontSize: 11, padding: "5px 8px" }} />
            )}
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" style={{ ...inputStyle, flex: 1, fontSize: 11, padding: "5px 10px", color: "var(--subtext0)" }} />
            <select
              value={intent}
              onChange={(e) => setIntent(e.target.value as "discovery" | "planning" | "execution" | "review")}
              title="Pipeline intent — drives where it shows up in Project Settings"
              style={{ ...inputStyle, width: 110, fontSize: 11, padding: "5px 8px", flexShrink: 0 }}
            >
              <option value="discovery">Discovery</option>
              <option value="planning">Planning</option>
              <option value="execution">Execution</option>
              <option value="review">Review</option>
            </select>
            <span style={{ fontSize: 10, color: "var(--overlay0)", flexShrink: 0 }}>{steps.length} steps</span>
            {/* Save scope picker (mig 191) — mirrors AgentsTab. Always
                visible when the factory has projects, independent of
                the header's view-scope expander. */}
            {factoryProjects.length > 0 && (
              <select
                value={saveProjectId ?? ""}
                onChange={(e) => setSaveProjectId(e.target.value || null)}
                title="Where this pipeline will be saved. Factory = shared across all the factory's projects; Project = scoped to one project only."
                style={{ ...inputStyle, fontSize: 11, padding: "5px 8px", flexShrink: 0, maxWidth: 180 }}
              >
                <option value="">Save to: Factory</option>
                {factoryProjects.map((p) => (
                  <option key={p.id} value={p.id}>Save to: {p.name}</option>
                ))}
              </select>
            )}
            {error && <span style={{ fontSize: 10, color: "var(--red)", display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}><AlertTriangle size={11} /> {error}</span>}
            <button onClick={handleSave} disabled={saving || steps.length === 0} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 12px", borderRadius: 7, border: "none", background: steps.length === 0 ? "var(--surface1)" : "var(--blue)", color: steps.length === 0 ? "var(--overlay0)" : "#fff", fontSize: 11, fontWeight: 700, cursor: saving || steps.length === 0 ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1, fontFamily: "var(--font-sans)", flexShrink: 0 }}>
              {saving ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={12} />}
              {isEdit ? "Save" : "Create"}
            </button>
            <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, flexShrink: 0 }}><X size={16} /></button>
          </div>
          {/* Row 2: mode toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Mode</span>
            <button onClick={() => setShowModeHelp((v) => !v)} title="How pipeline modes work" style={{ background: "none", border: "none", cursor: "pointer", color: showModeHelp ? "var(--blue)" : "var(--overlay0)", padding: 0, fontSize: 11 }}>?</button>
            {(["sequential", "sipoc"] as const).map((m) => (
              <button key={m} onClick={() => setPipelineMode(m)} style={{
                padding: "2px 10px", borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: "pointer",
                border: `1px solid ${pipelineMode === m ? (m === "sipoc" ? "var(--peach)" : "var(--blue)") : "var(--surface1)"}`,
                background: pipelineMode === m ? (m === "sipoc" ? "var(--peach)18" : "var(--blue)18") : "transparent",
                color: pipelineMode === m ? (m === "sipoc" ? "var(--peach)" : "var(--blue)") : "var(--subtext0)",
                fontFamily: "var(--font-sans)", textTransform: "uppercase", letterSpacing: "0.04em",
              }}>
                {m === "sequential" ? "Sequential" : "SIPOC"}
              </button>
            ))}
            <span style={{ fontSize: 10, color: "var(--overlay0)", flex: 1 }}>
              {pipelineMode === "sequential" ? "No artifact validation" : "Contracts enforced between steps"}
            </span>
            <div style={{ position: "relative", flexShrink: 0 }}>
              <Search size={11} color="var(--overlay0)" style={{ position: "absolute", left: 6, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter agents…" style={{ ...inputStyle, padding: "3px 8px 3px 22px", width: 150, fontSize: 11 }} />
            </div>
          </div>

          {/* Help panel */}
          {showModeHelp && (
            <div style={{ marginTop: 10, padding: "14px 16px", borderRadius: 8, background: "var(--base)", border: "1px solid var(--surface0)", fontSize: 12, lineHeight: 1.7, color: "var(--subtext1)", maxHeight: 300, overflowY: "auto" }}>
              <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 10, fontSize: 13 }}>How Pipeline Modes Work</div>

              <div style={{ fontWeight: 700, color: "var(--blue)", marginBottom: 4 }}>Sequential Mode</div>
              <p style={{ margin: "0 0 10px" }}>
                Agents run in order, one after another. Each agent receives the project briefing plus <strong>references to all artifacts</strong> produced by previous agents. The agent uses tools (<code>read_artifact</code>, <code>list_artifacts</code>) to read what it needs on demand. No validation is performed on inputs or outputs.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 14, fontSize: 11 }}>
                <thead><tr style={{ borderBottom: "1px solid var(--surface1)" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--overlay0)", fontWeight: 700 }}>Step</th>
                  <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--overlay0)", fontWeight: 700 }}>What the agent receives</th>
                  <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--overlay0)", fontWeight: 700 }}>What the agent produces</th>
                </tr></thead>
                <tbody>
                  <tr style={{ borderBottom: "1px solid var(--surface0)" }}>
                    <td style={{ padding: "4px 8px" }}>1. Architect</td>
                    <td style={{ padding: "4px 8px" }}>Project briefing</td>
                    <td style={{ padding: "4px 8px" }}>Architecture Spec (saved to storage)</td>
                  </tr>
                  <tr style={{ borderBottom: "1px solid var(--surface0)" }}>
                    <td style={{ padding: "4px 8px" }}>2. Developer</td>
                    <td style={{ padding: "4px 8px" }}>Briefing + ref to Architecture Spec</td>
                    <td style={{ padding: "4px 8px" }}>Code + Tests (saved to storage)</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px 8px" }}>3. QA</td>
                    <td style={{ padding: "4px 8px" }}>Briefing + refs to Arch Spec + Code</td>
                    <td style={{ padding: "4px 8px" }}>Test Report</td>
                  </tr>
                </tbody>
              </table>

              <div style={{ fontWeight: 700, color: "var(--peach)", marginBottom: 4 }}>SIPOC Mode</div>
              <p style={{ margin: "0 0 10px" }}>
                Same sequential execution, but each step has <strong>contracts</strong> defining which artifacts it expects as input and what it must produce as output. Before running, the orchestrator <strong>validates</strong> that required inputs exist. If a required artifact is missing, the agent escalates to human or fails.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 14, fontSize: 11 }}>
                <thead><tr style={{ borderBottom: "1px solid var(--surface1)" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--overlay0)", fontWeight: 700 }}>Contract field</th>
                  <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--overlay0)", fontWeight: 700 }}>Description</th>
                </tr></thead>
                <tbody>
                  <tr style={{ borderBottom: "1px solid var(--surface0)" }}>
                    <td style={{ padding: "4px 8px", fontWeight: 600 }}>Inputs</td>
                    <td style={{ padding: "4px 8px" }}>Artifacts expected from previous steps (required or optional)</td>
                  </tr>
                  <tr style={{ borderBottom: "1px solid var(--surface0)" }}>
                    <td style={{ padding: "4px 8px", fontWeight: 600 }}>Outputs</td>
                    <td style={{ padding: "4px 8px" }}>Artifacts this step must produce (with format and quality gates)</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "4px 8px", fontWeight: 600 }}>Acceptance</td>
                    <td style={{ padding: "4px 8px" }}>Criteria the step must meet before the pipeline continues</td>
                  </tr>
                </tbody>
              </table>

              <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>How Agents Read Artifacts</div>
              <p style={{ margin: 0 }}>
                Artifacts are stored in Supabase Storage (cloud) or the local filesystem (dev mode). The orchestrator passes <strong>artifact references</strong> (storage paths) in the agent&apos;s prompt. The agent calls <code>read_artifact(path)</code> to load the content on demand. Agents never receive the full content of all previous artifacts — they selectively read what they need using the provided tools.
              </p>
            </div>
          )}
        </div>

        {/* Two-pane: steps + picker */}
        <div style={{ display: "flex", minHeight: 420, overflow: "hidden" }}>
          {/* Left: phases + steps */}
          <div style={{ width: 300, minWidth: 300, borderRight: "1px solid var(--surface0)", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "10px 14px 6px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--overlay0)" }}>Phases &amp; Steps</span>
              <button onClick={() => addPhase()} style={{ fontSize: 10, fontWeight: 700, color: "var(--blue)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-sans)" }}>+ Phase</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }}>
              {allPhases.length === 0 ? (
                <div style={{ padding: "24px 0", textAlign: "center", color: "var(--overlay0)", fontSize: 12 }}>
                  <GitBranch size={20} style={{ margin: "0 auto 6px", display: "block" }} />
                  Create a phase, then pick agents →
                </div>
              ) : (
                <>
                  {allPhases.map(([phaseNum, phase], phaseIdx) => {
                    const isActive = activePhase === phaseNum;
                    const color = PHASE_COLOR[phase.name] ?? "#6b7a9e";
                    return (
                      <div key={phaseNum} style={{ marginBottom: 8 }}>
                        {/* Phase header */}
                        <div
                          onClick={() => setActivePhase(phaseNum)}
                          style={{
                            display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 6, cursor: "pointer",
                            background: isActive ? `${color}18` : "transparent",
                            border: isActive ? `1px solid ${color}40` : "1px solid transparent",
                          }}
                        >
                          <span style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", flexShrink: 0, width: 14, textAlign: "center" }}>{phaseIdx + 1}</span>
                          <div style={{ width: 3, height: 12, borderRadius: 2, background: color, flexShrink: 0 }} />
                          <input
                            autoFocus={!phase.name}
                            value={phase.name}
                            onChange={(e) => renamePhase(phaseNum, e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 11, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-sans)", padding: 0 }}
                            placeholder="Phase name"
                          />
                          <span style={{ fontSize: 9, color: "var(--overlay0)" }}>{phase.steps.length}</span>
                          <button onClick={(e) => { e.stopPropagation(); removePhase(phaseNum); }} title="Remove phase" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 1, fontSize: 10 }}><X size={10} /></button>
                        </div>
                        {/* Agents in this phase */}
                        <div style={{ paddingLeft: 14, marginTop: 2 }}>
                          {phase.steps.length === 0 && (
                            <div style={{ padding: "6px 8px", fontSize: 10, color: "var(--overlay0)", fontStyle: "italic" }}>
                              Pick agents from the right →
                            </div>
                          )}
                          {phase.steps.map((s) => {
                            const hasContracts = !!(s as PipelineStep & { contracts?: unknown }).contracts;
                            const needsContract = pipelineMode === "sipoc" && !hasContracts;
                            return (
                              <div key={s.idx} onClick={() => pipelineMode === "sipoc" ? setEditStepIdx(s.idx) : undefined} style={{
                                display: "flex", alignItems: "center", gap: 5, padding: "4px 6px", borderRadius: 6, marginBottom: 2,
                                background: "var(--surface0)", cursor: pipelineMode === "sipoc" ? "pointer" : "default",
                                border: needsContract ? "1px solid var(--peach)40" : "1px solid transparent",
                              }}>
                                <span style={{ fontSize: 12, flexShrink: 0 }}>{AGENT_ICON_MAP[s.agent] ?? "🤖"}</span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 10, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{allAgents.find((a) => a.slug === s.agent)?.name ?? s.agent}</div>
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); const a = allAgents.find((x) => x.slug === s.agent); if (a) setPreviewAgent(a); }} title="View spec" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 1, fontSize: 9 }}>?</button>
                                <button onClick={(e) => { e.stopPropagation(); removeStep(s.idx); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 1 }}><X size={10} /></button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* Right: agent picker */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {/* Squad visibility toggles */}
            {pipelineAllSquads.length > 0 && (
              <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--surface0)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <button onClick={() => setPipelineHiddenSquads(new Set())} style={{ fontSize: 9, fontWeight: 600, color: "var(--blue)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", padding: 0 }}>All</button>
                  <button onClick={() => setPipelineHiddenSquads(new Set(pipelineAllSquads))} style={{ fontSize: 9, fontWeight: 600, color: "var(--overlay0)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", padding: 0 }}>None</button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {pipelineAllSquads.map((squad) => {
                    const visible = !pipelineHiddenSquads.has(squad);
                    const isUngrouped = squad === "__ungrouped__";
                    const color = isUngrouped ? "var(--overlay0)" : (SQUAD_COLORS[squad] ?? "var(--overlay1)");
                    return (
                      <button key={squad} onClick={() => togglePipelineSquad(squad)} style={{
                        padding: "2px 8px", borderRadius: 5, border: "none", fontSize: 10, fontWeight: 600, cursor: "pointer",
                        background: visible ? `${color}18` : "var(--surface0)",
                        color: visible ? color : "var(--overlay0)",
                        opacity: visible ? 1 : 0.4,
                        fontFamily: "var(--font-sans)", transition: "all 0.15s",
                        fontStyle: isUngrouped ? "italic" : "normal",
                      }}>
                        {isUngrouped ? "Standalone" : squad} <span style={{ fontSize: 9, opacity: 0.7 }}>{allAgents.filter((a) => isUngrouped ? !a.squad : a.squad === squad).length}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Agent picker — grouped by squad, card layout with collapsible sub-specialists */}
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
              {agentsBySquad.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {agentsBySquad.map(([squadName, squadAgents]) => {
                    const color = SQUAD_COLORS[squadName] ?? "var(--overlay1)";
                    return (
                      <div key={squadName}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <div style={{ width: 3, height: 14, borderRadius: 2, background: color }} />
                          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--subtext1)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                            {squadName === "__ungrouped__" ? "Standalone" : squadName}
                          </span>
                          <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{squadAgents.length}</span>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 6 }}>
                          {squadAgents.map((a) => (
                            <div key={a.id}>
                              {/* Agent card — click to add */}
                              <div
                                onClick={() => addStep(a.slug, a.id)}
                                style={{ background: "var(--surface0)", border: "1px solid var(--surface1)", borderRadius: 8, padding: "8px 10px", cursor: "pointer", transition: "border-color 0.15s" }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--blue)"; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--surface1)"; }}
                              >
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <span style={{ fontSize: 14, flexShrink: 0 }}>{AGENT_ICON_MAP[a.slug] ?? "🤖"}</span>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
                                    <code style={{ fontSize: 9, color: "var(--overlay0)" }}>{a.slug}</code>
                                  </div>
                                  {/* Origin badge — surfaces "BUILT-IN" vs the publisher tenant */}
                                  {a.origin && (
                                    <span title={`origin: ${a.origin}`} style={{ fontSize: 8, fontWeight: 700, padding: "1px 4px", borderRadius: 3, background: a.origin === "built-in" ? "rgba(20,99,255,0.12)" : "rgba(203,166,247,0.12)", color: a.origin === "built-in" ? "var(--blue)" : "var(--mauve)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                                      {a.origin === "built-in" ? "built-in" : "ext"}
                                    </span>
                                  )}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); const ag = allAgents.find((x) => x.id === a.id); if (ag) setPreviewAgent(ag); }}
                                    title="View spec"
                                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, fontSize: 10 }}
                                  >?</button>
                                </div>
                              </div>
                              {/* Collapsible sub-specialists */}
                              {a.children.length > 0 && (
                                <details style={{ marginTop: 3, marginLeft: 12 }}>
                                  <summary style={{ fontSize: 10, color: "var(--overlay1)", cursor: "pointer", listStyle: "none", display: "flex", alignItems: "center", gap: 4, padding: "2px 0", fontFamily: "var(--font-sans)" }}>
                                    <ChevronRight size={10} />
                                    {a.children.length} sub-specialist{a.children.length > 1 ? "s" : ""}
                                  </summary>
                                  <div style={{ marginTop: 3, display: "flex", flexDirection: "column", gap: 3, borderLeft: `2px solid ${color}40`, paddingLeft: 8 }}>
                                    {a.children.map((c) => (
                                      <div
                                        key={c.id}
                                        onClick={() => addStep(c.slug, c.id)}
                                        style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 6, padding: "5px 8px", cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--blue)"; }}
                                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = "var(--surface0)"; }}
                                      >
                                        <span style={{ fontSize: 12 }}>{AGENT_ICON_MAP[c.slug] ?? "🤖"}</span>
                                        <span style={{ fontSize: 10, fontWeight: 600, flex: 1 }}>{c.name}</span>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); const ag = allAgents.find((x) => x.id === c.id); if (ag) setPreviewAgent(ag); }}
                                          title="View spec"
                                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 1, fontSize: 9 }}
                                        >?</button>
                                      </div>
                                    ))}
                                  </div>
                                </details>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--overlay0)", fontSize: 12 }}>No agents match your filter.</div>
              )}
            </div>
          </div>
        </div>

        {/* Agent spec preview */}
        {previewAgent && (() => {
          const s = previewAgent.spec ?? {};
          const autonomy = (s.autonomy as string) ?? "auto";
          return (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(3px)", zIndex: 150, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
              <div style={{ background: "var(--mantle)", border: "1px solid var(--surface1)", borderRadius: 14, width: "min(500px, 95vw)", maxHeight: "70vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{previewAgent.name}</div>
                  <button onClick={() => setPreviewAgent(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)" }}><X size={18} /></button>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", fontSize: 13, lineHeight: 1.7, color: "var(--subtext1)" }}>
                  {s.description ? <><div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Description</div><p style={{ margin: "0 0 14px", whiteSpace: "pre-wrap" }}>{String(s.description)}</p></> : null}
                  {Array.isArray(s.output_types) && (s.output_types as string[]).length > 0 && (
                    <><div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Output Types</div><ul style={{ margin: "0 0 14px", paddingLeft: 18 }}>{(s.output_types as string[]).map((t) => <li key={t}>{t}</li>)}</ul></>
                  )}
                  {Array.isArray(s.suggested_inputs) && (s.suggested_inputs as string[]).length > 0 && (
                    <><div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Suggested Inputs</div><ul style={{ margin: "0 0 14px", paddingLeft: 18 }}>{(s.suggested_inputs as string[]).map((t) => <li key={t}>{t}</li>)}</ul></>
                  )}
                  {Array.isArray(s.tools) && (s.tools as string[]).length > 0 && (
                    <><div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Tools</div><div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 14 }}>{(s.tools as string[]).map((t) => <span key={t} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "var(--surface0)", fontFamily: "var(--font-mono)" }}>{t}</span>)}</div></>
                  )}
                  <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--overlay0)" }}>
                    <span>Autonomy: <strong style={{ color: "var(--text)" }}>{autonomy}</strong></span>
                    {s.sla ? <span>SLA: <strong style={{ color: "var(--text)" }}>{String(s.sla)}</strong></span> : null}
                  </div>
                  {s.human_gate_reason ? <div style={{ marginTop: 8, fontSize: 12, color: "var(--peach)" }}>Gate: {String(s.human_gate_reason)}</div> : null}
                  {s.guardrails ? <><div style={{ fontWeight: 600, color: "var(--text)", marginTop: 14, marginBottom: 4 }}>Guardrails</div><p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 12 }}>{String(s.guardrails)}</p></> : null}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Step contract editor (SIPOC mode) */}
        {editStepIdx !== null && pipelineMode === "sipoc" && (() => {
          const step = steps[editStepIdx];
          if (!step) return null;
          const contracts = (step as PipelineStep & { contracts?: StepContracts }).contracts ?? { inputs: [], outputs: [], acceptance: "" };
          const agentDef = allAgents.find((a) => a.slug === step.agent);
          const agentOutputTypes = (agentDef?.spec?.output_types ?? []) as string[];

          // Available outputs from previous steps
          const prevStepOutputs: { step: number; agent: string; artifacts: string[] }[] = [];
          for (const ps of steps) {
            if (ps.step >= step.step) break;
            const pContracts = (ps as PipelineStep & { contracts?: StepContracts }).contracts;
            const pAgent = allAgents.find((a) => a.slug === ps.agent);
            const arts = pContracts?.outputs?.map((o) => o.artifact) ?? (pAgent?.spec?.output_types ?? []) as string[];
            if (arts.length > 0) prevStepOutputs.push({ step: ps.step, agent: ps.agent, artifacts: arts });
          }

          function updateContracts(c: StepContracts) {
            setSteps((prev) => prev.map((s, i) => i === editStepIdx ? { ...s, contracts: c } as PipelineStep : s));
          }

          return (
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(3px)", zIndex: 150, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
              <div style={{ background: "var(--mantle)", border: "1px solid var(--surface1)", borderRadius: 14, width: "min(560px, 95vw)", maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>Step #{step.step} — {step.agent}</div>
                    <div style={{ fontSize: 11, color: "var(--overlay0)" }}>Define input/output contracts for this step</div>
                  </div>
                  <button onClick={() => setEditStepIdx(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)" }}><X size={18} /></button>
                </div>

                <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 16 }}>
                  {/* Inputs — from previous steps */}
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--overlay0)", marginBottom: 8 }}>Inputs</div>
                    {prevStepOutputs.length > 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {prevStepOutputs.map((ps) => (
                          <div key={ps.step}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4, display: "flex", alignItems: "center", gap: 5 }}>
                              <Bot size={11} style={{ color: "var(--blue)" }} /> Step #{ps.step} — {ps.agent}
                            </div>
                            {ps.artifacts.map((art) => {
                              const existing = contracts.inputs.find((inp) => inp.from_step === ps.step && inp.artifact === art);
                              return (
                                <div key={art} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0 3px 16px" }}>
                                  <span style={{ flex: 1, fontSize: 12, color: "var(--text)" }}>{art}</span>
                                  {existing ? (
                                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                      <button
                                        onClick={() => updateContracts({ ...contracts, inputs: contracts.inputs.map((inp) => inp.from_step === ps.step && inp.artifact === art ? { ...inp, required: !inp.required } : inp) })}
                                        style={{ fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 4, border: "none", cursor: "pointer", background: existing.required ? "var(--blue)" : "var(--surface1)", color: existing.required ? "#fff" : "var(--overlay0)" }}
                                      >
                                        {existing.required ? "Required" : "Optional"}
                                      </button>
                                      <button
                                        onClick={() => updateContracts({ ...contracts, inputs: contracts.inputs.filter((inp) => !(inp.from_step === ps.step && inp.artifact === art)) })}
                                        style={{ fontSize: 10, background: "none", border: "none", cursor: "pointer", color: "var(--red)", padding: 2 }}
                                      >
                                        <X size={12} />
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => updateContracts({ ...contracts, inputs: [...contracts.inputs, { from_step: ps.step, artifact: art, required: true }] })}
                                      style={{ padding: "2px 8px", borderRadius: 4, border: "none", background: "var(--blue)", color: "#fff", fontSize: 10, fontWeight: 600, cursor: "pointer" }}
                                    >
                                      + Add
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: "var(--overlay0)" }}>First step — no inputs from previous steps.</div>
                    )}
                  </div>

                  {/* Outputs */}
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--overlay0)", marginBottom: 8 }}>Outputs</div>
                    {agentOutputTypes.length > 0 && (
                      <div style={{ marginBottom: 8, padding: "6px 10px", borderRadius: 6, background: "var(--surface0)", fontSize: 11 }}>
                        <div style={{ fontWeight: 600, color: "var(--subtext0)", marginBottom: 4 }}>Agent capabilities:</div>
                        {agentOutputTypes.map((art) => {
                          const existing = contracts.outputs.find((o) => o.artifact === art);
                          return (
                            <div key={art} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
                              <span style={{ flex: 1, fontSize: 12, color: "var(--text)" }}>{art}</span>
                              {existing ? (
                                <span style={{ fontSize: 9, fontWeight: 600, color: "var(--green)" }}>Added</span>
                              ) : (
                                <button
                                  onClick={() => updateContracts({ ...contracts, outputs: [...contracts.outputs, { artifact: art, format: "", quality: "" }] })}
                                  style={{ padding: "2px 8px", borderRadius: 4, border: "none", background: "var(--blue)", color: "#fff", fontSize: 10, fontWeight: 600, cursor: "pointer" }}
                                >
                                  + Add
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {contracts.outputs.map((o, i) => (
                      <div key={i} style={{ display: "flex", gap: 5, marginBottom: 4 }}>
                        <input value={o.artifact} onChange={(e) => updateContracts({ ...contracts, outputs: contracts.outputs.map((x, j) => j === i ? { ...x, artifact: e.target.value } : x) })} placeholder="Artifact name" style={{ ...inputStyle, flex: 1, fontSize: 11, padding: "4px 8px" }} />
                        <input value={o.format} onChange={(e) => updateContracts({ ...contracts, outputs: contracts.outputs.map((x, j) => j === i ? { ...x, format: e.target.value } : x) })} placeholder="Format" style={{ ...inputStyle, flex: 1, fontSize: 11, padding: "4px 8px" }} />
                        <input value={o.quality} onChange={(e) => updateContracts({ ...contracts, outputs: contracts.outputs.map((x, j) => j === i ? { ...x, quality: e.target.value } : x) })} placeholder="Quality gate" style={{ ...inputStyle, flex: 1, fontSize: 11, padding: "4px 8px" }} />
                        <button onClick={() => updateContracts({ ...contracts, outputs: contracts.outputs.filter((_, j) => j !== i) })} style={{ padding: "2px 7px", borderRadius: 5, border: "1px solid var(--red)30", background: "transparent", color: "var(--red)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}>x</button>
                      </div>
                    ))}
                    <button onClick={() => updateContracts({ ...contracts, outputs: [...contracts.outputs, { artifact: "", format: "", quality: "" }] })} style={{ padding: "2px 7px", borderRadius: 5, border: "1px solid var(--surface1)", background: "transparent", color: "var(--overlay0)", fontSize: 11, cursor: "pointer" }}>+ Add</button>
                  </div>

                  {/* Acceptance criteria */}
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--overlay0)", marginBottom: 6 }}>Acceptance criteria</div>
                    <textarea
                      value={contracts.acceptance}
                      onChange={(e) => updateContracts({ ...contracts, acceptance: e.target.value })}
                      placeholder="e.g. All tests pass, no critical lint errors"
                      rows={2}
                      style={{ ...inputStyle, resize: "vertical", fontSize: 12, width: "100%", boxSizing: "border-box" }}
                    />
                  </div>
                </div>

                <div style={{ padding: "12px 18px", borderTop: "1px solid var(--surface0)", display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={() => setEditStepIdx(null)} style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Done</button>
                </div>
              </div>
            </div>
          );
        })()}

    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   PIPELINE CANVAS
═══════════════════════════════════════════════════════════════════════════ */

function PipelineCanvas({ steps }: { steps: PipelineStep[] }) {
  if (steps.length === 0) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: "var(--overlay0)" }}>
      <GitBranch size={32} />
      <span style={{ fontSize: 13 }}>Select a pipeline to preview its flow</span>
    </div>
  );
  const phases = steps.reduce<Record<number, PipelineStep[]>>((acc, s) => {
    (acc[s.phase] ??= []).push(s); return acc;
  }, {});
  return (
    <div style={{ padding: "24px 28px", overflowY: "auto", height: "100%" }}>
      {Object.entries(phases).map(([phaseNum, phaseSteps]) => {
        const phaseName = phaseSteps[0]!.phaseName;
        const color = PHASE_COLOR[phaseName] ?? "#6b7a9e";
        return (
          <div key={phaseNum} style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color }}>{phaseName}</span>
              <div style={{ flex: 1, height: 1, background: `${color}30` }} />
              <span style={{ fontSize: 10, color: "var(--overlay0)" }}>Phase {phaseNum}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
              {phaseSteps.map((s, i) => (
                <React.Fragment key={s.step}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "10px 14px", borderRadius: 10, background: "var(--mantle)", border: s.gate === "human" ? `1.5px solid ${color}` : "1px solid var(--surface1)", minWidth: 80, position: "relative" }}>
                    {s.gate === "human" && (
                      <div style={{ position: "absolute", top: -6, right: -6, background: color, borderRadius: "50%", width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Shield size={9} color="#fff" />
                      </div>
                    )}
                    <span style={{ fontSize: 18 }}>{AGENT_ICON[s.agent] ?? "🤖"}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: "var(--subtext1)", textAlign: "center", whiteSpace: "nowrap" }}>{s.agent}</span>
                    <span style={{ fontSize: 9, color: "var(--overlay0)" }}>#{s.step}</span>
                  </div>
                  {i < phaseSteps.length - 1 && <ChevronRight size={14} color="var(--surface1)" style={{ flexShrink: 0 }} />}
                </React.Fragment>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   DANGER MODAL — generic destructive-action confirmation with impact list
═══════════════════════════════════════════════════════════════════════════ */

interface DangerAction {
  title: string;
  /** Warning lines shown in the modal body. */
  warnings: string[];
  /** If set, the delete button is replaced with this blocking message. */
  blockMessage?: string;
  onConfirm: () => Promise<void>;
}

function DangerModal({ action, onClose }: { action: DangerAction; onClose: () => void }) {
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    try { await action.onConfirm(); } finally { setRunning(false); }
    onClose();
  }
  return (
    <Modal title={action.title} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {action.warnings.map((w, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 12px", borderRadius: 8, background: "rgba(231,130,132,0.08)", border: "1px solid rgba(231,130,132,0.2)", fontSize: 12, color: "var(--red)", lineHeight: 1.5 }}>
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{w}</span>
          </div>
        ))}
        {action.blockMessage && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 12px", borderRadius: 8, background: "rgba(231,130,132,0.18)", border: "1px solid rgba(231,130,132,0.4)", fontSize: 12, color: "var(--red)", fontWeight: 600, lineHeight: 1.5 }}>
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{action.blockMessage}</span>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
        <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid var(--surface1)", background: "var(--surface0)", color: "var(--text)", fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
          Cancel
        </button>
        {!action.blockMessage && (
          <button onClick={run} disabled={running} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--red)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: running ? "not-allowed" : "pointer", opacity: running ? 0.6 : 1, fontFamily: "var(--font-sans)" }}>
            {running ? "Deleting…" : "Delete anyway"}
          </button>
        )}
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   PIPELINES TAB
═══════════════════════════════════════════════════════════════════════════ */

function PipelinesTab({ tenantId, plan, hideBuiltIn, factoryName, factoryOrigin, factoryId, inheritedFactoryIds, scopedProjects, factoryProjects, factoryInScope }: { tenantId: string | null; plan: string; hideBuiltIn: boolean; factoryName?: string | null; factoryOrigin?: string; factoryId?: string | null; inheritedFactoryIds: string[]; scopedProjects: { id: string; name: string; slug: string }[]; factoryProjects: { id: string; name: string; slug: string }[]; factoryInScope: boolean }) {
  const { session } = useAuth();
  const [ownPipelines, setOwnPipelines] = useState<Pipeline[]>([]);
  const [inheritedPipelines, setInheritedPipelines] = useState<Pipeline[]>([]);
  /** Pipelines under the "Installed" sidebar bucket — tenant-level
   *  customs + canonical refs. Stored as the underlying Pipeline rows;
   *  the ref-listing map below carries the listing_id so Trash can
   *  call /api/marketplace/uninstall. */
  const [builtInPipelines, setBuiltInPipelines] = useState<Pipeline[]>([]);
  /** pipeline.id → listing_id when the row is a marketplace ref. */
  const [installedListingMap, setInstalledListingMap] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showNew, setShowNew] = useState(false);
  const [editingPipeline, setEditingPipeline] = useState<Pipeline | null>(null);

  const [dangerModal, setDangerModal] = useState<DangerAction | null>(null);

  const maxSteps  = PLAN_MAX_STEPS[plan]  ?? Infinity;

  // Sort order for system pipelines: Very Small → Small → Balanced → Big → Very Big
  const SYSTEM_SIZE_ORDER = ["very small", "small", "balanced", "big", "very big"];
  function sortSystemPipelines(list: Pipeline[]): Pipeline[] {
    return [...list].sort((a, b) => {
      const ai = SYSTEM_SIZE_ORDER.findIndex((k) => a.name.toLowerCase().includes(k));
      const bi = SYSTEM_SIZE_ORDER.findIndex((k) => b.name.toLowerCase().includes(k));
      if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  useEffect(() => {
    if (!tenantId || !session) return;
    fetch(`/api/pipelines?tenantId=${tenantId}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then(async (res) => {
        if (res.ok) {
          const body = await res.json() as {
            system: Pipeline[];
            custom: Pipeline[];
            installed?: Array<{
              install_id: string;
              listing_id: string;
              installed_at: string;
              broken: boolean;
              pipeline: Pipeline | null;
            }>;
          };
          // The Studio sidebar shows only what the tenant has actually
          // adopted. Three buckets:
          //  · own       — factory_id = active factoryId (created here
          //                or cloned into this factory)
          //  · inherited — factory_id ∈ inheritedFactoryIds (≠ active)
          //  · installed — refs from migration 171: canonical pipelines
          //                this tenant adopted via marketplace install.
          //                Read-only; operator removes via marketplace
          //                listing detail page (Uninstall button).
          // PIP RE pipeline + RE agents are inception machinery — they
          // belong under PIP Manager, not the generic Studio surface.
          // Filter by slug prefix `pip-` (mig 200 standardised the
          // naming). New PIP-related canonicals will inherit the same
          // prefix; this stays a one-line filter.
          const isPipPipeline = (p: Pipeline) => (p.slug ?? "").startsWith("pip-");
          const customs = body.custom.filter((p) => !isPipPipeline(p));
          const own = customs.filter((p) => {
            const pFid = (p as unknown as Record<string, unknown>).factory_id as string | null;
            return pFid === factoryId;
          });
          const inherited = customs.filter((p) => {
            const pFid = (p as unknown as Record<string, unknown>).factory_id as string | null;
            return pFid !== null && pFid !== factoryId && inheritedFactoryIds.includes(pFid);
          });
          // Tenant-level customs without factory binding (rare — clone
          // mode currently sets factory_id=null) folded into Installed
          // for visibility; broken refs (canonical deleted upstream)
          // get a placeholder row so the operator can clean them up.
          const installedPlaceholder: Pipeline = {
            id: "", slug: "(unknown)", name: "(broken reference)", description: null,
            type: "system", category: "", plan_required: "", steps: [], is_active: true,
            created_at: new Date(0).toISOString(),
          };
          const listingMap = new Map<string, string>();
          const installedRefs: Pipeline[] = (body.installed ?? [])
            .filter((r) => !(r.pipeline && isPipPipeline(r.pipeline)))
            .map((r) => {
              if (r.broken || !r.pipeline) {
                const placeholderId = r.install_id;
                listingMap.set(placeholderId, r.listing_id);
                return { ...installedPlaceholder, id: placeholderId, slug: `(broken:${r.listing_id.slice(0,8)})`, name: "(broken reference — uninstall to clean up)" };
              }
              listingMap.set(r.pipeline.id, r.listing_id);
              return r.pipeline;
            });
          const tenantOnly = customs.filter((p) => {
            const pFid = (p as unknown as Record<string, unknown>).factory_id as string | null;
            return pFid === null
              || (pFid !== factoryId && !inheritedFactoryIds.includes(pFid));
          });
          const installed = [...tenantOnly, ...installedRefs];
          setBuiltInPipelines(installed); // reused state slot, labelled "Installed" in the sidebar
          setInstalledListingMap(listingMap);
          setOwnPipelines(own); setInheritedPipelines(inherited);
          setSelected((prev) => prev ?? own[0] ?? inherited[0] ?? installed[0] ?? null);
        }
        setLoading(false);
      });
  }, [tenantId, session]);

  const q = search.toLowerCase();
  // mig 191 scope filter — render-time defense (mirrors AgentsTab).
  // factory rows / refs (project_id falsy) → show only when factoryInScope=true.
  // project-scoped rows → show only when their project is in selectedProjectIds.
  function inScope(p: Pipeline): boolean {
    if (!p.project_id) return factoryInScope;
    return scopedProjects.some((sp) => sp.id === p.project_id);
  }
  const filteredOwn = ownPipelines.filter(inScope).filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q));
  const filteredInherited = inheritedPipelines.filter(inScope).filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q));
  const filteredBuiltIn = builtInPipelines.filter(inScope).filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q));

  function toggleCollapse(key: string) {
    setCollapsed((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  function runPipeline(pipeline: Pipeline) {
    // Navigate to Projects page with this pipeline pre-selected
    window.location.href = `/projects?pipeline=${pipeline.id}&pipelineName=${encodeURIComponent(pipeline.name)}`;
  }

  /** Uninstall a marketplace pipeline ref. Different from deletePipeline —
   *  the canonical pipeline stays under the publisher; only the tenant's
   *  marketplace_installs row is dropped. */
  async function uninstallPipelineRef(pipeline: Pipeline, listingId: string) {
    if (!session) return;
    if (!confirm(`Uninstall "${pipeline.name}"? This removes the marketplace reference; the canonical pipeline stays available in the marketplace.`)) return;
    const res = await fetch("/api/marketplace/uninstall", {
      method:  "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ listingId, kind: "pipeline" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string; projects?: string[] };
      const detail = body.projects?.length ? ` Projects: ${body.projects.join(", ")}.` : "";
      alert(`Uninstall failed: ${body.error ?? res.status}${detail}`);
      return;
    }
    setBuiltInPipelines((prev) => prev.filter((p) => p.id !== pipeline.id));
    setInstalledListingMap((prev) => {
      const next = new Map(prev);
      next.delete(pipeline.id);
      return next;
    });
    if (selected?.id === pipeline.id) setSelected(null);
  }

  async function deletePipeline(pipeline: Pipeline) {
    if (!session) return;

    // Check for linked projects
    const { data: linkedProjects } = await supabase
      .from("projects").select("name").eq("pipeline_id", pipeline.id);

    // Check for active/queued sprints
    const { data: activeSprints } = await supabase
      .from("sprints").select("id")
      .eq("pipeline_id", pipeline.id)
      .in("status", ["queued", "running", "waiting"]);

    const warnings: string[] = [];
    if (linkedProjects?.length) {
      const names = linkedProjects.map((p) => `"${p.name as string}"`).join(", ");
      warnings.push(`${linkedProjects.length} project(s) are linked to this pipeline: ${names}. They will lose their pipeline reference (existing sprint snapshots remain).`);
    }

    const blocked = (activeSprints?.length ?? 0) > 0;

    if (!warnings.length && !blocked) {
      if (!confirm(`Delete pipeline "${pipeline.name}"?`)) return;
      await doDeletePipeline(pipeline.id);
      return;
    }

    setDangerModal({
      title: `Delete "${pipeline.name}"?`,
      warnings,
      blockMessage: blocked ? "This pipeline has active or queued sprints. Stop all runs before deleting." : undefined,
      onConfirm: async () => { await doDeletePipeline(pipeline.id); },
    });
  }

  async function doDeletePipeline(id: string) {
    await fetch(`/api/pipelines/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${session!.access_token}` } });
    setOwnPipelines((prev) => prev.filter((p) => p.id !== id));
    if (selected?.id === id) setSelected(ownPipelines[0] ?? null);
  }

  const stats = selected
    ? { steps: selected.steps.length, phases: [...new Set(selected.steps.map((s) => s.phase))].length }
    : null;

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* Left: list */}
      <div style={{ width: 250, minWidth: 250, background: "var(--crust)", borderRight: "1px solid var(--surface0)", display: (showNew || editingPipeline) ? "none" : "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "10px 10px 8px", borderBottom: "1px solid var(--surface0)" }}>
          <div style={{ position: "relative" }}>
            <Search size={13} color="var(--overlay0)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter pipelines…"
              style={{ ...inputStyle, padding: "7px 10px 7px 30px", fontSize: 12 }} />
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px" }}>
          {loading ? (
            <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--overlay0)" }}>Loading…</div>
          ) : (
            <>
              {/* Installed — pipelines the tenant adopted via marketplace.
                  Two flavours:
                   · refs (type='system') — canonical pipeline, read-only
                     here; uninstall in the marketplace listing detail.
                   · clones (type='custom') — copy in the tenant; editable. */}
              {filteredBuiltIn.length > 0 && (
                <>
                  <SectionHeader label={`Installed (${filteredBuiltIn.length})`} count={filteredBuiltIn.length} open={!collapsed.has("inst")} onToggle={() => toggleCollapse("inst")} />
                  {!collapsed.has("inst") && (
                    <div style={{ marginBottom: 12 }}>
                      {filteredBuiltIn.map((p) => {
                        const isRef     = p.type === "system";
                        const listingId = installedListingMap.get(p.id);
                        // Trash for refs uninstalls the marketplace ref;
                        // for clones it deletes the tenant row.
                        const onDelete = isRef
                          ? (listingId ? () => uninstallPipelineRef(p, listingId) : undefined)
                          : () => deletePipeline(p);
                        return (
                          <PipelineRow
                            key={p.id}
                            pipeline={p}
                            selected={selected?.id === p.id}
                            onClick={() => setSelected(p)}
                            onEdit={isRef ? undefined : () => setEditingPipeline(p)}
                            onDelete={onDelete}
                            builtIn={isRef}
                            factoryProjects={factoryProjects}
                          />
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* Inherited */}
              {filteredInherited.length > 0 && (
                <>
                  <SectionHeader label={`Inherited (${filteredInherited.length})`} count={filteredInherited.length} open={!collapsed.has("inh")} onToggle={() => toggleCollapse("inh")} />
                  {!collapsed.has("inh") && (
                    <div style={{ marginBottom: 12 }}>
                      {filteredInherited.map((p) => <PipelineRow key={p.id} pipeline={p} selected={selected?.id === p.id} onClick={() => setSelected(p)} factoryProjects={factoryProjects} />)}
                    </div>
                  )}
                </>
              )}

              {/* Own */}
              <SectionHeader label={factoryName ?? "Own"} count={filteredOwn.length} open={!collapsed.has("own")} onToggle={() => toggleCollapse("own")} />
              {!collapsed.has("own") && (
                <div style={{ marginBottom: 12 }}>
                  {filteredOwn.map((p) => <PipelineRow key={p.id} pipeline={p} selected={selected?.id === p.id} onClick={() => setSelected(p)} onEdit={() => setEditingPipeline(p)} onDelete={() => deletePipeline(p)} factoryProjects={factoryProjects} />)}
                  <button onClick={() => setShowNew(true)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, marginTop: 4, background: "transparent", border: "1px dashed var(--surface1)", cursor: "pointer", color: "var(--overlay0)", fontSize: 12, fontFamily: "var(--font-sans)" }}>
                    <Plus size={13} /> New pipeline
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, color: "var(--overlay0)" }}>Plan</span>
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99, textTransform: "uppercase", background: `${PLAN_COLOR[plan] ?? "#6b7a9e"}18`, color: PLAN_COLOR[plan] ?? "#6b7a9e" }}>{plan}</span>
        </div>
      </div>

      {/* Right: canvas or builder */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(showNew || editingPipeline) && tenantId ? (
        <PipelineBuilderModal
          key={editingPipeline?.id ?? "new"}
          maxSteps={maxSteps}
          tenantId={tenantId}
          plan={plan}
          factoryName={factoryName}
          factoryOrigin={factoryOrigin}
          factoryId={factoryId}
          factoryProjects={factoryProjects}
          pipeline={editingPipeline ?? undefined}
          onClose={() => { setShowNew(false); setEditingPipeline(null); }}
          onCreated={(p) => {
            setOwnPipelines((prev) => [...prev, p]);
            setSelected(p);
            setShowNew(false);
          }}
          onUpdated={(p) => {
            setOwnPipelines((prev) => prev.map((c) => c.id === p.id ? p : c));
            setSelected(p);
            setEditingPipeline(null);
          }}
        />
      ) : (
      <>
        <div style={{ height: 50, borderBottom: "1px solid var(--surface0)", background: "var(--mantle)", display: "flex", alignItems: "center", padding: "0 18px", gap: 12, flexShrink: 0 }}>
          {selected && !(hideBuiltIn && selected.type === "system") ? (
            <>
              <div style={{ minWidth: 0, flex: "0 1 auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{selected.name}</span>
                  {/* mig 191 — PROJ badge in detail header to mirror
                      the row badge so the operator sees scope on both
                      list and canvas. */}
                  {selected.project_id && (() => {
                    const proj = factoryProjects.find((p) => p.id === selected.project_id);
                    return (
                      <span title={proj ? `Project-scoped to ${proj.name}` : "Project-scoped"} style={{
                        fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                        background: "rgba(203,166,247,0.14)", color: "var(--mauve)",
                        textTransform: "uppercase", letterSpacing: "0.06em",
                      }}>PROJ</span>
                    );
                  })()}
                </div>
                {selected.description && (
                  <div
                    title={selected.description}
                    style={{
                      fontSize: 11, color: "var(--subtext0)", marginTop: 1,
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                      maxWidth: 540,
                    }}
                  >
                    {selected.description.split(/\n+/)[0]}
                  </div>
                )}
              </div>
              {stats && (
                <div style={{ display: "flex", gap: 14, marginLeft: 8 }}>
                  {[{ label: "steps", value: stats.steps }, { label: "phases", value: stats.phases }].map(({ label, value }) => (
                    <div key={label} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 14, fontWeight: 800, lineHeight: 1 }}>{value}</div>
                      <div style={{ fontSize: 10, color: "var(--overlay0)" }}>{label}</div>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ flex: 1 }} />
              {selected.type === "custom" && (
                <button onClick={() => setEditingPipeline(selected)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                  <Pencil size={12} /> Edit
                </button>
              )}
              <button onClick={() => runPipeline(selected)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 14px", borderRadius: 8, border: "none", background: "#1463ff", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                <Play size={12} /> Use pipeline
              </button>
            </>
          ) : <span style={{ fontSize: 13, color: "var(--overlay0)" }}>Select a pipeline</span>}
        </div>

        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            <defs><pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M 28 0 L 0 0 0 28" fill="none" stroke="var(--surface0)" strokeWidth="0.5" /></pattern></defs>
            <rect width="100%" height="100%" fill="url(#grid)" />
          </svg>
          <div style={{ position: "relative", zIndex: 1, height: "100%" }}>
            {hideBuiltIn && selected?.type === "system"
              ? null
              : <PipelineCanvas steps={selected?.steps ?? []} />}
          </div>
        </div>
      </>
      )}
      </div>

      {dangerModal && <DangerModal action={dangerModal} onClose={() => setDangerModal(null)} />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   AGENTS TAB
═══════════════════════════════════════════════════════════════════════════ */

/** Group rows by squad tag. Pure transform — no parent-state closure. */
function groupBySquad(list: AgentRow[]): Array<{ slug: string; name: string; agents: AgentRow[] }> {
  const squadMap = new Map<string, { name: string; agents: AgentRow[] }>();
  for (const a of list) {
    const key = a.squad ?? "__ungrouped__";
    if (!squadMap.has(key)) squadMap.set(key, { name: a.squad ?? "Standalone", agents: [] });
    squadMap.get(key)!.agents.push(a);
  }
  return [...squadMap.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([slug, s]) => ({ slug, ...s }));
}

/** Handlers + auxiliary state AgentCard / AgentGrid need to render. Bundled
 *  to keep prop lists short — the alternative is 8 individual props. */
interface AgentActions {
  factoryProjects: { id: string; name: string; slug: string }[];
  toggling:        Set<string>;
  onEdit:          (agent: AgentRow) => void;
  onClone:         (agent: AgentRow) => void;
  onExport:        (agent: AgentRow) => void;
  onDelete:        (agent: AgentRow) => void;
  onUninstallRef:  (agent: AgentRow, listingId: string) => void;
  onToggle:        (agent: AgentRow) => void;
}

function AgentCard({ agent, color, actions }: { agent: AgentRow; color: string; actions: AgentActions }) {
  const icon = agent.icon ?? (agent.metadata as Record<string, unknown>)?.icon as string | undefined;
  const imported = !!agent.origin_id;
  // Marketplace ref — set by AgentsTab when merging /api/marketplace/installed-agents
  // results. Read-only here; uninstall in the marketplace listing detail.
  const refMeta = (agent.metadata as Record<string, unknown> | null)?.__ref as
    { source: "agent" | "pipeline"; listing_id: string | null; install_id: string | null; broken: boolean } | undefined;
  const isRef = !!refMeta;
  const refBroken = !!refMeta?.broken;
  const sourceOrigin = (agent.metadata as Record<string, unknown>)?.source_origin as string | undefined;
  return (
    <div style={{
      background: refBroken ? "rgba(228,75,95,0.05)" : isRef ? "rgba(20,99,255,0.04)" : imported ? "rgba(124,92,252,0.04)" : "var(--surface0)",
      border: `1px solid ${refBroken ? "rgba(228,75,95,0.35)" : isRef ? "rgba(20,99,255,0.3)" : imported ? "rgba(124,92,252,0.25)" : "var(--surface1)"}`,
      borderRadius: 10, padding: "12px 14px",
      opacity: agent.enabled ? 1 : 0.55, transition: "opacity 0.15s",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flex: 1, minWidth: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: `${color}18`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: icon ? 16 : 14 }}>
            {icon ?? <Bot size={14} color={color} strokeWidth={1.5} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 1 }}>
              <span style={{ fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>{agent.name}</span>
              {agent.project_id && (() => {
                const proj = actions.factoryProjects.find((p) => p.id === agent.project_id);
                return (
                  <span title={proj ? `Project-scoped to ${proj.name}` : "Project-scoped"} style={{
                    fontSize: 8, fontWeight: 700, padding: "1px 4px", borderRadius: 3,
                    background: "rgba(203,166,247,0.14)", color: "var(--mauve)",
                    textTransform: "uppercase", letterSpacing: "0.04em", flexShrink: 0,
                  }}>
                    PROJ
                  </span>
                );
              })()}
            </div>
            <code style={{ fontSize: 10, color: "var(--overlay0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", maxWidth: 140 }}>{agent.slug}</code>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
          {(imported || isRef) ? (
            <button onClick={() => actions.onEdit(agent)} title={isRef ? "View (installed reference — clone to edit)" : "View (imported — clone to edit)"} style={{ background: "transparent", border: "none", cursor: "pointer", color: isRef ? "var(--blue)" : "var(--mauve)", padding: 2, display: "inline-flex", alignItems: "center" }}><Eye size={12} /></button>
          ) : (
            <button onClick={() => actions.onEdit(agent)} title="Edit" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "inline-flex", alignItems: "center" }}><Pencil size={12} /></button>
          )}
          <button onClick={() => actions.onClone(agent)} title={isRef ? "Clone — copy this canonical into your factory so you can edit it" : imported ? "Clone to edit" : "Clone"} style={{ background: "transparent", border: "none", cursor: "pointer", color: (imported || isRef) ? "var(--blue)" : "var(--overlay0)", padding: 2 }}><Copy size={11} /></button>
          <button onClick={() => actions.onExport(agent)} title="Export YAML" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2 }}><Download size={11} /></button>
          {!isRef && (
            <button onClick={() => actions.onDelete(agent)} title="Delete" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2 }}><Trash2 size={11} /></button>
          )}
          {isRef && (refMeta!.source === "agent" || refBroken) && refMeta!.listing_id && (
            <button
              onClick={() => actions.onUninstallRef(agent, refMeta!.listing_id as string)}
              title={refBroken ? "Uninstall — removes the broken reference" : "Uninstall — removes the marketplace install reference"}
              style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2 }}
            >
              <Trash2 size={11} />
            </button>
          )}
          {!isRef && (
            <button onClick={() => actions.onToggle(agent)} disabled={actions.toggling.has(agent.id)} style={{ background: "transparent", border: "none", cursor: "pointer", padding: 2, opacity: actions.toggling.has(agent.id) ? 0.4 : 1 }}>
              {agent.enabled ? <ToggleRight size={20} color="var(--green)" /> : <ToggleLeft size={20} color="var(--overlay0)" />}
            </button>
          )}
        </div>
      </div>
      {imported && sourceOrigin && !isRef && (
        <div style={{ marginTop: 8, fontSize: 10, color: "var(--mauve)", display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 9 }}>Imported</span>
          <span style={{ color: "var(--overlay1)", fontFamily: "var(--font-mono)" }}>{sourceOrigin}</span>
        </div>
      )}
      {isRef && (
        <div style={{ marginTop: 8, fontSize: 10, color: refBroken ? "var(--red)" : "var(--blue)", display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 9 }}>
            {refBroken ? "Broken ref" : refMeta!.source === "agent" ? "Installed" : "Via pipeline"}
          </span>
          <span style={{ color: "var(--overlay1)", fontFamily: "var(--font-mono)" }}>
            {refBroken
              ? "uninstall to clean up"
              : refMeta!.source === "agent"
              ? "marketplace ref"
              : "from installed pipeline"}
          </span>
        </div>
      )}
    </div>
  );
}

function AgentGrid({
  list,
  expandedParents,
  toggleParent,
  actions,
}: {
  list:            AgentRow[];
  expandedParents: Set<string>;
  toggleParent:    (slug: string) => void;
  actions:         AgentActions;
}) {
  if (list.length === 0) return <div style={{ padding: "8px 0 14px", fontSize: 12, color: "var(--overlay0)" }}>No agents found.</div>;
  return (
    <>
      {groupBySquad(list).map((squad) => {
        const color = SQUAD_COLORS[squad.slug] ?? "var(--overlay1)";
        const specialists    = squad.agents.filter((a) => a.level !== "super-specialist");
        const superSpecs     = squad.agents.filter((a) => a.level === "super-specialist");
        const orphanedSuper  = superSpecs.filter((ss) => !specialists.find((sp) => sp.slug === ss.parent_slug));
        const allPrimary     = [...specialists, ...orphanedSuper];

        return (
          <div key={squad.slug} style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ width: 3, height: 14, borderRadius: 2, background: color }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--subtext1)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{squad.name}</span>
              <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{squad.agents.length}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
              {allPrimary.map((agent) => {
                const children = superSpecs.filter((ss) => ss.parent_slug === agent.slug);
                const expanded = expandedParents.has(agent.slug);
                return (
                  <div key={agent.id}>
                    <AgentCard agent={agent} color={color} actions={actions} />
                    {children.length > 0 && (
                      <>
                        <button
                          onClick={() => toggleParent(agent.slug)}
                          style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, marginLeft: 4, background: "transparent", border: "none", cursor: "pointer", fontSize: 10, color: "var(--overlay1)", fontFamily: "var(--font-sans)", padding: "2px 0" }}
                        >
                          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          {children.length} sub-specialist{children.length > 1 ? "s" : ""}
                        </button>
                        {expanded && (
                          <div style={{ marginTop: 4, marginLeft: 8, display: "flex", flexDirection: "column", gap: 3, borderLeft: `2px solid ${color}40`, paddingLeft: 8 }}>
                            {children.map((child) => (
                              <AgentCard key={child.id} agent={child} color={color} actions={actions} />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

function AgentsTab({ userRole, hideBuiltIn, tenantId, factoryName, factoryOrigin, factoryId, inheritedFactoryIds, scopedProjects, factoryProjects, factoryInScope }: { userRole: UserRole; hideBuiltIn: boolean; tenantId: string | null; factoryName: string | null; factoryOrigin: string; factoryId: string | null; inheritedFactoryIds: string[]; scopedProjects: { id: string; name: string; slug: string }[]; factoryProjects: { id: string; name: string; slug: string }[]; factoryInScope: boolean }) {
  const { session } = useAuth();
  const [agents,    setAgents]    = useState<AgentRow[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [toggling,  setToggling]  = useState<Set<string>>(new Set());
  // contract modal removed
  const [showNew,   setShowNew]   = useState(false);
  const [editAgent, setEditAgent] = useState<AgentRow | null>(null);
  // squads are now a TEXT field on agent_definitions — no separate table
  const [newForm,        setNewForm]        = useState({ name: "", slug: "", squad: "", level: "" as AgentLevel | "", persona: "", icon: "", version: "1.0.0", tags: "" });
  /** Save scope picker (mig 191): null = factory-scope (default);
   *  string = project-scope (writes project_id). Only enabled when
   *  the operator widened scope via the Studio header. */
  const [saveProjectId, setSaveProjectId] = useState<string | null>(null);
  const [showIconPicker, setShowIconPicker] = useState(false);
  // SIPOC form state removed — SIPOC contracts live in pipelines
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<{ slug: string; name: string; description: string | null }[]>([]);
  const [saving,      setSaving]      = useState(false);
  const [formError,   setFormError]   = useState<string | null>(null);
  const [dangerModal, setDangerModal] = useState<DangerAction | null>(null);
  // Expanded super-specialist groups in AgentGrid. Lifted out of the
  // nested component so siblings re-rendering the tab don't reset the
  // user's expansion state (was a real bug — useState lived inside
  // AgentGrid which gets a new identity on every AgentsTab render).
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const toggleParent = (slug: string) =>
    setExpandedParents((prev) => {
      const n = new Set(prev);
      if (n.has(slug)) n.delete(slug); else n.add(slug);
      return n;
    });

  useEffect(() => {
    if (!tenantId) return;
    // Studio Agents view shows everything the tenant has actually
    // adopted: tenant-owned agents (created or cloned) plus canonical
    // agents the tenant installed (refs from migration 171). Canonicals
    // can come in two flavours: directly installed (kind='agent' ref)
    // or pipeline-derived (the agents a ref-installed pipeline uses).
    // We mark refs with agent.metadata.__ref so AgentCard can render
    // the read-only treatment.
    // mig 191 scope picker:
    //   factoryInScope=true  → fetch factory rows + canonical refs
    //   factoryInScope=false → skip both (operator wants project-only view)
    //   scopedProjects.length>0 → fetch project rows for those projects
    // Each query is conditional so we don't pull rows the render filter
    // would discard anyway.
    const factoryQuery = factoryInScope
      ? supabase.from("agent_definitions")
          .select("id, slug, name, level, enabled, origin, origin_id, parent_slug, metadata, tenant_id, factory_id, project_id, squad, spec, version, icon, tags")
          .eq("tenant_id", tenantId)
          .is("project_id", null)
          .order("name")
      : Promise.resolve({ data: [] as never[] });
    const projectIds = scopedProjects.map((p) => p.id);
    const projectQuery = projectIds.length > 0
      ? supabase.from("agent_definitions")
          .select("id, slug, name, level, enabled, origin, origin_id, parent_slug, metadata, tenant_id, factory_id, project_id, squad, spec, version, icon, tags")
          .in("project_id", projectIds)
          .order("name")
      : Promise.resolve({ data: [] as never[] });
    const refsFetch = factoryInScope && session
      ? fetch(`/api/marketplace/installed-agents?tenantId=${tenantId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        }).then((r) => r.ok ? r.json() : { agents: [] })
      : Promise.resolve({ agents: [] });
    Promise.all([factoryQuery, projectQuery, refsFetch]).then(([factRes, projRes, refsRes]) => {
      // PIP RE agents (squad starts with `pip-` per mig 200) belong
      // under PIP Manager, not the Studio Agents view. Filter both
      // own rows and pipeline-derived refs by the same predicate so
      // the Internals tab in PIP Manager owns them exclusively.
      const isPipAgent = (slug: string | null | undefined, squad: string | null | undefined) =>
        (squad ?? "").startsWith("pip-") || (slug ?? "").startsWith("pip-");
      const factOwn = ((factRes.data ?? []) as unknown as AgentRow[])
        .filter((a) => !isPipAgent(a.slug, a.squad));
      const projOwn = ((projRes.data ?? []) as unknown as AgentRow[])
        .filter((a) => !isPipAgent(a.slug, a.squad));
      const own = [...factOwn, ...projOwn];
      const refs = ((refsRes as { agents?: Array<Record<string, unknown>> }).agents ?? [])
        .filter((a) => !isPipAgent(a.slug as string | undefined, a.squad as string | undefined))
        .map((a) => ({
          ...a,
          metadata: { ...(a.metadata as Record<string, unknown> | null ?? {}), __ref: { source: a.source, listing_id: a.listing_id, install_id: a.install_id, broken: a.broken } },
        })) as unknown as AgentRow[];
      const ownIds = new Set(own.map((a) => a.id));
      const merged = [...own, ...refs.filter((a) => !ownIds.has(a.id))];
      setAgents(merged);
      setLoading(false);
    }).catch(() => setLoading(false));
    // Derive squad list from agent data (squad is now a TEXT field, not a FK)
    // Populated after agents load
    const EXCLUDED_DEFAULTS = ["escalate_to_human", "github_push_sprint"];
    supabase.from("tools").select("slug, name, description").eq("status", "available").order("name")
      .then(({ data }) => {
        if (data) {
          const tools = data as { slug: string; name: string; description: string | null }[];
          setAvailableTools(tools);
          // Default: all selected except excluded
          if (!editAgent) setSelectedTools(tools.map((t) => t.slug).filter((s) => !EXCLUDED_DEFAULTS.includes(s)));
        }
      });
    // Refetches when scope changes (mig 191): operator widening or
    // narrowing project scope re-queries to include / drop project-
    // scoped rows. Joining the projectIds into a stable string keeps
    // the dep array stable across renders. Also re-runs when the
    // factoryInScope toggle flips (factory rows + refs included or
    // excluded accordingly).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedProjects.map((p) => p.id).sort().join(","), factoryInScope]);

  async function toggleAgent(agent: AgentRow) {
    if (toggling.has(agent.id)) return;
    // Warn when disabling a custom agent that's referenced in a pipeline
    if (agent.enabled) {
      const { data: pipelines } = await supabase
        .from("pipelines").select("name")
        .eq("tenant_id", tenantId)
        .contains("steps", [{ agent: agent.slug }]);
      if (pipelines?.length) {
        const names = pipelines.map((p) => `"${p.name as string}"`).join(", ");
        if (!confirm(`"${agent.name}" is used in pipeline(s): ${names}. Disabling it will cause those steps to fail at runtime. Continue?`)) return;
      }
    }
    const newEnabled = !agent.enabled;
    setToggling((s) => new Set(s).add(agent.id));
    setAgents((prev) => prev.map((a) => a.id === agent.id ? { ...a, enabled: newEnabled } : a));
    await supabase.from("agent_definitions").update({ enabled: newEnabled }).eq("id", agent.id);
    setToggling((s) => { const n = new Set(s); n.delete(agent.id); return n; });
  }

  function resetForm() {
    setNewForm({ name: "", slug: "", squad: "", level: "", persona: "", icon: "", version: "1.0.0", tags: "" });
    setShowIconPicker(false);
    // mig 191: reset save scope to factory (default).
    setSaveProjectId(null);
    // Default tools = all available except platform-only escalation paths.
    // Empty default would create agents that can't write any artifact —
    // the sprint runs but produces zero output. Mirror the mount-time default.
    const EXCLUDED_DEFAULTS = ["escalate_to_human", "github_push_sprint"];
    setSelectedTools(availableTools.map((t) => t.slug).filter((s) => !EXCLUDED_DEFAULTS.includes(s)));
    setFormError(null);
  }

  function openNewModal() { resetForm(); setEditAgent(null); setShowNew(true); }

  function openEditModal(agent: AgentRow) {
    const meta = agent.metadata ?? {};
    const spec = agent.spec ?? {};
    setNewForm({
      name: agent.name, slug: agent.slug,
      squad: agent.squad ?? "",
      level: agent.level ?? "",
      persona: String(spec.description ?? spec.process ?? spec.freestyle_process ?? meta.instructions ?? ""),
      icon: String(agent.icon ?? meta.icon ?? ""),
      version: agent.version ?? "1.0.0",
      tags: Array.isArray(agent.tags) ? agent.tags.join(", ") : "",
    });
    const tools = Array.isArray(spec.tools) ? (spec.tools as string[]) : [];
    setSelectedTools(tools);
    setEditAgent(agent);
    // mig 191: load the existing scope so the picker reflects current state.
    setSaveProjectId((agent as AgentRow & { project_id?: string | null }).project_id ?? null);
    setShowNew(true);
  }

  async function saveAgent() {
    if (!newForm.name.trim() || !newForm.slug.trim()) { setFormError("Name and slug are required."); return; }

    const metadata: Record<string, unknown> = { ...(editAgent?.metadata ?? {}) };
    const prevSpec = (editAgent?.spec as Record<string, unknown> | null) ?? {};

    // Build spec — new schema edits persona + tools; legacy fields preserved.
    const specPayload: Record<string, unknown> = {
      ...prevSpec,
      description: newForm.persona || "",
      tools: selectedTools,
    };

    const tagsArr = newForm.tags.split(",").map((t) => t.trim()).filter(Boolean);

    setSaving(true); setFormError(null);
    const payload = {
      squad: newForm.squad.trim() || null,
      slug: newForm.slug,
      name: newForm.name,
      icon: newForm.icon || null,
      level: newForm.level || null,
      version: newForm.version.trim() || "1.0.0",
      tags: tagsArr,
      // parent_slug preserved on update (column kept for backward compat); null on create
      parent_slug: editAgent ? editAgent.parent_slug : null,
      metadata,
      spec: specPayload,
    };
    if (editAgent) {
      // mig 191: existing rows can move scope (factory ↔ project) on
      // edit. We send project_id explicitly so an operator who saved
      // a project-scoped row by mistake can move it back to factory.
      const { error } = await supabase.from("agent_definitions")
        .update({ ...payload, project_id: saveProjectId })
        .eq("id", editAgent.id);
      setSaving(false);
      if (error) { setFormError(error.message); return; }
      setAgents((prev) => prev.map((a) => a.id === editAgent.id ? { ...a, ...payload, project_id: saveProjectId } as unknown as AgentRow : a));
    } else {
      const { data, error } = await supabase.from("agent_definitions")
        .insert({ ...payload, origin: "user", enabled: true, tenant_id: tenantId, factory_id: factoryId, project_id: saveProjectId })
        .select("id, slug, name, level, enabled, origin, origin_id, parent_slug, metadata, squad, spec, version, tenant_id, factory_id, project_id, icon, tags")
        .single();
      setSaving(false);
      if (error) { setFormError(error.message); return; }
      setAgents((prev) => [...prev, data as unknown as AgentRow]);
    }
    setShowNew(false); setEditAgent(null); resetForm();
  }

  async function deleteAgent(agent: AgentRow) {
    // Check if agent slug is referenced in any pipeline steps
    const { data: pipelines } = await supabase
      .from("pipelines").select("name")
      .contains("steps", [{ agent: agent.slug }]);

    if (!pipelines?.length) {
      if (!confirm(`Delete "${agent.name}"?`)) return;
      await supabase.from("agent_definitions").delete().eq("id", agent.id);
      setAgents((prev) => prev.filter((a) => a.id !== agent.id));
      return;
    }

    const names = pipelines.map((p) => `"${p.name as string}"`).join(", ");
    setDangerModal({
      title: `Delete "${agent.name}"?`,
      warnings: [
        `This agent is referenced in ${pipelines.length} pipeline(s): ${names}.`,
        "Deleting it will cause those pipeline steps to fail with a contract error at runtime.",
      ],
      onConfirm: async () => {
        await supabase.from("agent_definitions").delete().eq("id", agent.id);
        setAgents((prev) => prev.filter((a) => a.id !== agent.id));
      },
    });
  }

  /** Uninstall a marketplace agent ref. Different from deleteAgent —
   *  the canonical agent stays under the publisher; only the tenant's
   *  marketplace_installs row is dropped. */
  async function uninstallAgentRef(agent: AgentRow, listingId: string) {
    if (!confirm(`Uninstall "${agent.name}"? This removes the marketplace reference; the canonical agent stays available in the marketplace.`)) return;
    if (!session) return;
    const res = await fetch("/api/marketplace/uninstall", {
      method:  "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ listingId, kind: "agent" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      alert(`Uninstall failed: ${body.error ?? res.status}`);
      return;
    }
    setAgents((prev) => prev.filter((a) => a.id !== agent.id));
  }

  // ── Squad visibility (persisted to factory config) ──
  const [hiddenSquads, setHiddenSquads] = useState<Set<string>>(new Set());
  const [hideInstalled, setHideInstalled] = useState(false);
  // Squads derived from filtered agents. Refs (canonical agents the
  // tenant ref-installed) live under the publisher's factory_id, NOT
  // the operator's — they're scoped at the tenant level via the
  // marketplace_installs ledger and bypass the factory filter so they
  // show up alongside own/cloned agents.
  const isRefAgent = (a: AgentRow): boolean => {
    const meta = a.metadata as Record<string, unknown> | null;
    return !!(meta && meta.__ref);
  };
  const scopedAgents = agents.filter((a) => {
    if (isRefAgent(a)) return true;
    const fid = a.factory_id;
    if (!fid) return false;
    return fid === factoryId || inheritedFactoryIds.includes(fid);
  });
  const hasUngrouped = scopedAgents.some((a) => !a.squad);
  const allSquads = [
    ...new Set(scopedAgents.map((a) => a.squad).filter(Boolean)),
    ...(hasUngrouped ? ["__ungrouped__"] : []),
  ].sort() as string[];

  useEffect(() => {
    if (!factoryId) return;
    supabase.from("factories").select("config").eq("id", factoryId).single()
      .then(({ data }) => {
        const cfg = data?.config as Record<string, unknown> | null;
        const hidden = cfg?.hidden_squads;
        if (Array.isArray(hidden)) setHiddenSquads(new Set(hidden as string[]));
      });
  }, [factoryId]);

  async function toggleSquadVisibility(squad: string) {
    const next = new Set(hiddenSquads);
    if (next.has(squad)) next.delete(squad); else next.add(squad);
    setHiddenSquads(next);
    if (!factoryId) return;
    const { data } = await supabase.from("factories").select("config").eq("id", factoryId).single();
    const cfg = (data?.config as Record<string, unknown>) ?? {};
    await supabase.from("factories").update({ config: { ...cfg, hidden_squads: [...next] } }).eq("id", factoryId);
  }

  const q = search.toLowerCase();
  const filtered = agents
    .filter((a) => {
      if (isRefAgent(a)) return true;
      const fid = a.factory_id;
      if (!fid) return false;
      return fid === factoryId || inheritedFactoryIds.includes(fid);
    })
    .filter((a) => {
      // mig 191 scope filter — render-time defense so newly-saved rows
      // and refs respect the operator's current scope without waiting
      // for a refetch.
      //   factory rows / refs (project_id falsy) → show only when
      //     factoryInScope=true
      //   project-scoped rows → show only when their project is in
      //     selectedProjectIds
      if (!a.project_id) return factoryInScope;
      return scopedProjects.some((p) => p.id === a.project_id);
    })
    .filter((a) => !hiddenSquads.has(a.squad ?? "__ungrouped__"))
    .filter((a) => !hideInstalled || !(a.origin_id || isRefAgent(a)))
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.slug.includes(q) || (a.squad ?? "").toLowerCase().includes(q));
  const installedCount = agents.filter((a) => {
    if (isRefAgent(a)) return true;
    const fid = a.factory_id;
    if (!fid) return false;
    return (fid === factoryId || inheritedFactoryIds.includes(fid)) && !!a.origin_id;
  }).length;

  function toggleCollapse(key: string) {
    setCollapsed((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  // ── Import YAML state ──
  const [showImport, setShowImport] = useState(false);
  const [importYaml, setImportYaml] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importSaving, setImportSaving] = useState(false);

  async function cloneAgent(agent: AgentRow) {
    const newSlug = `${agent.slug}-copy`;
    const newName = `${agent.name} (Copy)`;
    // Strip marketplace-origin metadata so the clone behaves as a fresh user agent
    const cleanMeta = { ...(agent.metadata ?? {}) } as Record<string, unknown>;
    delete cleanMeta.source_origin;
    delete cleanMeta.imported_from;
    delete cleanMeta.missing_tools;
    const { error } = await supabase.from("agent_definitions").insert({
      slug: newSlug, name: newName, squad: agent.squad,
      level: agent.level, parent_slug: agent.parent_slug,
      metadata: cleanMeta, spec: agent.spec, icon: agent.icon, tags: agent.tags,
      origin: "user", enabled: true, tenant_id: tenantId, factory_id: factoryId,
      origin_id: null, version: agent.version,
    }).select("id, slug, name, level, enabled, origin, origin_id, parent_slug, metadata, squad, spec, version, tenant_id, factory_id, icon, tags").single();
    if (error) { alert(`Clone failed: ${error.message}`); return; }
    // Reload tenant-scoped — Studio Agents view stays restricted to
    // agents the tenant has actually adopted.
    const { data } = await supabase.from("agent_definitions")
      .select("id, slug, name, level, enabled, origin, origin_id, parent_slug, metadata, tenant_id, factory_id, squad, spec, version, icon, tags")
      .eq("tenant_id", tenantId)
      .order("name");
    if (data) setAgents(data as unknown as AgentRow[]);
  }

  function exportYaml(agent: AgentRow) {
    const spec = agent.spec ?? {};
    const autonomy = (spec.autonomy as string) ?? "auto";
    const lines: string[] = [
      `slug: ${agent.slug}`,
      `name: "${agent.name}"`,
      `version: "${agent.version ?? "1.0.0"}"`,
      `squad: ${agent.squad ?? "null"}`,
      `level: ${agent.level ?? "null"}`,
      `autonomy: ${autonomy}`,
    ];
    if (agent.icon) lines.push(`icon: "${agent.icon}"`);
    if (spec.description) lines.push("", "description: |", ...String(spec.description).split("\n").map((l) => `  ${l}`));
    if (Array.isArray(spec.output_types) && (spec.output_types as unknown[]).length) lines.push("", "output_types:", ...(spec.output_types as string[]).map((t) => `  - "${t}"`));
    if (Array.isArray(spec.suggested_inputs) && (spec.suggested_inputs as unknown[]).length) lines.push("", "suggested_inputs:", ...(spec.suggested_inputs as string[]).map((t) => `  - "${t}"`));
    if (Array.isArray(spec.tools) && (spec.tools as unknown[]).length) lines.push("", "tools:", ...(spec.tools as string[]).map((t) => `  - ${t}`));
    if (spec.human_gate_reason) lines.push("", `human_gate_reason: "${spec.human_gate_reason}"`);
    if (spec.sla) lines.push(`sla: "${spec.sla}"`);
    if (spec.guardrails) lines.push("", "guardrails: |", ...String(spec.guardrails).split("\n").map((l) => `  ${l}`));
    if (spec.accept_external_instructions === false) lines.push("", "accept_external_instructions: false");
    if (spec.model_preference) lines.push(`model_preference: "${spec.model_preference}"`);
    if ((spec.max_rounds as number) > 0) lines.push(`max_rounds: ${spec.max_rounds}`);
    const yaml = lines.join("\n");
    const blob = new Blob([yaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${agent.slug}.yaml`; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportYaml() {
    if (!importYaml.trim()) { setImportError("Paste or upload a YAML file."); return; }
    setImportSaving(true); setImportError(null);
    try {
      // Parse YAML client-side using simple key extraction
      const lines = importYaml.split("\n");
      const get = (key: string): string | null => {
        const line = lines.find((l) => l.startsWith(`${key}:`));
        if (!line) return null;
        return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
      };
      const slug = get("slug");
      const name = get("name");
      if (!slug || !name) { setImportError("YAML must have slug and name fields."); setImportSaving(false); return; }

      // Send full YAML to server for proper parsing
      const res = await fetch("/api/agents/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ tenantId, factoryId, yaml: importYaml }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) { setImportError(body.error ?? "Import failed"); setImportSaving(false); return; }

      // Reload tenant-scoped.
      const { data } = await supabase.from("agent_definitions")
        .select("id, slug, name, level, enabled, origin, origin_id, parent_slug, metadata, tenant_id, factory_id, squad, spec, version, icon, tags")
        .eq("tenant_id", tenantId)
        .order("name");
      if (data) setAgents(data as unknown as AgentRow[]);
      setShowImport(false); setImportYaml(""); setImportError(null);
    } catch (e: unknown) {
      setImportError((e as Error).message);
    }
    setImportSaving(false);
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImportYaml(reader.result as string);
    reader.readAsText(file);
  }

  // Bundle handler closures so AgentCard / AgentGrid (now module-scoped)
  // get them via a single prop instead of 8 individual ones.
  const agentActions: AgentActions = {
    factoryProjects,
    toggling,
    onEdit:         openEditModal,
    onClone:        cloneAgent,
    onExport:       exportYaml,
    onDelete:       deleteAgent,
    onUninstallRef: uninstallAgentRef,
    onToggle:       toggleAgent,
  };

  const visibleCount = filtered.length;
  const enabledCount = filtered.filter((a) => a.enabled).length;

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* Left: Agent list */}
      <div style={{ flex: 1, overflowY: "auto", display: showNew ? "none" : "block" }}>
      <div style={{ maxWidth: 920, margin: "0 auto", padding: "28px 24px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Agents</h2>
            <p style={{ fontSize: 13, color: "var(--subtext0)" }}>{loading ? "Loading…" : `${visibleCount} agents · ${enabledCount} enabled`}</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <SearchBox value={search} onChange={setSearch} placeholder="Filter agents…" />
            {installedCount > 0 && (
              <button
                onClick={() => setHideInstalled((v) => !v)}
                title={hideInstalled ? "Show agents installed from Marketplace" : "Hide agents installed from Marketplace"}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 12px", borderRadius: 9,
                  border: `1px solid ${hideInstalled ? "rgba(124,92,252,0.4)" : "var(--surface1)"}`,
                  background: hideInstalled ? "rgba(124,92,252,0.08)" : "var(--surface0)",
                  color: hideInstalled ? "var(--mauve)" : "var(--subtext0)",
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                  fontFamily: "var(--font-sans)", whiteSpace: "nowrap",
                }}
              >
                {hideInstalled ? "Show installed" : "Hide installed"} ({installedCount})
              </button>
            )}
            <button onClick={() => setShowImport(true)} style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 16px", borderRadius: 9, border: "1px solid var(--surface1)", background: "var(--surface0)", color: "var(--text)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", whiteSpace: "nowrap" }}>
              <Upload size={14} /> Import YAML
            </button>
            <button onClick={openNewModal} style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 16px", borderRadius: 9, border: "none", background: "#1463ff", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)", whiteSpace: "nowrap" }}>
              <Plus size={14} /> New agent
            </button>
          </div>
        </div>

        {!loading && (
          <div style={{ display: "flex", gap: 20, marginBottom: 24, padding: "12px 18px", background: "var(--surface0)", border: "1px solid var(--surface1)", borderRadius: 10 }}>
            {[
              { label: "Total", value: filtered.length },
              { label: "Enabled", value: filtered.filter((a) => a.enabled).length, color: "var(--green)" },
              { label: "Disabled", value: filtered.filter((a) => !a.enabled).length, color: "var(--yellow)" },
              { label: "Squads", value: new Set(filtered.map((a) => a.squad).filter(Boolean)).size, color: "var(--blue)" },
            ].map((s) => (
              <div key={s.label}>
                <div style={{ fontSize: 18, fontWeight: 700, color: (s as { color?: string }).color ?? "var(--text)" }}>{s.value}</div>
                <div style={{ fontSize: 11, color: "var(--subtext0)" }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Squad visibility */}
        {!loading && allSquads.length > 0 && (
          <div style={{ marginBottom: 16, padding: "10px 14px", background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Squads</span>
              <button onClick={() => setHiddenSquads(new Set())} style={{ fontSize: 9, fontWeight: 600, color: "var(--blue)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", padding: 0 }}>All</button>
              <button onClick={() => setHiddenSquads(new Set(allSquads))} style={{ fontSize: 9, fontWeight: 600, color: "var(--overlay0)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", padding: 0 }}>None</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {allSquads.map((squad) => {
                const visible = !hiddenSquads.has(squad);
                const isUngrouped = squad === "__ungrouped__";
                const count = scopedAgents.filter((a) => isUngrouped ? !a.squad : a.squad === squad).length;
                const color = isUngrouped ? "var(--overlay0)" : (SQUAD_COLORS[squad] ?? "var(--overlay1)");
                const label = isUngrouped ? "Standalone" : squad;
                return (
                  <button
                    key={squad}
                    onClick={() => toggleSquadVisibility(squad)}
                    style={{
                      padding: "2px 8px", borderRadius: 5, border: "none", fontSize: 10, fontWeight: 600, cursor: "pointer",
                      background: visible ? `${color}18` : "var(--surface0)",
                      color: visible ? color : "var(--overlay0)",
                      opacity: visible ? 1 : 0.4,
                      fontFamily: "var(--font-sans)", transition: "all 0.15s",
                      fontStyle: isUngrouped ? "italic" : "normal",
                    }}
                  >
                    {label} <span style={{ fontSize: 9, opacity: 0.7 }}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {loading ? <LoadingMsg /> : (
          <AgentGrid
            list={filtered}
            expandedParents={expandedParents}
            toggleParent={toggleParent}
            actions={agentActions}
          />
        )}

        {!loading && filtered.length === 0 && <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: "var(--overlay0)" }}>No agents match your search.</div>}
      </div>
      </div>{/* end left panel */}

      {/* Right: Edit/Create agent panel */}
      {showNew && (() => {
        // Read-only when the agent isn't an editable tenant row:
        //  · origin_id set    — clone-imported from another publisher
        //  · metadata.__ref   — marketplace ref (canonical lives upstream)
        const viewOnly = !!(
          editAgent?.origin_id
          || (editAgent && (editAgent.metadata as Record<string, unknown> | null)?.__ref)
        );
        return (
        <div style={{ flex: 1, overflowY: "auto", background: "var(--mantle)" }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "var(--mantle)", zIndex: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{editAgent ? `${viewOnly ? "View" : "Edit"}: ${editAgent.name}` : "New Agent"}</div>
              {viewOnly && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 99, background: "rgba(203,166,247,0.12)", color: "var(--mauve)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  <Eye size={10} /> Read-only — clone to edit
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {/* Save scope picker (mig 191) — always visible when the
                  factory has projects, independent of the header's
                  scope expander (which controls what's VISIBLE in the
                  list). Save scope and view scope are independent
                  decisions: operator can save to project X without
                  having it in their visible scope. Default = factory. */}
              {!viewOnly && factoryProjects.length > 0 && (
                <select
                  value={saveProjectId ?? ""}
                  onChange={(e) => setSaveProjectId(e.target.value || null)}
                  title="Where this agent will be saved. Factory = shared across all the factory's projects; Project = scoped to one project only."
                  style={{
                    fontSize: 11, padding: "5px 8px", borderRadius: 6,
                    background: "var(--surface0)", border: "1px solid var(--surface1)",
                    color: "var(--text)", fontFamily: "var(--font-sans)", cursor: "pointer",
                  }}
                >
                  <option value="">Save to: Factory</option>
                  {factoryProjects.map((p) => (
                    <option key={p.id} value={p.id}>Save to: {p.name}</option>
                  ))}
                </select>
              )}
              {viewOnly ? (
                <button onClick={() => { if (editAgent) cloneAgent(editAgent); }} title="Clone this agent to make an editable copy" style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 8, border: "1px solid var(--surface1)", background: "var(--surface0)", color: "var(--text)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                  <Copy size={13} /> Clone to edit
                </button>
              ) : (
                <button onClick={saveAgent} disabled={saving} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 8, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1, fontFamily: "var(--font-sans)" }}>
                  {saving ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={13} />}
                  {editAgent ? "Save" : "Create"}
                </button>
              )}
              <button onClick={() => { setShowNew(false); setEditAgent(null); resetForm(); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4 }}><X size={18} /></button>
            </div>
          </div>
          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Base fields */}
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: 12, alignItems: "end" }}>
            {/* Icon selector */}
            <FormField label="Icon">
              <div style={{ position: "relative" }}>
                <button
                  onClick={() => !viewOnly && setShowIconPicker((v) => !v)}
                  disabled={viewOnly}
                  style={{ width: 40, height: 36, borderRadius: 8, border: "1px solid var(--surface1)", background: "var(--surface0)", cursor: viewOnly ? "default" : "pointer", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center", opacity: viewOnly ? 0.8 : 1 }}
                >
                  {newForm.icon || "🤖"}
                </button>
                {showIconPicker && (
                  <div style={{ position: "absolute", top: 42, left: 0, zIndex: 100, width: 280, maxHeight: 240, overflowY: "auto", background: "var(--mantle)", border: "1px solid var(--surface1)", borderRadius: 10, padding: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.4)", display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 2 }}>
                    {AGENT_ICONS.map((icon) => (
                      <button key={icon} onClick={() => { setNewForm((f) => ({ ...f, icon })); setShowIconPicker(false); }} style={{ width: 30, height: 30, border: "none", borderRadius: 6, background: newForm.icon === icon ? "var(--blue)" : "transparent", cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {icon}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </FormField>
            <FormField label="Name">
              <input
                value={newForm.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setNewForm((f) => ({ ...f, name, slug: editAgent ? f.slug : slugify(name) }));
                }}
                placeholder="My Agent"
                style={inputStyle}
                disabled={viewOnly}
              />
            </FormField>
            <FormField label="Slug">
              <input value={newForm.slug} onChange={(e) => setNewForm((f) => ({ ...f, slug: slugify(e.target.value, { keepDashes: true }) }))} placeholder="my-agent" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} disabled={viewOnly || !!editAgent} />
            </FormField>
          </div>
          <FormField label="Squad (optional)">
            {/* Combobox: type to filter existing squads OR type a new name.
                Plain <select> blocked operators from creating squads inline,
                so squad creation required leaving this modal. <datalist>
                gives autocomplete from the existing set without locking the
                input. Empty value = no squad. */}
            <input
              type="text"
              list="agent-squads-list"
              value={newForm.squad}
              onChange={(e) => setNewForm((f) => ({ ...f, squad: e.target.value }))}
              placeholder="Pick an existing squad or type a new one"
              style={{ ...inputStyle, fontFamily: "var(--font-mono)" }}
              disabled={viewOnly}
            />
            <datalist id="agent-squads-list">
              {[...new Set(agents.map((a) => a.squad).filter(Boolean))].sort().map((s) => (
                <option key={s!} value={s!} />
              ))}
            </datalist>
          </FormField>
          {/* ── Classification ── */}
          <div style={{ padding: "12px 14px", borderRadius: 10, border: "1px solid var(--surface0)", background: "var(--base)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Classification</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <FormField label="Level">
                <select value={newForm.level} onChange={(e) => setNewForm((f) => ({ ...f, level: e.target.value as AgentLevel | "" }))} style={inputStyle} disabled={viewOnly}>
                  <option value="">Generic</option>
                  <option value="specialist">Specialist</option>
                  <option value="super-specialist">Super-specialist</option>
                </select>
              </FormField>
              <FormField label="Version">
                <input
                  type="text"
                  value={newForm.version}
                  onChange={(e) => setNewForm((f) => ({ ...f, version: e.target.value }))}
                  placeholder="1.0.0"
                  style={inputStyle}
                  disabled={viewOnly}
                />
              </FormField>
            </div>
            <div style={{ marginTop: 12 }}>
              <FormField label="Tags (comma-separated)">
                <input
                  type="text"
                  value={newForm.tags}
                  onChange={(e) => setNewForm((f) => ({ ...f, tags: e.target.value }))}
                  placeholder="backend, api, server-side"
                  style={inputStyle}
                  disabled={viewOnly}
                />
              </FormField>
            </div>
          </div>

          {/* ── Persona ── */}
          <FormField label="Persona — who this agent is, what it does, how it behaves">
            <textarea
              value={newForm.persona}
              onChange={(e) => setNewForm((f) => ({ ...f, persona: e.target.value }))}
              placeholder={`Describe the agent's role, responsibilities, principles, and when to escalate.\n\nExample: "You are the Architect. You design software systems that make the next six months of delivery cheaper, not the next sprint…"`}
              rows={10}
              style={{ ...inputStyle, resize: "vertical", fontSize: 12, lineHeight: 1.6, fontFamily: "var(--font-sans)" }}
              disabled={viewOnly}
            />
          </FormField>


          {/* Tool picker — available for all custom agents */}
          {availableTools.length > 0 && (
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Tools
                  <span style={{ fontWeight: 400, marginLeft: 6, color: "var(--overlay0)" }}>({selectedTools.length}/{availableTools.length})</span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {!viewOnly && <button onClick={() => setSelectedTools(availableTools.map((t) => t.slug))} style={{ fontSize: 10, fontWeight: 600, color: "var(--blue)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", padding: 0 }}>Select all</button>}
                  {!viewOnly && <button onClick={() => setSelectedTools([])} style={{ fontSize: 10, fontWeight: 600, color: "var(--overlay0)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-sans)", padding: 0 }}>Unselect all</button>}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px", background: "var(--surface0)", borderRadius: 8, border: "1px solid var(--surface1)" }}>
                {availableTools.map((t) => {
                  const checked = selectedTools.includes(t.slug);
                  return (
                    <button
                      key={t.slug}
                      onClick={() => !viewOnly && setSelectedTools((prev) => checked ? prev.filter((s) => s !== t.slug) : [...prev, t.slug])}
                      disabled={viewOnly}
                      style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 4px", background: "none", border: "none", cursor: viewOnly ? "default" : "pointer", textAlign: "left", borderRadius: 5, color: "inherit" }}
                    >
                      {checked
                        ? <CheckSquare size={14} color="#1463ff" style={{ flexShrink: 0, marginTop: 1 }} />
                        : <Square size={14} color="var(--overlay0)" style={{ flexShrink: 0, marginTop: 1 }} />}
                      <div>
                        <div style={{ fontSize: 12, fontWeight: checked ? 600 : 400, fontFamily: "var(--font-mono)", color: checked ? "var(--text)" : "var(--subtext0)" }}>{t.slug}</div>
                        {t.description && <div style={{ fontSize: 11, color: "var(--overlay0)", lineHeight: 1.4 }}>{t.description}</div>}
                      </div>
                    </button>
                  );
                })}
              </div>
              {selectedTools.length > 0 && (
                <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 5 }}>
                  {selectedTools.length} tool{selectedTools.length > 1 ? "s" : ""} selected: {selectedTools.join(", ")}
                </div>
              )}
            </div>
          )}

          {formError && <ErrorBanner>{formError}</ErrorBanner>}
          </div>
        </div>
        );
      })()}

      {/* Import YAML modal */}
      {showImport && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
          <div style={{ background: "var(--mantle)", border: "1px solid var(--surface1)", borderRadius: 16, width: "min(600px, 95vw)", maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid var(--surface1)" }}>
              <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-heading)" }}>Import Agent from YAML</div>
              <button onClick={() => { setShowImport(false); setImportYaml(""); setImportError(null); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)" }}><X size={18} /></button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 8, border: "1px dashed var(--surface1)", cursor: "pointer", fontSize: 13, color: "var(--subtext0)" }}>
                  <Upload size={16} />
                  Choose .yaml file
                  <input type="file" accept=".yaml,.yml" onChange={handleFileUpload} style={{ display: "none" }} />
                </label>
              </div>
              <div style={{ fontSize: 12, color: "var(--overlay0)", textAlign: "center", marginBottom: 12 }}>or paste YAML below</div>
              <textarea
                value={importYaml}
                onChange={(e) => { setImportYaml(e.target.value); setImportError(null); }}
                placeholder={"slug: my-agent\nname: \"My Agent\"\nversion: \"1.0.0\"\nsquad: engineering\nautonomy: auto\n\npersona: |\n  ...\n\nsipoc:\n  ..."}
                rows={16}
                style={{ width: "100%", padding: "12px 14px", borderRadius: 8, border: "1px solid var(--surface1)", background: "var(--base)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", resize: "vertical", outline: "none", boxSizing: "border-box" }}
              />
              {importError && (
                <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 6, background: "var(--red)", color: "var(--base)", fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                  <AlertTriangle size={14} /> {importError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
                <button onClick={() => { setShowImport(false); setImportYaml(""); setImportError(null); }} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
                <button onClick={handleImportYaml} disabled={importSaving || !importYaml.trim()} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--blue)", color: "#fff", fontSize: 13, fontWeight: 700, cursor: importSaving ? "not-allowed" : "pointer", opacity: importSaving ? 0.6 : 1 }}>
                  {importSaving ? "Importing..." : "Import"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {dangerModal && <DangerModal action={dangerModal} onClose={() => setDangerModal(null)} />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SIPOC TAB
═══════════════════════════════════════════════════════════════════════════ */

// Agent icon catalog — organized by role category
const AGENT_ICONS = [
  // Tech & Dev
  "🤖","💻","⚙️","🔧","🛠️","🔩","🔌","💡","🧰","📟",
  "🖥️","📱","🌐","🔗","🗄️","💾","📡","🔬","🧪","🧬",
  // Security & Ops
  "🛡️","🔒","🔑","🔐","🚨","🔍","👁️","🕵️","🧯","🚀",
  // Data & AI
  "🧠","🤯","📊","📈","📉","🎯","🎲","🧮","📐","📏",
  // Design & Creative
  "🎨","✏️","🖌️","🖍️","📝","📋","📑","🗂️","📂","📁",
  // Communication
  "💬","📢","📣","🔔","📨","📧","📩","💌","📤","📥",
  // Business & Strategy
  "💼","📦","🏷️","💰","💵","💳","🏦","📊","🤝","🎖️",
  // QA & Testing
  "✅","❌","⚠️","🐛","🔴","🟢","🟡","✔️","❎","🧹",
  // Infrastructure
  "☁️","🐳","🐧","🔥","⚡","🌊","🏗️","🏭","📶","🛰️",
  // Roles & People
  "👤","👥","🧑‍💻","🧑‍🔬","🧑‍🎨","🧑‍💼","🧑‍🏫","🧑‍⚕️","🦾","🎭",
  // Misc
  "📚","🗺️","🧭","🔮","💎","🏆","🎪","🎬","🌟","⭐",
  "🪄","🎩","🦊","🦉","🐝","🐙","🦅","🐺","🦁","🐉",
];

const SQUAD_COLORS: Record<string, string> = {
  discovery: "#10b981", "product-design": "#6366f1", engineering: "#f59e0b",
  "platform-devops": "#0ea5e9", "release-engineering": "#0ea5e9",
  "data-engineering": "#f97316", "ai-ml-engineering": "#a855f7",
  marketing: "#f43f5e", operations: "#8b5cf6", governance: "#ef4444",
  strategy: "#06b6d4", "command-center": "#d946ef",
};

interface SipocAgentEdge { agent: string; artifact: string }
interface SipocMatrixRow {
  slug: string;
  name: string;
  level: string | null;
  parentSlug: string | null;
  squadSlug: string;
  squadColor: string;
  suppliers: SipocAgentEdge[];   // agents that feed into this one
  customers: SipocAgentEdge[];   // agents this one feeds into
}

function AgentBadge({ slug, name, color }: { slug: string; name?: string; color?: string }) {
  const c = color ?? "var(--overlay1)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 5, background: `${c}15`, border: `1px solid ${c}30`, fontSize: 11, fontWeight: 600, color: c, whiteSpace: "nowrap" }}>
      <Bot size={9} />
      {name ?? slug}
    </span>
  );
}

type ToolRow = { id: string; slug: string; name: string; description: string | null; type: string; status: string };
const TYPE_COLOR: Record<string, string> = { native: "#10b981", mcp: "#6366f1", rest: "#f59e0b" };
const TYPE_ICON: Record<string, string> = { native: "⚙️", mcp: "🔌", rest: "🌐" };
const STATUS_COLOR: Record<string, string> = { available: "#10b981", deprecated: "#f59e0b", disabled: "#6b7a9e" };

function ToolCard({ tool }: { tool: ToolRow }) {
  return (
    <div style={{ background: "var(--surface0)", border: "1px solid var(--surface1)", borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: `${TYPE_COLOR[tool.type]}18`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
          <Wrench size={14} color={TYPE_COLOR[tool.type]} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{tool.name}</span>
            <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: `${TYPE_COLOR[tool.type]}18`, color: TYPE_COLOR[tool.type], textTransform: "uppercase", letterSpacing: "0.05em" }}>{tool.type}</span>
            <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: `${STATUS_COLOR[tool.status]}18`, color: STATUS_COLOR[tool.status], textTransform: "uppercase", letterSpacing: "0.05em" }}>{tool.status}</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{tool.slug}</div>
          {tool.description && <div style={{ fontSize: 12, color: "var(--subtext0)", marginTop: 4, lineHeight: 1.5 }}>{tool.description}</div>}
        </div>
      </div>
    </div>
  );
}

function ToolsSection({ title, items, count }: { title: string; items: ToolRow[]; count: number }) {
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--overlay0)", marginBottom: 10 }}>
        {title} <span style={{ fontWeight: 400, opacity: 0.7 }}>({count})</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 10 }}>
        {items.map((t) => <ToolCard key={t.id} tool={t} />)}
      </div>
    </div>
  );
}

function ToolsTab({ userRole }: { userRole: UserRole }) {
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "native" | "mcp" | "rest">("all");

  useEffect(() => {
    supabase.from("tools").select("id, slug, name, description, type, status, origin").order("status").order("name")
      .then(({ data }) => { if (data) setTools(data as ToolRow[]); setLoading(false); });
  }, []);

  const q = search.toLowerCase();
  const filtered = tools.filter((t) =>
    (typeFilter === "all" || t.type === typeFilter) &&
    (!q || t.name.toLowerCase().includes(q) || t.slug.includes(q) || (t.description ?? "").toLowerCase().includes(q))
  );

  const available  = filtered.filter((t) => t.status === "available");
  const planned    = filtered.filter((t) => t.status === "planned");
  const deprecated = filtered.filter((t) => t.status === "deprecated");

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 24px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Tool Catalog</h2>
            <p style={{ fontSize: 13, color: "var(--subtext0)" }}>
              {tools.filter(t => t.status === "available").length} available · {tools.filter(t => t.status === "planned").length} planned · native and external integrations
            </p>
          </div>
          <SearchBox value={search} onChange={setSearch} placeholder="Filter tools…" />
        </div>
        <div style={{ display: "flex", gap: 5, marginBottom: 20 }}>
          {(["all", "native", "mcp", "rest"] as const).map((f) => (
            <button key={f} onClick={() => setTypeFilter(f)} style={{ padding: "4px 12px", borderRadius: 6, border: `1px solid ${typeFilter === f ? (f === "all" ? "#1463ff" : TYPE_COLOR[f]) : "var(--surface1)"}`, background: typeFilter === f ? `${f === "all" ? "#1463ff" : TYPE_COLOR[f]}12` : "transparent", color: typeFilter === f ? (f === "all" ? "#1463ff" : TYPE_COLOR[f]) : "var(--overlay0)", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {f}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ color: "var(--overlay0)", fontSize: 13 }}>Loading tools…</div>
        ) : (
          <>
            <ToolsSection title="Available" items={available} count={available.length} />
            <ToolsSection title="Planned integrations" items={planned} count={planned.length} />
            <ToolsSection title="Deprecated" items={deprecated} count={deprecated.length} />
            {!filtered.length && <div style={{ color: "var(--overlay0)", fontSize: 13 }}>No tools match "{search}".</div>}
          </>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════════════════════════════════════ */

type Tab = "agents" | "pipelines" | "skills" | "commands" | "hooks" | "projects" | "pip-manager" | "advanced";

/** Sub-tab id for the Studio > Advanced panel. Each entry is "{cli}-{primitive}"
 *  so the breadcrumb reads naturally and future CLIs (Codex, Aider) can
 *  slot in alongside Claude Code. */
type AdvancedSubTab = "cc-output-styles" | "cc-permissions";

export default function StudioPage() {
  const router = useRouter();
  const {
    session, tenantId, loading: authLoading,
    factoryId: ctxFactoryId,
    factoryName: ctxFactoryName,
    tenantPlan, memberRole, factories,
  } = useAuth();

  // Derive from context — no Supabase queries needed here.
  const factoryId      = ctxFactoryId ?? null;
  const plan           = tenantPlan ?? "starter";
  const userRole       = memberRole;
  const activeFactory = factories.find((f) => f.id === ctxFactoryId);
  const factoryOrigin = activeFactory?.origin ?? "custom";
  const inheritedFactoryIds = activeFactory?.inherits ?? [];

  const [tab,          setTab]          = useState<Tab>("agents");
  const [advancedTab,  setAdvancedTab]  = useState<AdvancedSubTab>("cc-output-styles");
  const [authReady,    setAuthReady]    = useState(false);
  const hideBuiltIn = false; // no distinction — all agents are equal

  // Bumped after a successful component change. Used as the `key` on the
  // active tab below, which forces a remount so the agents/pipelines/
  // projects lists re-fetch. Cheap remount-based refresh — beats prop-
  // drilling refetch callbacks into every sub-component.
  const [refreshTick] = useState(0);

  // Project multi-select scope (mig 191). Default = empty (factory-only
  // view, current behavior). When operator picks 1+ projects, Agents and
  // Pipelines panels also list project-scoped rows from those projects,
  // and CRUD forms gain a "Save scope" picker. Skills/Commands/Hooks
  // already support project_id via Project Settings selectMode; Studio
  // extension for those is a follow-up.
  interface ProjectMin { id: string; name: string; slug: string }
  const [factoryProjects, setFactoryProjects]   = useState<ProjectMin[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const [projectPickerOpen, setProjectPickerOpen]   = useState(false);
  // Factory itself is a scope toggle in the picker. Default checked
  // (current behaviour). Unchecking lets operator see ONLY project-
  // scoped components from the selected projects — useful when
  // auditing what's specific to a project vs shared across the factory.
  const [factoryInScope, setFactoryInScope] = useState(true);
  // Ref for click-outside dismiss — closes the picker when the operator
  // clicks anywhere outside its trigger + popup.
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!projectPickerOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!projectPickerRef.current) return;
      if (!projectPickerRef.current.contains(e.target as Node)) {
        setProjectPickerOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setProjectPickerOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [projectPickerOpen]);

  useEffect(() => {
    if (!factoryId || !session) { setFactoryProjects([]); return; }
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/projects?factoryId=${factoryId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok || cancelled) return;
      const body = await res.json() as { projects: ProjectMin[] };
      const ranked = (body.projects ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
      setFactoryProjects(ranked);
    })();
    return () => { cancelled = true; };
  }, [factoryId, session]);

  // Reset selection when the factory changes — projects don't cross factories.
  useEffect(() => {
    setSelectedProjectIds(new Set());
    setProjectPickerOpen(false);
    setFactoryInScope(true);
  }, [factoryId]);

  function toggleProjectScope(id: string) {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function clearProjectScope() {
    setSelectedProjectIds(new Set());
    setFactoryInScope(true);
  }

  // Auth guard
  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  // Factory guard — redirect to Factory Manager if no active factory
  useEffect(() => {
    if (!authLoading && session && !factoryId) router.replace("/factory-settings");
  }, [authLoading, session, factoryId, router]);

  // Mark auth ready once session + tenant context arrive.
  useEffect(() => {
    if (authLoading || !session || !tenantId) return;
    setAuthReady(true);
  }, [authLoading, session, tenantId]);

  // Tab order: Agents · Pipelines · Projects · Skills · Commands · Hooks.
  // Projects sits between pipelines (config) and per-primitive scaffolds
  // (skills/commands/hooks) so the operator's mental model flows from
  // "compose pipeline" → "see projects using it" → "tune the artefacts
  // each project gets". The Projects render is special-cased below
  // because it reuses the standalone Projects page; everything else
  // mounts a Studio tab component.
  const tabs: { id: Tab; label: string; icon: React.FC<{ size?: number }> }[] = [
    { id: "agents",    label: "Agents",    icon: Bot },
    { id: "pipelines", label: "Pipelines", icon: GitBranch },
    { id: "projects",  label: "Projects",  icon: FolderKanban },
    { id: "skills",    label: "Skills",    icon: BookText },
    { id: "commands",  label: "Commands",  icon: Terminal },
    { id: "hooks",       label: "Hooks",       icon: Zap },
    { id: "pip-manager", label: "PIP Manager", icon: Package },
    { id: "advanced",    label: "Advanced",    icon: Settings2 },
  ];

  // Sub-tabs surface CLI-specific primitives (Output Styles, future:
  // Permissions, Status Line, Codex options...). Reading them as
  // "{CLI} · {primitive}" keeps the breadcrumb obvious without nesting
  // a third level of UI.
  const advancedSubTabs: { id: AdvancedSubTab; label: string; cli: string; icon: React.FC<{ size?: number }> }[] = [
    { id: "cc-output-styles", label: "Output Styles", cli: "Claude Code", icon: Cpu },
    { id: "cc-permissions",   label: "Permissions",   cli: "Claude Code", icon: ShieldCheck },
  ];

  // Projects is now an inline tab — no longer navigates away

  return (
    <div style={{ display: "flex", flex: 1, height: "100vh", overflow: "hidden", fontFamily: "var(--font-sans)", color: "var(--text)", background: "var(--base)" }}>
      <AppSidebar active="studio" />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ height: 50, borderBottom: "1px solid var(--surface0)", background: "var(--mantle)", display: "flex", alignItems: "center", padding: "0 20px", gap: 4, flexShrink: 0 }}>
          <Layers size={16} color="var(--overlay0)" style={{ marginRight: 8 }} />
          {tabs.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, border: "none", background: active ? "var(--surface0)" : "transparent", color: active ? "var(--text)" : "var(--overlay0)", fontSize: 13, fontWeight: active ? 700 : 500, cursor: "pointer", fontFamily: "var(--font-sans)", transition: "all 0.15s" }}>
                <Icon size={14} /> {label}
              </button>
            );
          })}

          {/* Built-in toggle removed — no distinction */}

          {/* Active factory neon badge + project scope expander.
              Default scope = factory only (no projects selected); the
              expander widens scope to include rows from the picked
              projects (mig 191 project_id support). Skills/Commands/
              Hooks panels are factory-only here; their project picker
              lives in Project Settings selectMode. */}
          {ctxFactoryName && (
            <>
              <div style={{ flex: 1 }} />

              {factoryProjects.length > 0 && (() => {
                // Compose the chip label from current scope state.
                // Combinations: factory + N projects, factory only,
                // projects only (N), or nothing (rare — operator
                // unchecked everything; list goes empty).
                const projCount = selectedProjectIds.size;
                const chipLabel =
                  factoryInScope && projCount === 0  ? "Factory only"
                  : factoryInScope && projCount > 0  ? `Factory +${projCount} project${projCount === 1 ? "" : "s"}`
                  : !factoryInScope && projCount > 0 ? `${projCount} project${projCount === 1 ? "" : "s"} only`
                  :                                    "No scope";
                const chipActive = !factoryInScope || projCount > 0;
                const chipTitle = chipActive
                  ? `Scope: ${chipLabel.toLowerCase()}. Click to manage.`
                  : "Factory-only view. Click to widen scope (include project-scoped) or narrow (exclude factory).";
                return (
                <div ref={projectPickerRef} style={{ position: "relative" }}>
                  <button
                    onClick={() => setProjectPickerOpen((o) => !o)}
                    title={chipTitle}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "4px 10px", borderRadius: 7, marginRight: 8,
                      background: chipActive ? "rgba(203,166,247,0.08)" : "transparent",
                      border: `1px solid ${chipActive ? "rgba(203,166,247,0.30)" : "var(--surface1)"}`,
                      color: chipActive ? "var(--mauve)" : "var(--overlay0)",
                      fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)",
                      letterSpacing: "0.04em", textTransform: "uppercase",
                    }}
                  >
                    <FolderKanban size={11} />
                    {chipLabel}
                    <ChevronDown size={10} />
                  </button>
                  {projectPickerOpen && (
                    <div
                      style={{
                        position: "absolute", top: "100%", right: 0, marginTop: 4,
                        width: 280, maxHeight: 400, overflowY: "auto",
                        background: "var(--mantle)", border: "1px solid var(--surface1)",
                        borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                        zIndex: 100, padding: "8px",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px 8px", borderBottom: "1px solid var(--surface0)" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Scope</span>
                        {(selectedProjectIds.size > 0 || !factoryInScope) && (
                          <button
                            onClick={clearProjectScope}
                            title="Reset to factory only"
                            style={{ background: "transparent", border: "none", color: "var(--overlay1)", fontSize: 10, cursor: "pointer", padding: "0 4px" }}
                          >
                            Reset
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--overlay0)", padding: "6px", lineHeight: 1.4 }}>
                        Toggle factory and projects to widen or narrow the scope. Uncheck factory + pick a project to see only that project&apos;s components.
                      </div>
                      {/* Factory itself is a scope toggle (mig 191) — default
                          checked. Unchecking lets operator audit project-only
                          customs without factory-shared rows mixed in. */}
                      <label
                        style={{
                          display: "flex", alignItems: "center", gap: 8,
                          padding: "6px 8px", borderRadius: 6, marginBottom: 4,
                          background: factoryInScope ? "rgba(20,99,255,0.06)" : "transparent",
                          border: "1px solid " + (factoryInScope ? "rgba(20,99,255,0.20)" : "var(--surface0)"),
                          cursor: "pointer", fontSize: 12,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={factoryInScope}
                          onChange={() => setFactoryInScope((v) => !v)}
                          style={{ accentColor: "#1463ff", flexShrink: 0 }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: factoryInScope ? 600 : 400, color: "var(--text)" }}>{ctxFactoryName ?? "Factory"}</div>
                          <span style={{ fontSize: 9, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Factory scope</span>
                        </div>
                      </label>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
                        {factoryProjects.map((p) => {
                          const checked = selectedProjectIds.has(p.id);
                          return (
                            <label
                              key={p.id}
                              style={{
                                display: "flex", alignItems: "center", gap: 8,
                                padding: "6px 8px", borderRadius: 6,
                                background: checked ? "rgba(203,166,247,0.06)" : "transparent",
                                cursor: "pointer", fontSize: 12,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleProjectScope(p.id)}
                                style={{ accentColor: "var(--mauve)", flexShrink: 0 }}
                              />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: checked ? 600 : 400, color: "var(--text)" }}>{p.name}</div>
                                <code style={{ fontSize: 9, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{p.slug}</code>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                );
              })()}

              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "4px 12px", borderRadius: 7,
                background: "rgba(20,99,255,0.06)",
                border: "1px solid rgba(20,99,255,0.18)",
                boxShadow: "0 0 10px rgba(20,99,255,0.10), inset 0 0 6px rgba(20,99,255,0.04)",
              }}>
                <div style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "#1463ff",
                  boxShadow: "0 0 5px 2px rgba(20,99,255,0.55), 0 0 10px 3px rgba(20,99,255,0.2)",
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 10, fontWeight: 700, color: "#5b9aff",
                  letterSpacing: "0.04em", textTransform: "uppercase",
                }}>
                  {ctxFactoryName}
                </span>
              </div>
            </>
          )}
        </div>

        {authReady && (
          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            {tab === "agents"    && <AgentsTab    key={`agents-${refreshTick}`}    userRole={userRole} hideBuiltIn={hideBuiltIn} tenantId={tenantId} factoryName={ctxFactoryName} factoryOrigin={factoryOrigin} factoryId={factoryId} inheritedFactoryIds={inheritedFactoryIds} scopedProjects={factoryProjects.filter((p) => selectedProjectIds.has(p.id))} factoryProjects={factoryProjects} factoryInScope={factoryInScope} />}
            {tab === "pipelines" && <PipelinesTab key={`pipelines-${refreshTick}`} tenantId={tenantId} plan={plan} hideBuiltIn={hideBuiltIn} factoryName={ctxFactoryName} factoryOrigin={factoryOrigin} factoryId={factoryId} inheritedFactoryIds={inheritedFactoryIds} scopedProjects={factoryProjects.filter((p) => selectedProjectIds.has(p.id))} factoryProjects={factoryProjects} factoryInScope={factoryInScope} />}
            {tab === "skills" && factoryId && (
              <div key={`skills-${refreshTick}`} style={{ flex: 1, overflow: "auto" }}>
                <SkillsSection
                  factoryId={factoryId}
                  canWrite={userRole === "platform_admin" || userRole === "admin"}
                  hideTitle={false}
                />
              </div>
            )}
            {tab === "commands" && factoryId && (
              <div key={`commands-${refreshTick}`} style={{ flex: 1, overflow: "auto" }}>
                <CommandsSection
                  factoryId={factoryId}
                  canWrite={userRole === "platform_admin" || userRole === "admin"}
                />
              </div>
            )}
            {tab === "hooks" && factoryId && (
              <div key={`hooks-${refreshTick}`} style={{ flex: 1, overflow: "auto" }}>
                <HooksSection
                  factoryId={factoryId}
                  canWrite={userRole === "platform_admin" || userRole === "admin"}
                />
              </div>
            )}
            {tab === "pip-manager" && factoryId && (
              <div key={`pip-manager-${refreshTick}`} style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <PipManagerSection
                  factoryId={factoryId}
                  canWrite={userRole === "platform_admin" || userRole === "admin"}
                />
              </div>
            )}
            {tab === "advanced" && factoryId && (
              <div key={`advanced-${refreshTick}`} style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {/* Sub-tab strip — breadcrumb-like {CLI} · {primitive} */}
                <div style={{ borderBottom: "1px solid var(--surface0)", background: "var(--mantle)", padding: "8px 24px", display: "flex", gap: 4, flexShrink: 0 }}>
                  {advancedSubTabs.map(({ id, label, cli, icon: Icon }) => {
                    const isActive = advancedTab === id;
                    return (
                      <button
                        key={id}
                        onClick={() => setAdvancedTab(id)}
                        style={{
                          display: "flex", alignItems: "center", gap: 6,
                          padding: "5px 12px", borderRadius: 7, border: "none",
                          background: isActive ? "var(--surface0)" : "transparent",
                          color: isActive ? "var(--text)" : "var(--overlay0)",
                          fontSize: 12, fontWeight: isActive ? 700 : 500,
                          cursor: "pointer", fontFamily: "var(--font-sans)",
                          transition: "all 0.15s",
                        }}
                      >
                        <Icon size={13} />
                        <span style={{ color: "var(--overlay0)", fontWeight: 500, marginRight: 2 }}>{cli} ·</span>
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ flex: 1, overflow: "auto" }}>
                  {advancedTab === "cc-output-styles" && (
                    <OutputStylesSection
                      factoryId={factoryId}
                      canWrite={userRole === "platform_admin" || userRole === "admin"}
                    />
                  )}
                  {advancedTab === "cc-permissions" && (
                    <PermissionsSection
                      factoryId={factoryId}
                      canWrite={userRole === "platform_admin" || userRole === "admin"}
                    />
                  )}
                </div>
              </div>
            )}
            {tab === "projects"  && (
              <React.Suspense fallback={<div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>}>
                <ProjectsPageInner key={`projects-${refreshTick}`} asPanel />
              </React.Suspense>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SHARED SUB-COMPONENTS
═══════════════════════════════════════════════════════════════════════════ */

function PipelineRow({ pipeline, selected, onClick, onEdit, onDelete, builtIn, factoryProjects }: { pipeline: Pipeline; selected: boolean; onClick: () => void; onEdit?: () => void; onDelete?: () => void; builtIn?: boolean; factoryProjects?: { id: string; name: string; slug: string }[] }) {
  const gates = pipeline.steps.filter((s) => s.gate === "human").length;
  const proj = pipeline.project_id
    ? (factoryProjects ?? []).find((p) => p.id === pipeline.project_id)
    : null;
  return (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 8px", borderRadius: 8, marginBottom: 2, background: selected ? "var(--surface0)" : "transparent", borderLeft: selected ? "3px solid var(--blue)" : "3px solid transparent", cursor: "pointer" }}>
      <GitBranch size={13} color={selected ? "var(--blue)" : "var(--overlay0)"} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 5 }}>
          {pipeline.name}
          {builtIn && (
            <span title="Marketplace reference — read-only here. Updates from the publisher propagate automatically. Trash uninstalls the reference; clone the pipeline from the Studio canvas to customise." style={{
              fontSize: 8, fontWeight: 800, padding: "1px 5px", borderRadius: 3,
              background: "rgba(20,99,255,0.15)", color: "var(--blue)",
              textTransform: "uppercase", letterSpacing: "0.06em",
            }}>Installed</span>
          )}
          {/* mig 191 project-scope badge — fixed PROJ label, project
              name in tooltip. Mirrors AgentsTab AgentCard. */}
          {pipeline.project_id && (
            <span title={proj ? `Project-scoped to ${proj.name}` : "Project-scoped"} style={{
              fontSize: 8, fontWeight: 800, padding: "1px 5px", borderRadius: 3,
              background: "rgba(203,166,247,0.14)", color: "var(--mauve)",
              textTransform: "uppercase", letterSpacing: "0.06em",
            }}>PROJ</span>
          )}
        </div>
        <div style={{ fontSize: 10, color: "var(--overlay0)" }}>{pipeline.steps.length} steps · {gates} gates</div>
      </div>
      {onEdit && !builtIn && (
        <button onClick={(e) => { e.stopPropagation(); onEdit(); }} title="Edit pipeline" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, flexShrink: 0 }}>
          <Pencil size={11} />
        </button>
      )}
      {/* Trash semantics depend on origin: refs uninstall the marketplace
          adoption record; clones / authored rows delete the pipeline. */}
      {onDelete && (
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} title={builtIn ? "Uninstall — removes the marketplace reference" : "Delete pipeline"} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, flexShrink: 0 }}>
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div style={{ position: "relative" }}>
      <Search size={13} color="var(--overlay0)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        style={{ padding: "7px 12px 7px 30px", background: "var(--surface0)", border: "1px solid var(--surface1)", borderRadius: 8, color: "var(--text)", fontSize: 13, outline: "none", width: 190 }} />
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--subtext1)", marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 18, padding: "28px 24px", width: "100%", maxWidth: 520, boxShadow: "0 24px 64px rgba(0,0,0,0.4)", display: "flex", flexDirection: "column", gap: 14, maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4 }}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)", color: "var(--red)", fontSize: 13 }}>
      <AlertTriangle size={13} /> {children}
    </div>
  );
}

function SubmitBtn({ loading, label, icon, onClick }: { loading: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={loading} style={{ padding: "10px", borderRadius: 9, border: "none", background: "#1463ff", color: "#fff", fontSize: 13, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.7 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontFamily: "var(--font-sans)" }}>
      {icon} {loading ? "Saving…" : label}
    </button>
  );
}

function LoadingMsg() {
  return <div style={{ padding: 40, textAlign: "center", color: "var(--subtext0)", fontSize: 13 }}>Loading…</div>;
}
