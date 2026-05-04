"use client";

import React, { useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Plus, Play, Zap, GitBranch, FolderOpen, Clock, CheckCircle2,
  XCircle, AlertTriangle, X, Terminal, ExternalLink,
  Sparkles, Search, RefreshCw, Settings,
  ChevronDown, Loader2,
  HelpCircle, Brain, Save, ListTodo,
} from "lucide-react";
import AppSidebar from "@/components/AppSidebar";
import { ProjectCard, StatusBadge, type Project, type Sprint } from "@/components/ProjectCard";
import { SkillsSection } from "@/components/SkillsSection";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";
import { slugify } from "@/lib/slugify";
import { CLI_OPTIONS } from "@/lib/types";

/* ── Types ─────────────────────────────────────────────────────────────────── */

interface Pipeline {
  id: string; slug: string; name: string; description: string | null;
  type: "system" | "custom"; steps: unknown[];
}

// Projects with these statuses are considered "in flight" — Studio
// refuses to delete them; the operator must stop the sprint first.
const ACTIVE_STATUSES = ["running", "queued"];
const QUEUE_STATUSES = new Set(["queued", "executing", "running", "waiting", "paused", "provisioning"]);

/* ── Shared styles ──────────────────────────────────────────────────────────── */

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 8,
  background: "var(--surface0)", border: "1px solid var(--surface1)",
  color: "var(--text)", fontSize: 13, outline: "none",
  fontFamily: "var(--font-sans)", boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)",
  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6,
};

/**
 * Guided briefing template — Slice 0 of the Discovery foundation.
 * Pre-fills the briefing textarea with the WHAT/WHO/WHY/HOW-WE-KNOW
 * prompts so discovery agents (intake → scout → product-manager → PO)
 * have structured input instead of a thin paragraph. Operator edits in
 * place; the comments stay only as guidance and are invisible to agents
 * once content fills them.
 */
const GUIDED_BRIEFING_TEMPLATE = `# What — em uma frase, o que é isso?
<descreva o produto / feature em 1-2 frases>

# Who — quem usa, e em que momento?
<persona-alvo, contexto de uso>

# Why — qual problema resolve ou oportunidade abre?
<dor atual, ou ganho que destrava>

# How we'd know it's working — métrica ou sinal observável (opcional)
<métrica de sucesso, critério de saída, sinal qualitativo>
`;

/* ── New Project Modal ──────────────────────────────────────────────────────── */

const toProjectSlug = (name: string): string => slugify(name);

function NewProjectModal({
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

interface LiveProvider { id: string; models: { id: string; name: string }[] }

// Placeholder — RunSprintModal removed; Start Sprint is now in the Pipelines view.
// Keeping LiveProvider here as it is still used by ProjectSettingsModal.

/* ── Project Settings Modal ─────────────────────────────────────────────── */

type FocusMode = "speed" | "balanced" | "quality";
type OnRejection = "retry_once" | "end_sprint" | "request_instructions" | "skip";

type SupportedCli = "claude-code" | "aider" | "codex" | "plandex" | "goose" | "amp" | "gemini-cli";
type CliStorageBackend = "supabase" | "local";

interface CliAgentOverride {
  enabled: boolean;
  cli: SupportedCli;
  authMode?: "api-key" | "oauth";
  model?: string;
  timeout_secs?: number;
  max_turns?: number;
  open_pr?: boolean;
  effort?: "low" | "medium" | "high" | "max";
  append_system_prompt?: string;
  /** BL-26 Phase 4 — id of a harness_presets row in this project's
   *  factory. The worker merges preset.config UNDER this override at
   *  dispatch (override fields always win). Empty string = clear. */
  harness_preset_id?: string;
}

interface CliAgentsConfig {
  enabled?: boolean;
  /** @deprecated use execution_backend */
  execution_mode?: "cloud" | "local";
  execution_backend?: CliStorageBackend;
  local_base_path?: string;

  /** Tri-modal disambiguator — local vs local-git share execution_backend="local". */
  orchestration_mode?: "cloud" | "local" | "local-git";
  /** When orchestration_mode === "local-git", auto-commit at sprint end (default true). */
  git_auto_commit?: boolean;
  /** When orchestration_mode === "local-git", auto-push commit + tag to origin
   *  after committing locally. Default true. When false, the operator pushes
   *  manually after reviewing the working tree. */
  git_auto_push?: boolean;
  /** When true: execution sprints try to use the most recent pipeline-composer
   *  proposal (sprints.composed_pipeline) as their pipeline before falling
   *  back to project.pipeline. Default false. */
  auto_compose_enabled?: boolean;

  mcp_enabled?: boolean;
  hooks_enabled?: boolean;
  default_max_turns?: number;
  default_cli?: SupportedCli;
  agent_overrides?: Record<string, CliAgentOverride>;
}

type OutputDestination = "github" | "download" | "discard";

interface ProjectSettings {
  focus?: FocusMode;
  planning_provider?: string; planning_model?: string;
  dev_provider?: string; dev_model?: string;
  governance_provider?: string; governance_model?: string;
  default_provider?: string; default_model?: string;
  budget_usd?: number;
  timeout_agent_ms?: number;
  guidelines?: string;
  on_rejection?: OnRejection;
  detailed_monitoring?: boolean;
  use_dna?: boolean;
  /** Per-destination auto-push selection. Replaces legacy output_destinations + output_auto_push. */
  destinations?: Array<{ id: string; auto_push: boolean }>;
  github_branch?: string;
  cli_agents?: CliAgentsConfig;
  agent_configs?: Record<string, {
    provider?: string; model?: string;
    max_tool_rounds?: number; timeout_ms?: number;
    max_tokens?: number; guidelines?: string;
  }>;
  [key: string]: unknown;
}

// ── Provider / model catalogue (dynamic) ─────────────────────────────────────

const PROVIDER_DISPLAY: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google",
  mistral: "Mistral", perplexity: "Perplexity", xai: "xAI",
  zai: "zAI (01.AI)", deepseek: "DeepSeek", qwen: "Qwen", moonshot: "Moonshot AI",
};

function ProviderSelect({ value, onChange, style, providers }: {
  value: string; onChange: (v: string) => void; style?: React.CSSProperties; providers: LiveProvider[];
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={style}>
      <option value="">— not set (per-agent default)</option>
      {providers.map((p) => (
        <option key={p.id} value={p.id}>{PROVIDER_DISPLAY[p.id] ?? p.id}</option>
      ))}
    </select>
  );
}

function ModelSelect({ provider, value, onChange, style, providers }: {
  provider: string; value: string; onChange: (v: string) => void; style?: React.CSSProperties; providers: LiveProvider[];
}) {
  const models = providers.find((p) => p.id === provider)?.models ?? [];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={style} disabled={!provider}>
      <option value="">— not set (per-agent default)</option>
      {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
    </select>
  );
}

// ── Per-agent config row ──────────────────────────────────────────────────────

type AgentCfgRow = {
  disabled: boolean;
  provider: string; model: string;
  max_tool_rounds: string; timeout_ms: string; max_tokens: string;
  guidelines: string;
};

function emptyAgentCfg(): AgentCfgRow {
  return { disabled: false, provider: "", model: "", max_tool_rounds: "", timeout_ms: "", max_tokens: "", guidelines: "" };
}

function agentCfgFromSaved(saved?: { disabled?: boolean; provider?: string; model?: string; max_tool_rounds?: number; timeout_ms?: number; max_tokens?: number; guidelines?: string }): AgentCfgRow {
  if (!saved) return emptyAgentCfg();
  return {
    disabled:        saved.disabled ?? false,
    provider:        saved.provider ?? "",
    model:           saved.model ?? "",
    max_tool_rounds: saved.max_tool_rounds !== undefined ? String(saved.max_tool_rounds) : "",
    timeout_ms:      saved.timeout_ms !== undefined ? String(saved.timeout_ms) : "",
    max_tokens:      saved.max_tokens !== undefined ? String(saved.max_tokens) : "",
    guidelines:      saved.guidelines ?? "",
  };
}

function hasOverrides(cfg: AgentCfgRow): boolean {
  return cfg.provider !== "" || cfg.model !== "" || cfg.max_tool_rounds !== "" ||
    cfg.timeout_ms !== "" || cfg.max_tokens !== "" || cfg.guidelines !== "";
}

function SectionHeader({ id, title, icon, collapsed, onToggle, badge }: {
  id: string; title: string; icon: React.ReactNode; collapsed: boolean;
  onToggle: () => void; badge?: React.ReactNode;
}) {
  return (
    <button onClick={onToggle} type="button" style={{
      display: "flex", alignItems: "center", gap: 8, width: "100%",
      padding: "10px 0", background: "none", border: "none", cursor: "pointer",
      borderBottom: "1px solid var(--surface0)", marginBottom: collapsed ? 0 : 12,
      fontFamily: "var(--font-sans)",
    }}>
      {icon}
      <span style={{ flex: 1, textAlign: "left", fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{title}</span>
      {badge}
      <ChevronDown size={14} style={{ color: "var(--overlay0)", transform: collapsed ? "rotate(-90deg)" : "none", transition: "0.15s" }} />
    </button>
  );
}

function ProjectSettingsModal({ project, pipelines, onClose, onSaved, inline }: {
  project: Project & { settings?: ProjectSettings };
  pipelines: Pipeline[];
  onClose: () => void;
  onSaved: (updated: Project) => void;
  inline?: boolean;
}) {
  const s = project.settings ?? {};

  // ── Collapsible sections ──────────────────────────────────────────────
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    pipeline: true, orchestration: true, cli: true, agents: true,
    cag: true, rag: true, llm: true, budget: true, monitoring: true, github: true,
  });
  const toggleSection = (sec: string) => setCollapsed((p) => ({ ...p, [sec]: !p[sec] }));

  // ── Briefing ──────────────────────────────────────────────────────────
  const [briefing, setBriefing] = useState(project.intake_brief ?? "");
  const [prdMd, setPrdMd] = useState((project as { prd_md?: string | null }).prd_md ?? "");
  // Count of `todo` backlog items — used to warn the operator when they
  // edit the briefing while uncompleted items exist (the items were
  // shaped under the OLD briefing and won't be re-evaluated).
  const [backlogTodoCount, setBacklogTodoCount] = useState<number>(0);

  // ── Pipeline ───────────────────────────────────────────────────────────
  const [pipelineId, setPipelineId] = useState(project.pipeline_id ?? "");
  // Per-intent pipeline overrides. Empty string = "use default (pipelineId)".
  // Falling back to the default keeps single-pipeline projects working
  // without forcing a per-intent migration.
  const [discoveryPipelineId, setDiscoveryPipelineId] = useState((project as { discovery_pipeline_id?: string | null }).discovery_pipeline_id ?? "");
  const [planningPipelineId,  setPlanningPipelineId]  = useState((project as { planning_pipeline_id?:  string | null }).planning_pipeline_id  ?? "");
  const [executionPipelineId, setExecutionPipelineId] = useState((project as { execution_pipeline_id?: string | null }).execution_pipeline_id ?? "");
  const [reviewPipelineId,    setReviewPipelineId]    = useState((project as { review_pipeline_id?:    string | null }).review_pipeline_id    ?? "");
  const [heuristicIntent,     setHeuristicIntent]     = useState<boolean>(((project as { heuristic_intent?: boolean }).heuristic_intent) ?? false);

  // Agents available across the project's pipelines. Agent Configuration
  // surfaces the UNION of agents from default + discovery + execution
  // pipelines so the operator can tune ANY agent that might run on this
  // project, not just the ones in the legacy single-pipeline slot. The
  // intent-specific pipelines fall back to the default at runtime when
  // unset, so there's no double-counting from the union itself.
  const pipelineAgents = React.useMemo<string[]>(() => {
    const ids = [pipelineId, discoveryPipelineId, planningPipelineId, executionPipelineId, reviewPipelineId].filter((id): id is string => !!id);
    const unique = [...new Set(ids)];
    const collected = new Set<string>();
    for (const id of unique) {
      const pl = pipelines.find((p) => p.id === id);
      if (!pl) continue;
      for (const st of pl.steps as { agent: string }[]) {
        if (st.agent) collected.add(st.agent);
      }
    }
    return [...collected];
  }, [pipelines, pipelineId, discoveryPipelineId, planningPipelineId, executionPipelineId, reviewPipelineId]);

  // Per-agent provenance — which pipeline(s) include this agent. Used to
  // render a small badge next to each row in Agent Configuration so the
  // operator knows whether they're tuning an agent for discovery,
  // execution, or both.
  type AgentPipelineLabel = "default" | "discovery" | "planning" | "execution" | "review";
  const agentPipelineMap = React.useMemo<Record<string, Array<AgentPipelineLabel>>>(() => {
    const map: Record<string, Array<AgentPipelineLabel>> = {};
    const collect = (id: string | undefined, label: AgentPipelineLabel) => {
      if (!id) return;
      const pl = pipelines.find((p) => p.id === id);
      if (!pl) return;
      for (const st of pl.steps as { agent: string }[]) {
        if (!st.agent) continue;
        const list = map[st.agent] ?? [];
        if (!list.includes(label)) list.push(label);
        map[st.agent] = list;
      }
    };
    collect(pipelineId,          "default");
    collect(discoveryPipelineId, "discovery");
    collect(planningPipelineId,  "planning");
    collect(executionPipelineId, "execution");
    collect(reviewPipelineId,    "review");
    return map;
  }, [pipelines, pipelineId, discoveryPipelineId, planningPipelineId, executionPipelineId, reviewPipelineId]);

  // ── Live providers ─────────────────────────────────────────────────────
  const [liveProviders, setLiveProviders] = useState<LiveProvider[]>([]);
  const { session: authSession, tenantId, factoryId: ctxFactoryId, factoryName: ctxFactoryName } = useAuth();

  // ── Mode availability — matches Start Sprint Modal so the operator can't
  // pick a mode here that the dispatcher would later refuse. Defaults to
  // all-enabled so the picker renders before the fetch resolves.
  type ModeEvalUI = { enabled: boolean; reason?: string; severity?: "error" | "warning" };
  const [modeAvailability, setModeAvailability] = useState<{
    cloud: ModeEvalUI; local: ModeEvalUI; "local-git": ModeEvalUI;
  }>({ cloud: { enabled: true }, local: { enabled: true }, "local-git": { enabled: true } });
  useEffect(() => {
    if (!authSession || !project.id) return;
    let cancelled = false;
    fetch(`/api/projects/${project.id}/mode-availability`, {
      headers: { Authorization: `Bearer ${authSession.access_token}` },
    })
      .then(async (r) => {
        if (!r.ok) return;
        const body = await r.json() as { cloud: ModeEvalUI; local: ModeEvalUI; "local-git": ModeEvalUI };
        if (!cancelled) setModeAvailability({ cloud: body.cloud, local: body.local, "local-git": body["local-git"] });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authSession, project.id]);

  useEffect(() => {
    if (!authSession) return;
    fetch("/api/wizard/models", { headers: { Authorization: `Bearer ${authSession.access_token}` } })
      .then(async (res) => {
        if (res.ok) {
          const body = await res.json() as { providers: LiveProvider[] };
          setLiveProviders(body.providers ?? []);
        }
      });
  }, [authSession]);

  // Load available output destinations (factory-scoped + global).
  // Global is "implicit" — present whenever the tenant has GITHUB_OWNER
  // configured under Integrations → Storage. We probe for it here
  // rather than adding a dedicated endpoint.
  useEffect(() => {
    if (!authSession || !tenantId || !ctxFactoryId) return;
    setDestsLoading(true);
    const headers = { Authorization: `Bearer ${authSession.access_token}` };
    Promise.all([
      fetch(`/api/factory/output-destinations?factoryId=${ctxFactoryId}`, { headers })
        .then((r) => r.ok ? r.json() : { destinations: [] })
        .catch(() => ({ destinations: [] })),
      // Global destination probe — just checks whether GITHUB_OWNER is
      // present. GET /api/settings/integrations returns the configured
      // set so we can infer.
      fetch(`/api/settings/integrations?tenantId=${tenantId}`, { headers })
        .then((r) => r.ok ? r.json() : { configured: [] })
        .catch(() => ({ configured: [] })),
    ]).then(([factoryBody, intBody]) => {
      setFactoryDestinations(factoryBody.destinations ?? []);
      const configured = new Set<string>(intBody.configured ?? []);
      if (configured.has("github:GITHUB_OWNER") && configured.has("github:GITHUB_TOKEN")) {
        setGlobalDestAvailable({ owner: "(global)" });
      }
    }).finally(() => setDestsLoading(false));
  }, [authSession, tenantId, ctxFactoryId]);

  // ── Project-level state ────────────────────────────────────────────────
  const [focus,      setFocus]      = useState<FocusMode>(s.focus ?? "balanced");
  const [defProv,    setDefProv]    = useState(s.default_provider ?? "");
  const [defModel,   setDefModel]   = useState(s.default_model ?? "");
  const [planProv,   setPlanProv]   = useState(s.planning_provider ?? "");
  const [planModel,  setPlanModel]  = useState(s.planning_model ?? "");
  const [devProv,    setDevProv]    = useState(s.dev_provider ?? "");
  const [devModel,   setDevModel]   = useState(s.dev_model ?? "");
  const [govProv,    setGovProv]    = useState(s.governance_provider ?? "");
  const [govModel,   setGovModel]   = useState(s.governance_model ?? "");
  const [budget,     setBudget]     = useState(s.budget_usd !== undefined ? String(s.budget_usd) : "");
  const [timeout,    setTimeout_]   = useState(s.timeout_agent_ms !== undefined ? String(s.timeout_agent_ms) : "");
  const [guidelines, setGuidelines] = useState(s.guidelines ?? "");
  const [onReject,   setOnReject]   = useState<OnRejection>(s.on_rejection ?? "end_sprint");
  const [detailedMonitoring, setDetailedMonitoring] = useState(s.detailed_monitoring ?? false);
  const [useDna,             setUseDna]             = useState(s.use_dna ?? false);
  // ── Output destinations ───────────────────────────────────────────────
  // Replaces the prior single on/off "Enable GitHub" + "GitHub repo" flow.
  // A project now selects one or more GitHub destinations (factory-level
  // entries plus, if configured, the tenant-wide "global" one from
  // Storage). Sprints push artifacts to each selected destination.
  // New per-destination model: settings.destinations is an array of
  // { id, auto_push } pairs. Clean break — no legacy fallback (the prior
  // output_destinations / output_auto_push fields are intentionally
  // ignored; existing rows with only the legacy shape come up empty and
  // the operator re-selects in the new UI).
  const initialDests = Array.isArray(s.destinations) ? s.destinations : [];
  const [selectedDestIds, setSelectedDestIds] = useState<Set<string>>(
    new Set(initialDests.map((d) => d.id)),
  );
  const [destAutoPush, setDestAutoPush] = useState<Record<string, boolean>>(
    Object.fromEntries(initialDests.map((d) => [d.id, !!d.auto_push])),
  );
  const [factoryDestinations, setFactoryDestinations] = useState<
    { id: string; name: string; owner: string; tokenMask: string; branch: string | null }[]
  >([]);
  const [globalDestAvailable, setGlobalDestAvailable] = useState<{ owner: string } | null>(null);
  const [destsLoading, setDestsLoading] = useState(false);

  // ── Knowledge Base ────────────────────────────────────────────────────
  const [knowledgeInstances, setKnowledgeInstances] = useState<{ id: string; name: string; enabled: boolean; chunkCount: number }[]>([]);
  const [knowledgeLoaded, setKnowledgeLoaded] = useState(false);

  useEffect(() => {
    if (!authSession || !tenantId || knowledgeLoaded) return;
    const headers = { Authorization: `Bearer ${authSession.access_token}` };
    Promise.all([
      fetch(`/api/knowledge?tenantId=${tenantId}`, { headers }),
      fetch(`/api/projects/${project.id}/knowledge`, { headers }),
    ]).then(async ([allRes, linkedRes]) => {
      const allInstances: { id: string; name: string; enabled?: boolean; chunkCount: number }[] =
        allRes.ok ? ((await allRes.json()) as { instances: { id: string; name: string; chunkCount: number }[] }).instances ?? [] : [];
      const linkedInstances: { id: string; name: string; enabled?: boolean; chunkCount: number }[] =
        linkedRes.ok ? ((await linkedRes.json()) as { instances: { id: string; name: string; enabled?: boolean; chunkCount: number }[] }).instances ?? [] : [];
      const linkedIds = new Set(linkedInstances.filter((i) => i.enabled).map((i) => i.id));
      setKnowledgeInstances(allInstances.map((i) => ({ ...i, enabled: linkedIds.has(i.id) })));
    }).finally(() => setKnowledgeLoaded(true));
  }, [authSession, tenantId, project.id, knowledgeLoaded]);
  const [githubBranch,       setGithubBranch]       = useState((s.output_branch as string | undefined) ?? s.github_branch ?? "main");

  // ── Orchestration mode ──────────────────────────────────────────────────
  // Default to "local-git" for new/unconfigured projects (the recommended
  // path: local execution + commit/push to a real repo). Existing projects
  // keep their saved choice; execution_backend === "supabase" means cloud.
  const [orchMode, setOrchMode] = useState<"local" | "cloud" | "local-git">(() => {
    if (!s.cli_agents) return "local-git";
    // Tri-modal storage. The execution_backend column itself is binary
    // ("supabase" | "local") so we look at the orchestration_mode field
    // (added with the local-git rollout) to disambiguate local vs local-git.
    const stored = (s.cli_agents as { orchestration_mode?: "cloud" | "local" | "local-git" }).orchestration_mode;
    if (stored) return stored;
    if (s.cli_agents.execution_backend === "local" || s.cli_agents.enabled) return "local";
    return "cloud";
  });

  // ── CLI Agents ─────────────────────────────────────────────────────────────
  const [cliEnabled,       setCliEnabled]       = useState(s.cli_agents?.enabled ?? false);
  const [cliBackend,       setCliBackend]       = useState<CliStorageBackend>(s.cli_agents?.execution_backend ?? "supabase");
  const [cliLocalBasePath, setCliLocalBasePath] = useState(s.cli_agents?.local_base_path ?? "");
  // Repository URL — legacy free-text. Kept for projects that opt into
  // operator-managed git auth (use_operator_git_auth = true). New projects
  // should pick a working destination instead.
  const [repoUrl, setRepoUrl] = useState(project.repo_url ?? "");
  // Working destination FK — points to one of the factory's curated output
  // destinations. Used to derive the repo URL + provide the factory PAT for
  // ephemeral injection at push time.
  const [workingDestId, setWorkingDestId] = useState<string>(project.working_destination_id ?? "");
  // Operator git auth override — when true, worker skips PAT injection and
  // lets the operator's git config handle auth (signed commits, SSH, custom
  // credential helpers). Defaults to false (factory PAT path).
  const [useOperatorGitAuth, setUseOperatorGitAuth] = useState(project.use_operator_git_auth === true);

  // Mode lock — when off (default), every sprint is forced to the project's
  // execution_backend; the Start Sprint mode picker becomes read-only.
  const [allowModeSwitch, setAllowModeSwitch] = useState(s.allow_mode_switch === true);

  // Execution mode — explicit, single-field model for "how does this
  // project's sprints get triggered". Three options:
  //   manual         — no kanban; operator types a briefing per sprint
  //   kanban_manual  — kanban + operator-initiated runs
  //   kanban_auto    — kanban + periodic auto-drain (autonomous)
  // Backfilled from settings.backlog_auto_drain on existing rows.
  const initialExecutionMode = ((project as { execution_mode?: "manual" | "kanban_manual" | "kanban_auto" }).execution_mode)
    ?? (s.backlog_auto_drain === true ? "kanban_auto" : "manual");
  const [executionMode, setExecutionMode] = useState<"manual" | "kanban_manual" | "kanban_auto">(initialExecutionMode);
  // Compat alias — legacy code paths keyed off backlogAutoDrain still work.
  // kanban_auto is the only mode that runs the auto-drain pacing logic.
  const backlogAutoDrain = executionMode === "kanban_auto";
  // Cooldown (minutes) between auto-drain dispatches. Empty string = unset
  // (no cooldown); anything else is parsed as int when persisting.
  const [backlogAutoDrainCooldown, setBacklogAutoDrainCooldown] = useState<string>(
    typeof s.backlog_auto_drain_cooldown_minutes === "number" && s.backlog_auto_drain_cooldown_minutes > 0
      ? String(s.backlog_auto_drain_cooldown_minutes)
      : "",
  );
  const [backlogAutoDrainDailyCap, setBacklogAutoDrainDailyCap] = useState<string>(
    typeof s.auto_drain_daily_sprint_cap === "number" && s.auto_drain_daily_sprint_cap > 0
      ? String(s.auto_drain_daily_sprint_cap)
      : "",
  );
  // Active window — 3 fields. Empty start AND end = no window (24/7).
  // ProjectCard's ProjectSettings is loosely typed (`[key: string]: unknown`),
  // so cast at the access site to read the structured field shape.
  const activeWindow = s.auto_drain_active_window as { start_hour?: number; end_hour?: number; timezone?: string } | undefined;
  const [windowStartHour, setWindowStartHour] = useState<string>(
    typeof activeWindow?.start_hour === "number" ? String(activeWindow.start_hour) : "",
  );
  const [windowEndHour, setWindowEndHour] = useState<string>(
    typeof activeWindow?.end_hour === "number" ? String(activeWindow.end_hour) : "",
  );
  const [windowTimezone, setWindowTimezone] = useState<string>(
    activeWindow?.timezone ?? "UTC",
  );
  // Unproductive-loop threshold (consecutive no-commit sprints to halt).
  const unproductiveThresholdSetting = s.auto_drain_unproductive_threshold as number | undefined;
  const [unproductiveThreshold, setUnproductiveThreshold] = useState<string>(
    typeof unproductiveThresholdSetting === "number" && unproductiveThresholdSetting > 0
      ? String(unproductiveThresholdSetting)
      : "",
  );
  // What auto-drain does when backlog has no `todo` items.
  // Empty string lets the worker derive a default at runtime (discover_once
  // when discovery_pipeline_id is set, halt otherwise).
  const onEmptySaved = s.auto_drain_on_empty as "halt" | "discover_once" | "discover_continuous" | undefined;
  const [autoDrainOnEmpty, setAutoDrainOnEmpty] = useState<"" | "halt" | "discover_once" | "discover_continuous">(
    onEmptySaved ?? "",
  );
  // Per-sprint human approval gate. Off by default; opt-in for projects
  // that need a sign-off between sprints (regulated domains, still-tuning
  // pipeline phase). When on, the worker pauses the loop after each
  // sprint and the operator clicks Approve to resume.
  const [approvalRequired, setApprovalRequired] = useState<boolean>(
    s.auto_drain_approval_required === true,
  );

  // Local-git: auto-commit toggle. Default on. Ignored when not in local-git mode.
  // The mode itself is selected via the Orchestration Mode picker below.
  const [globalBasePath, setGlobalBasePath] = useState("");

  // Pull current backlog state so we can warn the operator on briefing
  // edits when uncompleted items would otherwise drift relative to the
  // new intent. Cheap one-shot on modal open — no live updates needed.
  useEffect(() => {
    if (!authSession) return;
    fetch(`/api/projects/${project.id}/backlog`, {
      headers: { Authorization: `Bearer ${authSession.access_token}` },
    })
      .then(async (r) => {
        if (!r.ok) return;
        const body = await r.json() as { items?: { status?: string }[] };
        const todos = (body.items ?? []).filter((it) => it.status === "todo").length;
        setBacklogTodoCount(todos);
      })
      .catch(() => {});
  }, [authSession, project.id]);

  // Fetch the resolved global base path from storage settings.
  // The endpoint always returns a value: a configured `local` backend wins,
  // otherwise a cross-platform homedir fallback (~/TwinPilotProjects). We
  // pre-fill the project's input with that resolved value so a fresh project
  // never starts blank.
  useEffect(() => {
    if (!authSession) return;
    fetch("/api/settings/storage", { headers: { Authorization: `Bearer ${authSession.access_token}` } })
      .then(async (r) => {
        if (!r.ok) return;
        const body = await r.json() as {
          backends: { type: string; basePath?: string }[];
          defaultLocalBasePath?: string;
          defaultLocalBasePathIsHomedirFallback?: boolean;
        };
        const resolved = body.defaultLocalBasePath
          ?? body.backends?.find((b) => b.type === "local")?.basePath
          ?? "";
        if (resolved) {
          setGlobalBasePath(resolved);
          if (!s.cli_agents?.local_base_path) setCliLocalBasePath(resolved);
        }
      })
      .catch(() => {});
  }, [authSession, s.cli_agents?.local_base_path]);
  const [gitStatus, setGitStatus] = useState<{ repoName?: string; repoUrl?: string | null; exists?: boolean | null } | null>(null);
  const [cliMcpEnabled,      setCliMcpEnabled]      = useState(s.cli_agents?.mcp_enabled !== false);
  const [cliHooksEnabled,    setCliHooksEnabled]    = useState(s.cli_agents?.hooks_enabled ?? false);
  const [cliDefaultMaxTurns, setCliDefaultMaxTurns] = useState(s.cli_agents?.default_max_turns ?? "");
  // local-git only: when false, the worker commits + tags locally but skips
  // push to origin; the operator pushes manually after review. Default true.
  const [cliAutoPush,        setCliAutoPush]        = useState(
    (s.cli_agents as { git_auto_push?: boolean } | undefined)?.git_auto_push !== false,
  );
  // Auto-compose: when on, execution sprints try the pipeline-composer's most
  // recent proposal before falling back to the project's default pipeline.
  // Default false (opt-in).
  const [cliAutoCompose,     setCliAutoCompose]     = useState(
    (s.cli_agents as { auto_compose_enabled?: boolean } | undefined)?.auto_compose_enabled === true,
  );
  // Discovery cadence (kanban_auto only): force a discovery sprint every
  // N execution sprints to let the PO refresh the kanban. Empty = off
  // (discovery only fires when backlog drains to zero, the legacy default).
  const [discoveryIntervalSprints, setDiscoveryIntervalSprints] = useState<string>(() => {
    const v = (s.cli_agents as { discovery_interval_sprints?: number } | undefined)?.discovery_interval_sprints;
    return typeof v === "number" && v > 0 ? String(v) : "";
  });

  // Fetch git repo status when local backend is selected
  useEffect(() => {
    if (!authSession || cliBackend !== "local") { setGitStatus(null); return; }
    fetch(`/api/projects/${project.id}/git-status`, {
      headers: { Authorization: `Bearer ${authSession.access_token}` },
    }).then(async (res) => {
      if (res.ok) setGitStatus(await res.json() as { repoName?: string; repoUrl?: string | null; exists?: boolean | null });
    }).catch(() => setGitStatus(null));
  }, [authSession, cliBackend, project.id]);
  const [cliDefaultCli,    setCliDefaultCli]    = useState<SupportedCli | "">(s.cli_agents?.default_cli ?? "claude-code");
  const [cliOverrides,     setCliOverrides]     = useState<Record<string, CliAgentOverride>>(
    s.cli_agents?.agent_overrides ?? {},
  );
  const [expandedCliAgent, setExpandedCliAgent] = useState<string | null>(null);

  // BL-26 Phase 4 — harness presets available in this project's
  // factory. Loaded once when the panel opens; the per-agent override
  // editor renders a dropdown that maps a name to harness_preset_id.
  const [harnessPresets, setHarnessPresets] = useState<Array<{ id: string; name: string; slug: string }>>([]);
  useEffect(() => {
    if (!authSession) return;
    void (async () => {
      try {
        const res = await fetch(`/api/factory/harness-presets?factoryId=${encodeURIComponent(project.factory_id ?? "")}`, {
          headers: { Authorization: `Bearer ${authSession.access_token}` },
        });
        if (!res.ok) return;
        const body = await res.json() as { presets?: Array<{ id: string; name: string; slug: string }> };
        setHarnessPresets(body.presets ?? []);
      } catch { /* non-fatal */ }
    })();
  }, [authSession, project.factory_id]);

  // Materialise implicit CLI-SUBS defaults for local-mode projects.
  // The display logic shows agents as CLI SUBS when override is absent
  // AND mode is local/local-git; without persisting that, the worker
  // would fall through to API at runtime — UI and runtime would lie.
  // This effect creates an actual override for every pipeline agent
  // missing one, only when the project is local-mode. Cloud-mode keeps
  // empty overrides (worker default = API). Operators who explicitly
  // toggle an agent to API still win — we only fill GAPS, never override.
  React.useEffect(() => {
    const isLocalish = orchMode === "local" || orchMode === "local-git";
    if (!isLocalish || pipelineAgents.length === 0) return;
    setCliOverrides((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const agent of pipelineAgents) {
        if (next[agent] !== undefined) continue;
        const cli = (cliDefaultCli || "claude-code") as SupportedCli;
        next[agent] = { enabled: true, cli, authMode: "oauth" };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [orchMode, pipelineAgents, cliDefaultCli]);

  function setCliAgentEnabled(agent: string, enabled: boolean) {
    setCliOverrides((prev) => {
      const existing = prev[agent];
      const cli = existing?.cli || cliDefaultCli || "claude-code" as SupportedCli;
      if (!enabled) {
        const next = { ...prev };
        delete next[agent];
        return next;
      }
      return { ...prev, [agent]: { ...(existing ?? {}), enabled: true, cli } };
    });
  }

  function setCliAgentField<K extends keyof CliAgentOverride>(agent: string, field: K, value: CliAgentOverride[K]) {
    setCliOverrides((prev) => ({
      ...prev,
      [agent]: { ...(prev[agent] ?? { enabled: true, cli: (cliDefaultCli || "claude-code") as SupportedCli }), [field]: value },
    }));
  }

  function applyAutoConfig(f: FocusMode) {
    setFocus(f);
  }

  // ── Per-agent fine-tuning state ────────────────────────────────────────
  const allAgentNames = React.useMemo(() => {
    const saved = Object.keys(s.agent_configs ?? {});
    return [...new Set([...pipelineAgents, ...saved])];
  }, [pipelineAgents, s.agent_configs]);

  const [agentCfgs, setAgentCfgs] = useState<Record<string, AgentCfgRow>>(() => {
    const init: Record<string, AgentCfgRow> = {};
    for (const a of allAgentNames) {
      init[a] = agentCfgFromSaved((s.agent_configs ?? {})[a]);
    }
    return init;
  });
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  // When pipeline changes, ensure all pipeline agents appear in the table
  useEffect(() => {
    setAgentCfgs((prev) => {
      const next = { ...prev };
      for (const a of pipelineAgents) {
        if (!next[a]) next[a] = emptyAgentCfg();
      }
      return next;
    });
  }, [pipelineAgents]);

  function setAgentField(agent: string, field: keyof AgentCfgRow, value: string | boolean) {
    setAgentCfgs((prev) => ({ ...prev, [agent]: { ...(prev[agent] ?? emptyAgentCfg()), [field]: value } }));
  }

  function removeAgent(name: string) {
    setAgentCfgs((prev) => { const next = { ...prev }; delete next[name]; return next; });
    if (expandedAgent === name) setExpandedAgent(null);
  }

  // ── UI helpers ─────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  /** Inline-discovery shortcut state — saves if dirty, then dispatches a
   *  sprint with intent='discovery'. Disabled while in flight or when
   *  briefing/PRD/pipeline aren't ready yet. */
  const [runningDiscovery, setRunningDiscovery] = useState(false);
  const ss: React.CSSProperties = { ...inputStyle, padding: "6px 10px", height: 32 };
  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 };
  const divider: React.CSSProperties = { borderTop: "1px solid var(--surface0)", margin: "14px 0" };

  function ProvRow({ label, prov, setProv, model, setModel }: {
    label: string;
    prov: string; setProv: (v: string) => void;
    model: string; setModel: (v: string) => void;
  }) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ width: 90, fontSize: 11, color: "var(--subtext0)", flexShrink: 0 }}>{label}</div>
        <ProviderSelect value={prov} onChange={(v) => { setProv(v); setModel(""); }} style={{ ...ss, flex: "0 0 160px" }} providers={liveProviders} />
        <ModelSelect provider={prov} value={model} onChange={setModel} style={{ ...ss, flex: 1 }} providers={liveProviders} />
      </div>
    );
  }

  // ── Save ───────────────────────────────────────────────────────────────
  async function handleSave() {
    // Local-git requires a working repo. Two valid shapes (mirrors the
    // server-side validation in /api/projects/[id]/run/route.ts):
    //   1. workingDestId set — picked from factory destinations.
    //   2. useOperatorGitAuth ON + legacy repoUrl set — operator drives
    //      git auth themselves with a free-text repo URL.
    if (orchMode === "local-git") {
      const hasDest    = workingDestId.trim() !== "";
      const hasLegacy  = repoUrl.trim() !== "";
      if (!hasDest && !(useOperatorGitAuth && hasLegacy)) {
        setError("Local + Git mode requires a working repository. Pick a destination from the factory's list, or enable 'Use my own git credentials' and fill the legacy URL.");
        return;
      }
    }
    setSaving(true); setError(null);
    if (!authSession) return;
    const session = authSession;

    const agent_configs: ProjectSettings["agent_configs"] = {};
    for (const [agent, cfg] of Object.entries(agentCfgs)) {
      // Store even if disabled so the values are preserved
      if (!hasOverrides(cfg) && !cfg.disabled) continue;
      agent_configs[agent] = {
        ...(cfg.disabled                                  ? { disabled: true } : {}),
        ...(cfg.provider        ? { provider: cfg.provider } : {}),
        ...(cfg.model           ? { model: cfg.model } : {}),
        ...(cfg.max_tool_rounds ? { max_tool_rounds: parseInt(cfg.max_tool_rounds, 10) } : {}),
        ...(cfg.timeout_ms      ? { timeout_ms: parseInt(cfg.timeout_ms, 10) } : {}),
        ...(cfg.max_tokens      ? { max_tokens: parseInt(cfg.max_tokens, 10) } : {}),
        ...(cfg.guidelines      ? { guidelines: cfg.guidelines } : {}),
      };
    }

    const enabledOverrides = Object.fromEntries(
      Object.entries(cliOverrides).filter(([, v]) => v.enabled),
    );

    // Always save cli_agents with execution_backend so orchestration mode
    // persists. execution_backend is binary; orchestration_mode
    // disambiguates local vs local-git (both map to backend="local").
    // git_auto_commit dropped — local-git always commits at sprint end now;
    // remote push is per-destination via Output Destinations.
    const isLocalish = orchMode === "local" || orchMode === "local-git";
    const cliAgentsCfg: CliAgentsConfig = {
      enabled: cliEnabled,
      execution_backend: isLocalish ? "local" : "supabase",
      orchestration_mode: orchMode,
      ...(isLocalish ? { local_base_path: cliLocalBasePath || globalBasePath || "" } : {}),
      // local-git only: persist when explicitly off. Default true is implicit
      // (run-pipeline reads `git_auto_push !== false` so undefined = on).
      ...(orchMode === "local-git" && !cliAutoPush ? { git_auto_push: false } : {}),
      // auto-compose: persist when on. Default false is implicit.
      ...(cliAutoCompose ? { auto_compose_enabled: true } : {}),
      // discovery cadence: persist when set + > 0. Empty/zero = off (legacy
      // behaviour: only on backlog drain).
      ...(discoveryIntervalSprints && parseInt(discoveryIntervalSprints, 10) > 0
        ? { discovery_interval_sprints: parseInt(discoveryIntervalSprints, 10) }
        : {}),
      ...(cliEnabled ? {
        mcp_enabled: cliMcpEnabled,
        hooks_enabled: cliHooksEnabled,
        // Only persist default_max_turns when the operator explicitly typed
        // a positive value. Earlier this branch wrote `default_max_turns: 1`
        // when the field was empty — every subsequent sprint then read 1
        // from the cli_agents chain and passed `--max-turns 1` to claude-code,
        // which exhausted on the first read. Omitting the key lets the
        // worker's default (20) take over.
        ...(cliDefaultMaxTurns && Number(cliDefaultMaxTurns) > 0
          ? { default_max_turns: Number(cliDefaultMaxTurns) }
          : {}),
        ...(cliDefaultCli ? { default_cli: cliDefaultCli } : {}),
        ...(Object.keys(enabledOverrides).length > 0 ? { agent_overrides: enabledOverrides } : {}),
      } : {}),
    };

    const settings: ProjectSettings = {
      focus,
      on_rejection: onReject,
      ...(defProv    ? { default_provider: defProv } : {}),
      ...(defModel   ? { default_model: defModel } : {}),
      ...(planProv   ? { planning_provider: planProv } : {}),
      ...(planModel  ? { planning_model: planModel } : {}),
      ...(devProv    ? { dev_provider: devProv } : {}),
      ...(devModel   ? { dev_model: devModel } : {}),
      ...(govProv    ? { governance_provider: govProv } : {}),
      ...(govModel   ? { governance_model: govModel } : {}),
      ...(budget     ? { budget_usd: parseFloat(budget) } : {}),
      ...(timeout    ? { timeout_agent_ms: parseInt(timeout, 10) } : {}),
      ...(guidelines ? { guidelines } : {}),
      ...(detailedMonitoring ? { detailed_monitoring: true } : {}),
      use_dna: useDna,
      // Per-destination auto-push model: settings.destinations holds
      // { id, auto_push } per selected destination. Clean break — the
      // legacy output_destinations / output_auto_push / output_destination
      // fields are no longer written; consumers were updated together.
      destinations: Array.from(selectedDestIds).map((id) => ({
        id,
        auto_push: !!destAutoPush[id],
      })),
      output_branch: githubBranch || "main",
      github_branch: githubBranch || "main",
      cli_agents: cliAgentsCfg,
      ...(allowModeSwitch ? { allow_mode_switch: true } : {}),
      // execution_mode is the source of truth (top-level column); the
      // legacy settings.backlog_auto_drain key is no longer written.
      // Auto-derive: autonomous projects always auto-close sprints (no
      // pending_save stalls). Operators who delegate to auto-drain don't
      // want to be paged on every no-diff sprint.
      ...(backlogAutoDrain ? { auto_close_sprints: true } : {}),
      ...(backlogAutoDrain && backlogAutoDrainCooldown && parseInt(backlogAutoDrainCooldown, 10) > 0
        ? { backlog_auto_drain_cooldown_minutes: parseInt(backlogAutoDrainCooldown, 10) }
        : {}),
      ...(backlogAutoDrain && backlogAutoDrainDailyCap && parseInt(backlogAutoDrainDailyCap, 10) > 0
        ? { auto_drain_daily_sprint_cap: parseInt(backlogAutoDrainDailyCap, 10) }
        : {}),
      ...(backlogAutoDrain && windowStartHour && windowEndHour
        ? {
            auto_drain_active_window: {
              start_hour: parseInt(windowStartHour, 10),
              end_hour:   parseInt(windowEndHour, 10),
              ...(windowTimezone && windowTimezone !== "UTC" ? { timezone: windowTimezone } : {}),
            },
          }
        : {}),
      ...(backlogAutoDrain && unproductiveThreshold && parseInt(unproductiveThreshold, 10) > 0
        ? { auto_drain_unproductive_threshold: parseInt(unproductiveThreshold, 10) }
        : {}),
      ...(backlogAutoDrain && autoDrainOnEmpty
        ? { auto_drain_on_empty: autoDrainOnEmpty }
        : {}),
      ...(backlogAutoDrain && approvalRequired
        ? { auto_drain_approval_required: true }
        : {}),
      ...(Object.keys(agent_configs).length > 0 ? { agent_configs } : {}),
    };

    const body: Record<string, unknown> = { settings };
    if (pipelineId !== (project.pipeline_id ?? "")) body.pipeline_id = pipelineId || null;
    if (discoveryPipelineId !== ((project as { discovery_pipeline_id?: string | null }).discovery_pipeline_id ?? "")) body.discovery_pipeline_id = discoveryPipelineId || null;
    if (planningPipelineId  !== ((project as { planning_pipeline_id?:  string | null }).planning_pipeline_id  ?? "")) body.planning_pipeline_id  = planningPipelineId  || null;
    if (executionPipelineId !== ((project as { execution_pipeline_id?: string | null }).execution_pipeline_id ?? "")) body.execution_pipeline_id = executionPipelineId || null;
    if (reviewPipelineId    !== ((project as { review_pipeline_id?:    string | null }).review_pipeline_id    ?? "")) body.review_pipeline_id    = reviewPipelineId    || null;
    if (heuristicIntent     !== (((project as { heuristic_intent?: boolean }).heuristic_intent) ?? false))            body.heuristic_intent     = heuristicIntent;
    if (briefing !== (project.intake_brief ?? "")) body.intake_brief = briefing || null;
    if (prdMd    !== ((project as { prd_md?: string | null }).prd_md ?? "")) body.prd_md = prdMd || null;
    if (repoUrl !== (project.repo_url ?? "")) body.repo_url = repoUrl.trim() || null;
    if (workingDestId !== (project.working_destination_id ?? "")) body.working_destination_id = workingDestId || null;
    if (useOperatorGitAuth !== (project.use_operator_git_auth === true)) body.use_operator_git_auth = useOperatorGitAuth;
    // execution_mode is a top-level column — always send it so the row
    // stays in sync with the operator's selection (no diff-check; the
    // backend ignores no-op writes).
    body.execution_mode = executionMode;

    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const resBody = await res.json() as { project?: Project; error?: string };
    if (!res.ok) { setSaving(false); setError(resBody.error ?? "Save failed."); return; }

    // Save knowledge instance links
    if (knowledgeLoaded) {
      await fetch(`/api/projects/${project.id}/knowledge`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ instances: knowledgeInstances.map((i) => ({ id: i.id, enabled: i.enabled })) }),
      }).catch(() => {});
    }

    setSaving(false);
    onSaved({
      ...project,
      pipeline_id:              pipelineId || null,
      discovery_pipeline_id:    discoveryPipelineId || null,
      planning_pipeline_id:     planningPipelineId  || null,
      execution_pipeline_id:    executionPipelineId || null,
      review_pipeline_id:       reviewPipelineId    || null,
      heuristic_intent:         heuristicIntent,
      intake_brief:             briefing || null,
      prd_md:                   prdMd || null,
      execution_mode:           executionMode,
      repo_url:                 repoUrl.trim() || null,
      working_destination_id:   workingDestId || null,
      use_operator_git_auth:    useOperatorGitAuth,
      settings,
    } as Project);
    onClose();
  }

  /**
   * Discovery shortcut handler. Saves the project first if anything in
   * the briefing/PRD/pipeline pickers changed (so the worker reads the
   * fresh state), then POSTs to /run with intent='discovery'. Closes
   * the panel on success and lets the caller's onSaved bubble.
   */
  async function runDiscoveryNow() {
    if (!authSession) return;
    setRunningDiscovery(true);
    setError(null);
    try {
      // Save first if there's anything dirty. handleSave returns void but
      // calls onSaved + onClose — we need the side effects (DB write)
      // without the close. Workaround: detect dirty state ourselves and
      // patch directly, leaving the modal open for the dispatch.
      const dirty =
        pipelineId           !== (project.pipeline_id ?? "") ||
        discoveryPipelineId  !== ((project as { discovery_pipeline_id?: string | null }).discovery_pipeline_id  ?? "") ||
        planningPipelineId   !== ((project as { planning_pipeline_id?:  string | null }).planning_pipeline_id   ?? "") ||
        executionPipelineId  !== ((project as { execution_pipeline_id?: string | null }).execution_pipeline_id  ?? "") ||
        reviewPipelineId     !== ((project as { review_pipeline_id?:    string | null }).review_pipeline_id     ?? "") ||
        heuristicIntent      !== (((project as { heuristic_intent?: boolean }).heuristic_intent) ?? false)            ||
        briefing             !== (project.intake_brief ?? "") ||
        prdMd                !== ((project as { prd_md?: string | null }).prd_md ?? "");
      if (dirty) {
        const patchBody: Record<string, unknown> = {
          pipeline_id:           pipelineId           || null,
          discovery_pipeline_id: discoveryPipelineId  || null,
          planning_pipeline_id:  planningPipelineId   || null,
          execution_pipeline_id: executionPipelineId  || null,
          review_pipeline_id:    reviewPipelineId     || null,
          heuristic_intent:      heuristicIntent,
          intake_brief:          briefing             || null,
          prd_md:                prdMd                || null,
        };
        const patchRes = await fetch(`/api/projects/${project.id}`, {
          method:  "PATCH",
          headers: { Authorization: `Bearer ${authSession.access_token}`, "Content-Type": "application/json" },
          body:    JSON.stringify(patchBody),
        });
        if (!patchRes.ok) {
          const body = await patchRes.json().catch(() => ({})) as { error?: string };
          setError(body.error ?? "Failed to save project before discovery dispatch.");
          return;
        }
      }

      const runRes = await fetch(`/api/projects/${project.id}/run`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${authSession.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ intent: "discovery", briefing }),
      });
      if (!runRes.ok) {
        const body = await runRes.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? "Failed to dispatch discovery sprint.");
        return;
      }
      // Success — close panel; the Office page picks up the running sprint.
      onClose();
    } finally {
      setRunningDiscovery(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={inline
      ? { flex: 1, overflowY: "auto", background: "var(--mantle)" }
      : { position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }
    }>
      <div style={inline ? {} : { background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 18, width: "min(720px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}>

        {/* Sticky header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid var(--surface0)", position: "sticky", top: 0, background: "var(--mantle)", zIndex: 1 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Project Settings</div>
            <div style={{ fontSize: 11, color: "var(--overlay0)" }}>{project.name}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <a
              href={`/projects/${project.id}/backlog`}
              title="Open project backlog (kanban)"
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "6px 12px", borderRadius: 8,
                border: "1px solid var(--surface1)", background: "transparent",
                color: "var(--subtext0)", fontSize: 11, fontWeight: 600,
                cursor: "pointer", fontFamily: "var(--font-sans)", textDecoration: "none",
              }}
            >
              <ListTodo size={12} /> Backlog
            </a>
            <button onClick={handleSave} disabled={saving} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 8, border: "none", background: "var(--blue)", color: "#fff", fontSize: 12, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.6 : 1, fontFamily: "var(--font-sans)" }}>
              {saving ? <RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Save size={12} />}
              Save
            </button>
            <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4 }}><X size={18} /></button>
          </div>
        </div>

        <div style={{ padding: "18px 20px" }}>

          {/* ── Discovery input gate banner (Slice 0) ─────────────────
             Discovery cannot run without ≥80 chars in briefing OR PRD,
             OR mode=adopt with a repo. Surface that state up front so
             operator knows *why* the Start Sprint click would 422. */}
          {(() => {
            const briefLen = briefing.trim().length;
            const prdLen   = prdMd.trim().length;
            const isAdopt  = project.mode === "adopt";
            const hasRepo  = Boolean((project.repo_url ?? "").trim() ||
                                    (project as { working_destination_id?: string }).working_destination_id);
            const hasInput =
              briefLen >= 80 || prdLen >= 80 || (isAdopt && hasRepo);
            if (hasInput) return null;
            return (
              <div style={{
                marginBottom: 16, padding: "10px 12px", borderRadius: 8,
                background: "rgba(254,166,73,0.08)", border: "1px solid rgba(254,166,73,0.25)",
                color: "var(--peach)", fontSize: 12, lineHeight: 1.5,
              }}>
                <strong>Discovery needs input.</strong> Provide at least one of:
                a briefing (≥80 chars), a PRD (≥80 chars), or a repo URL with mode=adopt.
                Try the <em>Insert guided template</em> button below to seed a briefing fast.
              </div>
            );
          })()}

          {/* ── Briefing (always visible, first item) ────────────────── */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <label style={{ flex: 1, fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Briefing</label>
              {/* Inline Discovery shortcut. Saves the project first if the
                  briefing was edited, then dispatches a discovery sprint. */}
              {(() => {
                const hasDiscoveryPipeline = Boolean(discoveryPipelineId || pipelineId);
                const briefingOk           = briefing.trim().length >= 80;
                const disabled             = !hasDiscoveryPipeline || !briefingOk || saving || runningDiscovery;
                const hint =
                  !hasDiscoveryPipeline ? "Configure a Discovery pipeline first"
                  : !briefingOk         ? "Briefing must be ≥80 chars"
                  : runningDiscovery    ? "Dispatching…"
                  : "Save changes (if any) and dispatch a Discovery sprint";
                return (
                  <button
                    type="button"
                    onClick={() => void runDiscoveryNow()}
                    disabled={disabled}
                    title={hint}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "3px 8px", borderRadius: 4,
                      border: "1px solid " + (disabled ? "var(--surface1)" : "rgba(20,99,255,0.4)"),
                      background: disabled ? "transparent" : "rgba(20,99,255,0.08)",
                      color:      disabled ? "var(--overlay0)" : "var(--blue)",
                      fontSize: 10, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    <Play size={9} /> Run Discovery
                  </button>
                );
              })()}
              <button
                type="button"
                onClick={() => {
                  if (briefing.trim().length > 0 && !confirm("Replace the current briefing with the guided template?")) return;
                  setBriefing(GUIDED_BRIEFING_TEMPLATE);
                }}
                style={{
                  padding: "3px 8px", borderRadius: 4, border: "1px solid var(--surface1)",
                  background: "transparent", color: "var(--subtext0)",
                  fontSize: 10, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
                }}
                title="Fill the briefing with WHAT/WHO/WHY/HOW-WE-KNOW prompts. Discovery agents work much better with this structure."
              >
                Insert guided template
              </button>
            </div>
            <textarea
              value={briefing}
              onChange={(e) => setBriefing(e.target.value)}
              placeholder="Describe the project scope, goals, and requirements..."
              rows={3}
              style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, fontFamily: "var(--font-sans)" }}
            />
            {/* PRD — optional structured markdown source for the backlog
                generator. When present, the operator can derive backlog
                items from it instead of typing them by hand. Hidden under
                a disclosure to keep the briefing the primary surface. */}
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--subtext0)", fontWeight: 600 }}>
                Product Requirements Document (optional)
              </summary>
              <div style={{ marginTop: 8 }}>
                <textarea
                  value={prdMd}
                  onChange={(e) => setPrdMd(e.target.value)}
                  placeholder="# Product Requirements Document&#10;&#10;## Overview&#10;...&#10;&#10;## Users&#10;...&#10;&#10;## Scope&#10;..."
                  rows={10}
                  style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}
                />
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
                  Markdown. Used by the kanban&apos;s <strong>Generate from PRD</strong> button to extract backlog items via LLM. Briefing stays the agent-facing tagline.
                </div>
              </div>
            </details>
            {/* Drift warning: briefing was edited AND there are uncompleted
                backlog items. Those items were authored under the OLD
                briefing — the system won't re-evaluate them. Operator owns
                coherence; this is the visible reminder. */}
            {briefing !== (project.intake_brief ?? "") && backlogTodoCount > 0 && (
              <div style={{
                marginTop: 8, padding: "8px 10px", borderRadius: 6,
                background: "rgba(245,159,0,0.10)", border: "1px solid rgba(245,159,0,0.25)",
                color: "var(--yellow, #df8e1d)", fontSize: 11, lineHeight: 1.5,
                display: "flex", alignItems: "flex-start", gap: 8,
              }}>
                <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  <strong>{backlogTodoCount} backlog item{backlogTodoCount === 1 ? "" : "s"}</strong> already in <strong>todo</strong> were authored under the old briefing.
                  They&apos;ll run as-is on the next sprint — review them on the kanban if the new briefing changes their scope.
                </span>
              </div>
            )}
          </div>

          {/* ── 1. Pipelines ──────────────────────────────────────────
              Three slots:
                - Default: used when intent-specific slots are empty.
                  This is the legacy single-pipeline field every project has.
                - Discovery: optional override for sprints with intent=discovery
                  (no backlog item; agents decide what to do).
                - Execution: optional override for sprints with intent=execution
                  (backlog-driven; agents do the defined work).
              When the intent override is empty, the worker falls back to the
              default. Single-pipeline projects keep working untouched. */}
          <SectionHeader id="pipeline" title="Pipelines" icon={<Zap size={14} color="var(--blue)" />} collapsed={collapsed.pipeline ?? false} onToggle={() => toggleSection("pipeline")} />
          {!collapsed.pipeline && (() => {
            // Two buckets — only what the tenant has actually adopted:
            //  · {factoryName} — pipelines created in / cloned to the
            //                    active factory (type='custom' AND
            //                    factory_id=ctxFactoryId).
            //  · Installed     — everything else the tenant has access to.
            //                    Marketplace ref-installs (type='system'
            //                    canonicals returned by /api/pipelines'
            //                    `installed` field) + tenant-level customs
            //                    without factory binding.
            const inFactory = pipelines.filter((p) => {
              if (p.type !== "custom") return false;
              const fid = (p as unknown as { factory_id?: string | null }).factory_id ?? null;
              return Boolean(ctxFactoryId && fid === ctxFactoryId);
            });
            const installed = pipelines.filter((p) => !inFactory.includes(p));
            const optionGroups = (
              <>
                {inFactory.length > 0 && (
                  <optgroup label={ctxFactoryName ?? "Factory"}>
                    {inFactory.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({(p.steps as unknown[]).length} steps)</option>
                    ))}
                  </optgroup>
                )}
                {installed.length > 0 && (
                  <optgroup label="Installed">
                    {installed.map((p) => (
                      <option key={p.id} value={p.id}>{p.name} ({(p.steps as unknown[]).length} steps)</option>
                    ))}
                  </optgroup>
                )}
              </>
            );
            return (
              <div style={{ marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4 }}>
                    Discovery pipeline
                  </label>
                  <select value={discoveryPipelineId} onChange={(e) => setDiscoveryPipelineId(e.target.value)} style={ss}>
                    <option value="">— none —</option>
                    {optionGroups}
                  </select>
                  <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 3 }}>
                    Sprints that <strong>produce/refine the PRD</strong> from the briefing. Typical shape: intake → scout → architect → plm → product-manager.
                  </div>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4 }}>
                    Planning pipeline
                  </label>
                  <select value={planningPipelineId} onChange={(e) => setPlanningPipelineId(e.target.value)} style={ss}>
                    <option value="">— none —</option>
                    {optionGroups}
                  </select>
                  <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 3 }}>
                    Sprints that <strong>populate or groom the backlog</strong> (product-owner-led). Sub-mode (initiation / grooming / sprint-backlog) decided at runtime by the heuristic or operator pick.
                  </div>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4 }}>
                    Execution pipeline
                  </label>
                  <select value={executionPipelineId} onChange={(e) => setExecutionPipelineId(e.target.value)} style={ss}>
                    <option value="">— none —</option>
                    {optionGroups}
                  </select>
                  <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 3 }}>
                    Sprints that <strong>implement selected backlog items</strong> (or briefing-per-sprint for manual projects). Default intent. Typical shape: developer → qa → docs → review.
                  </div>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4 }}>
                    Review pipeline
                  </label>
                  <select value={reviewPipelineId} onChange={(e) => setReviewPipelineId(e.target.value)} style={ss}>
                    <option value="">— none —</option>
                    {optionGroups}
                  </select>
                  <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 3 }}>
                    Post-execution <strong>quality gate</strong>. Typical shape: qa → eval → reviewer.
                  </div>
                </div>

                {/* Heuristic Intent toggle. When on, /run picks the intent
                    based on project state (briefing → discovery, PRD → planning,
                    backlog ready → execution, etc.). When off, the operator
                    picks the intent at Start Sprint. Defaults to off; flipped on
                    automatically for autonomous (kanban_auto) projects. */}
                <label style={{
                  display: "flex", alignItems: "flex-start", gap: 9, padding: "10px 12px",
                  borderRadius: 8, background: "var(--surface0)", border: "1px solid var(--surface1)",
                  cursor: "pointer",
                }}>
                  <input
                    type="checkbox"
                    checked={heuristicIntent}
                    onChange={(e) => setHeuristicIntent(e.target.checked)}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Heuristic intent</div>
                    <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2, lineHeight: 1.5 }}>
                      Infers the sprint intent from project state (briefing → discovery; PRD → planning; ready backlog → execution). Recommended for autonomous projects. When off, the operator picks the intent at Start Sprint.
                    </div>
                  </div>
                </label>

                {/* Default pipeline (legacy fallback). Only shown when no
                    per-intent slot is set, so new operators are guided into
                    the per-intent model and existing projects don't lose
                    their current pipeline silently. */}
                {(pipelineId || (!discoveryPipelineId && !planningPipelineId && !executionPipelineId && !reviewPipelineId)) && (
                  <div style={{ paddingTop: 10, borderTop: "1px solid var(--surface0)" }}>
                    <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext0)", marginBottom: 4 }}>
                      Default pipeline <span style={{ fontWeight: 400, color: "var(--overlay0)" }}>(legacy fallback)</span>
                    </label>
                    <select value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} style={ss}>
                      <option value="">— none —</option>
                      {optionGroups}
                    </select>
                    <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 3 }}>
                      Used by sprints whose intent has no per-intent pipeline above. Prefer the per-intent slots — this falls away as the operator fills them in.
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── Default LLM ─────────────────────────────────────────── */}
          <SectionHeader id="llm" title="Default LLM" icon={<Sparkles size={14} color="var(--mauve)" />} collapsed={collapsed.llm ?? false} onToggle={() => toggleSection("llm")}
            badge={defProv
              ? <span style={{ fontSize: 10, color: "var(--blue)", fontWeight: 600 }}>{PROVIDER_DISPLAY[defProv] ?? defProv}{defModel ? ` / ${defModel}` : ""}</span>
              : <span style={{ fontSize: 10, color: "var(--peach)" }}>
                  {liveProviders.length > 0
                    ? "not set — select a provider"
                    : "configure in Providers first"}
                </span>}
          />
          {!collapsed.llm && (
            <div style={{ marginBottom: 14 }}>
              {liveProviders.length === 0 ? (
                <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(245,159,0,0.06)", border: "1px solid rgba(245,159,0,0.15)", fontSize: 12, color: "var(--peach)", lineHeight: 1.6 }}>
                  No LLM providers configured.{" "}
                  <a href="/providers" target="_blank" rel="noreferrer" style={{ color: "var(--blue)", textDecoration: "none" }}>
                    Add API keys in Providers <ExternalLink size={9} style={{ verticalAlign: "middle" }} />
                  </a>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <label style={labelStyle}>Provider & Model</label>
                    <div style={grid2}>
                      <ProviderSelect value={defProv} onChange={(v) => { setDefProv(v); setDefModel(""); }} style={ss} providers={liveProviders} />
                      <ModelSelect provider={defProv} value={defModel} onChange={setDefModel} style={ss} providers={liveProviders} />
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--overlay0)" }}>
                    Per-agent overrides can be set in Agent Configuration below.
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── 2. Orchestration Mode ────────────────────────────────── */}
          <SectionHeader id="orchestration" title="Orchestration / Storage Mode" icon={<Settings size={14} color="var(--teal)" />} collapsed={collapsed.orchestration ?? false} onToggle={() => toggleSection("orchestration")} />
          {!collapsed.orchestration && (
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 11, color: "var(--overlay0)", margin: "0 0 8px 0", lineHeight: 1.5 }}>
                How agents execute and where artifacts live.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {([
                  { id: "cloud"     as const, label: "Cloud",     desc: "Provider APIs · Supabase Storage" },
                  { id: "local"     as const, label: "Local",     desc: "Local CLIs · per-sprint folders" },
                  { id: "local-git" as const, label: "Local + Git", desc: "Local CLIs · versioned at project root", badge: "Phase 1: type only — runtime same as Local" },
                ]).map((opt) => {
                  const evalForMode = modeAvailability[opt.id];
                  const unavailable = !evalForMode.enabled;
                  // Surface the reason as title (hover) for both unavailable
                  // (error) and warning (e.g. homedir fallback / legacy
                  // tenant token) so the operator sees the trade-off before
                  // saving.
                  const titleHint =
                    unavailable                            ? evalForMode.reason ?? "This mode is unavailable for this project."
                  : evalForMode.severity === "warning"     ? evalForMode.reason
                  : undefined;
                  return (
                  <button key={opt.id} disabled={unavailable} title={titleHint} onClick={() => {
                    if (unavailable) return;
                    setOrchMode(opt.id);
                    if (opt.id === "local" || opt.id === "local-git") {
                      setCliEnabled(true); setCliBackend("local");
                      // Auto-set all agents to CLI SUBS
                      setCliOverrides((prev) => {
                        const next = { ...prev };
                        for (const agent of pipelineAgents) {
                          next[agent] = { ...(next[agent] ?? { enabled: true, cli: (cliDefaultCli || "claude-code") as SupportedCli }), enabled: true, authMode: "oauth" };
                        }
                        return next;
                      });
                    } else {
                      setCliEnabled(false); setCliBackend("supabase");
                      // Auto-set all agents to API
                      setCliOverrides({});
                    }
                  }} style={{
                    textAlign: "left", padding: "10px 14px", borderRadius: 10,
                    cursor: unavailable ? "not-allowed" : "pointer",
                    opacity: unavailable ? 0.45 : 1,
                    border: `1.5px solid ${orchMode === opt.id ? "rgba(20,99,255,0.5)" : "var(--surface1)"}`,
                    background: orchMode === opt.id ? "rgba(20,99,255,0.08)" : "var(--surface0)",
                    fontFamily: "var(--font-sans)",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: orchMode === opt.id ? "#1463ff" : "var(--text)" }}>{opt.label}</div>
                      {opt.id === "local-git" && (
                        <span title={opt.badge} style={{
                          fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99,
                          background: "rgba(245,159,0,0.12)", color: "var(--peach)",
                          textTransform: "uppercase", letterSpacing: "0.04em",
                        }}>Preview</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--subtext0)" }}>{opt.desc}</div>
                  </button>
                  );
                })}
              </div>

              {/* ── Storage Location (User Space) ───────────────────────
                  Where artifacts live on the operator's machine when the
                  selected mode is local or local-git. Repository is the
                  push target for local-git only.
                  ─────────────────────────────────────────────────────── */}
              {(orchMode === "local" || orchMode === "local-git") && (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Storage Location · User Space
                  </div>

                  {/* Base path */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: 8, background: "var(--crust)", border: "1px solid var(--surface0)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "var(--subtext0)", width: 90, flexShrink: 0 }}>Base path <span style={{ color: "var(--red, #d20f39)" }}>*</span></span>
                      <input
                        value={cliLocalBasePath}
                        onChange={(e) => setCliLocalBasePath(e.target.value)}
                        placeholder={globalBasePath || "C:\\projects  or  /home/user/projects"}
                        style={{ ...inputStyle, padding: "5px 8px", fontSize: 11, height: 28, flex: 1 }}
                      />
                    </div>
                    <div style={{ fontSize: 10, color: "var(--overlay0)", marginLeft: 98 }}>
                      Required for {orchMode}. Agent workdir = <code style={{ fontFamily: "monospace" }}>{cliLocalBasePath || "<base path>"}/{"{projectSlug}"}</code>
                    </div>
                  </div>

                  {/* Repository (local-git only) — picked from factory destinations */}
                  {orchMode === "local-git" && (() => {
                    const hasDest     = workingDestId.trim() !== "";
                    const hasLegacy   = repoUrl.trim() !== "";
                    const invalid     = !hasDest && !(useOperatorGitAuth && hasLegacy);
                    const factoryDestList = factoryDestinations;
                    return (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: 8, background: "var(--crust)", border: `1px solid ${invalid ? "var(--red, #d20f39)" : "var(--surface0)"}` }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 11, color: "var(--subtext0)", width: 90, flexShrink: 0 }}>
                            Repository <span style={{ color: "var(--red, #d20f39)" }}>*</span>
                          </span>
                          <select
                            value={workingDestId}
                            onChange={(e) => setWorkingDestId(e.target.value)}
                            style={{
                              ...inputStyle,
                              padding: "5px 8px", fontSize: 11, height: 28, flex: 1,
                              borderColor: invalid ? "var(--red, #d20f39)" : (inputStyle.border as string | undefined)?.replace(/^.*?(#\w+|var\([^)]+\))$/, "$1") ?? undefined,
                            }}
                          >
                            <option value="">— pick a destination —</option>
                            {factoryDestList.map((d) => (
                              <option key={d.id} value={d.id}>{d.owner} · {d.name}</option>
                            ))}
                          </select>
                        </div>
                        <div style={{ fontSize: 10, color: invalid ? "var(--red, #d20f39)" : "var(--overlay0)", marginLeft: 98, lineHeight: 1.5 }}>
                          {invalid
                            ? "Required for Local + Git — pick a destination from the factory's curated list, or check 'Use my own git credentials' to keep a legacy URL."
                            : `Working tree pushes to https://github.com/{owner}/${project.slug}; factory PAT injected at push time.`}
                        </div>
                        {factoryDestList.length === 0 && (
                          <div style={{ fontSize: 10, color: "var(--overlay0)", marginLeft: 98, lineHeight: 1.5, fontStyle: "italic" }}>
                            No factory destinations configured — set them up in <strong>Factory Settings</strong> first.
                          </div>
                        )}
                        {/* Operator git-auth override */}
                        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginLeft: 98, marginTop: 6, cursor: "pointer", fontSize: 11, color: "var(--text)" }}>
                          <input
                            type="checkbox"
                            checked={useOperatorGitAuth}
                            onChange={(e) => setUseOperatorGitAuth(e.target.checked)}
                            style={{ marginTop: 2 }}
                          />
                          <span>
                            Use my own git credentials
                            <span style={{ display: "block", fontSize: 10, color: "var(--overlay0)", lineHeight: 1.4, marginTop: 2 }}>
                              Worker won&apos;t inject the factory PAT — push uses your local git config (signed commits, SSH key, credential helper).
                            </span>
                          </span>
                        </label>
                        {/* Legacy URL — only when operator-auth is on */}
                        {useOperatorGitAuth && (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 98, marginTop: 4 }}>
                            <span style={{ fontSize: 10, color: "var(--subtext0)", width: 80, flexShrink: 0 }}>Legacy URL</span>
                            <input
                              value={repoUrl}
                              onChange={(e) => setRepoUrl(e.target.value)}
                              placeholder="https://github.com/owner/repo"
                              style={{ ...inputStyle, padding: "4px 7px", fontSize: 10, height: 26, flex: 1 }}
                            />
                          </div>
                        )}
                        {/* Auto-push toggle */}
                        {(hasDest || (useOperatorGitAuth && hasLegacy)) && (
                          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginLeft: 98, marginTop: 6, cursor: "pointer", fontSize: 11, color: "var(--text)" }}>
                            <input
                              type="checkbox"
                              checked={cliAutoPush}
                              onChange={(e) => setCliAutoPush(e.target.checked)}
                              style={{ marginTop: 2 }}
                            />
                            <span>
                              Auto-push commit + tag to origin
                              <span style={{ display: "block", fontSize: 10, color: "var(--overlay0)", lineHeight: 1.4, marginTop: 2 }}>
                                When off, sprints commit + tag locally only — the sprint card surfaces the exact <code>git push</code> commands for you to run after review.
                              </span>
                            </span>
                          </label>
                        )}
                        <div style={{ fontSize: 10, color: "var(--overlay0)", marginLeft: 98, marginTop: 6, lineHeight: 1.5, fontStyle: "italic" }}>
                          Successful sprints always run <code style={{ fontFamily: "monospace" }}>git add … && git commit && git tag sprint-N</code> locally. Export Destinations (below) is for additional targets, separate from the working repo.
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Mode lock toggle — default off keeps every sprint on the
                  selected mode. Operator must opt in to mix modes. */}
              <label style={{
                display: "flex", alignItems: "flex-start", gap: 8,
                marginTop: 12, padding: "10px 12px", borderRadius: 8,
                background: "var(--crust)", border: "1px solid var(--surface0)",
                cursor: "pointer", fontFamily: "var(--font-sans)",
              }}>
                <input type="checkbox" checked={allowModeSwitch}
                  onChange={(e) => setAllowModeSwitch(e.target.checked)}
                  style={{ width: 13, height: 13, accentColor: "var(--blue)", marginTop: 2 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                    Allow per-sprint mode switching
                  </div>
                  <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2, lineHeight: 1.5 }}>
                    Off (default): every sprint runs in <strong>{orchMode}</strong>. Cross-backend artifact
                    reads aren&apos;t possible — locking the project to one mode keeps past-sprint context readable.
                    Turn on only when you legitimately need to mix.
                  </div>
                </div>
              </label>

              {/* Execution mode — three discrete patterns:
                  - manual         → no kanban, operator types a briefing
                                     per sprint and clicks Start
                  - kanban_manual  → curated kanban, operator clicks Start
                                     to dispatch the next item
                  - kanban_auto    → curated kanban + periodic auto-drain
                                     (autonomous; CLI daemon is the trigger
                                     for local/local-git, cloud trigger TBD)
                  Auto-drain pacing controls (cooldown, daily cap, active
                  window, on_empty) only apply when kanban_auto. */}
              {(() => {
                const isLocalMode = orchMode === "local" || orchMode === "local-git";
                const autoUnavailable = !isLocalMode && executionMode !== "kanban_auto";
                return (
              <div style={{
                display: "flex", flexDirection: "column", gap: 8,
                marginTop: 8, padding: "10px 12px", borderRadius: 8,
                background: "var(--crust)", border: "1px solid var(--surface0)",
                fontFamily: "var(--font-sans)",
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                    Execution mode
                  </div>
                  <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 8, lineHeight: 1.5 }}>
                    How sprints are triggered for this project. Affects which controls show on the project card and the kanban.
                  </div>
                  <select
                    value={executionMode}
                    onChange={(e) => setExecutionMode(e.target.value as "manual" | "kanban_manual" | "kanban_auto")}
                    style={{
                      width: "100%", padding: "6px 8px", borderRadius: 6,
                      border: "1px solid var(--surface1)", background: "var(--base)",
                      color: "var(--text)", fontSize: 12, fontFamily: "var(--font-sans)",
                    }}
                  >
                    <option value="manual">Manual — operator types a briefing per sprint (no kanban)</option>
                    <option value="kanban_manual">Kanban (manual) — curated backlog, operator dispatches each sprint</option>
                    <option value="kanban_auto" disabled={autoUnavailable}>
                      Kanban (autonomous) — periodic auto-drain{autoUnavailable ? " (coming soon for cloud)" : ""}
                    </option>
                  </select>
                  {executionMode === "kanban_auto" && (
                    <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 6, lineHeight: 1.5 }}>
                      {isLocalMode ? (
                        <>Run <code style={{ fontSize: 11 }}>{brand.cli.binName} autodrain --background</code> on your machine to enable scheduling. <strong>Run next</strong> on the kanban dispatches on demand without the daemon.</>
                      ) : (
                        <>Available for <strong>local</strong> and <strong>local-git</strong> projects today via the CLI daemon. Cloud-mode triggering is coming. Use <strong>Run next</strong> on the kanban for manual dispatches in the meantime.</>
                      )}
                    </div>
                  )}
                  {backlogAutoDrain && (
                    <div
                      onClick={(e) => e.preventDefault()}
                      style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8, fontSize: 11, color: "var(--subtext0)" }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <label htmlFor="backlog-cooldown" style={{ cursor: "default" }}>Cooldown between sprints:</label>
                        <input
                          id="backlog-cooldown"
                          type="number"
                          min={0}
                          step={1}
                          placeholder="0"
                          value={backlogAutoDrainCooldown}
                          onChange={(e) => setBacklogAutoDrainCooldown(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: 64, padding: "4px 6px", borderRadius: 6,
                            border: "1px solid var(--surface1)", background: "var(--base)",
                            color: "var(--text)", fontSize: 11, fontFamily: "var(--font-sans)",
                          }}
                        />
                        <span>minutes (0 = no wait — dispatch on next cron tick)</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                        <label htmlFor="discovery-interval" style={{ cursor: "default", paddingTop: 4 }}>Periodic discovery:</label>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span>every</span>
                            <input
                              id="discovery-interval"
                              type="number"
                              min={0}
                              step={1}
                              placeholder="off"
                              value={discoveryIntervalSprints}
                              onChange={(e) => setDiscoveryIntervalSprints(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                width: 56, padding: "4px 6px", borderRadius: 6,
                                border: "1px solid var(--surface1)", background: "var(--base)",
                                color: "var(--text)", fontSize: 11, fontFamily: "var(--font-sans)",
                              }}
                            />
                            <span>execution sprints, force a discovery (empty / 0 = off)</span>
                          </div>
                          <span style={{ fontSize: 10, color: "var(--overlay0)", lineHeight: 1.4 }}>
                            Lets the product-owner refresh the kanban without operators having to drain it. Discovery doesn&apos;t consume backlog items.
                          </span>
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <label htmlFor="backlog-daily-cap" style={{ cursor: "default" }}>Daily sprint cap:</label>
                        <input
                          id="backlog-daily-cap"
                          type="number"
                          min={0}
                          step={1}
                          placeholder="0"
                          value={backlogAutoDrainDailyCap}
                          onChange={(e) => setBacklogAutoDrainDailyCap(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: 64, padding: "4px 6px", borderRadius: 6,
                            border: "1px solid var(--surface1)", background: "var(--base)",
                            color: "var(--text)", fontSize: 11, fontFamily: "var(--font-sans)",
                          }}
                        />
                        <span>sprints / 24h (0 = unlimited — anti-runaway)</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <label style={{ cursor: "default" }}>Active window:</label>
                        <input
                          aria-label="start hour"
                          type="number"
                          min={0}
                          max={23}
                          step={1}
                          placeholder="—"
                          value={windowStartHour}
                          onChange={(e) => setWindowStartHour(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: 50, padding: "4px 6px", borderRadius: 6,
                            border: "1px solid var(--surface1)", background: "var(--base)",
                            color: "var(--text)", fontSize: 11, fontFamily: "var(--font-sans)",
                          }}
                        />
                        <span>to</span>
                        <input
                          aria-label="end hour"
                          type="number"
                          min={0}
                          max={23}
                          step={1}
                          placeholder="—"
                          value={windowEndHour}
                          onChange={(e) => setWindowEndHour(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: 50, padding: "4px 6px", borderRadius: 6,
                            border: "1px solid var(--surface1)", background: "var(--base)",
                            color: "var(--text)", fontSize: 11, fontFamily: "var(--font-sans)",
                          }}
                        />
                        <span>(0-23) in</span>
                        <input
                          aria-label="timezone"
                          type="text"
                          placeholder="UTC"
                          value={windowTimezone}
                          onChange={(e) => setWindowTimezone(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: 140, padding: "4px 6px", borderRadius: 6,
                            border: "1px solid var(--surface1)", background: "var(--base)",
                            color: "var(--text)", fontSize: 11, fontFamily: "var(--font-sans)",
                          }}
                        />
                        <span>(empty = 24/7 — IANA name like &quot;America/Sao_Paulo&quot;)</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <label htmlFor="backlog-unproductive" style={{ cursor: "default" }}>Halt after no-diff:</label>
                        <input
                          id="backlog-unproductive"
                          type="number"
                          min={0}
                          step={1}
                          placeholder="0"
                          value={unproductiveThreshold}
                          onChange={(e) => setUnproductiveThreshold(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            width: 64, padding: "4px 6px", borderRadius: 6,
                            border: "1px solid var(--surface1)", background: "var(--base)",
                            color: "var(--text)", fontSize: 11, fontFamily: "var(--font-sans)",
                          }}
                        />
                        <span>consecutive sprints (local-git only — 0 = no check)</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexDirection: "column" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <label htmlFor="backlog-on-empty" style={{ cursor: "default" }}>When backlog is empty:</label>
                          <select
                            id="backlog-on-empty"
                            value={autoDrainOnEmpty}
                            onChange={(e) => setAutoDrainOnEmpty(e.target.value as "" | "halt" | "discover_once" | "discover_continuous")}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              padding: "4px 6px", borderRadius: 6,
                              border: "1px solid var(--surface1)", background: "var(--base)",
                              color: "var(--text)", fontSize: 11, fontFamily: "var(--font-sans)",
                            }}
                          >
                            <option value="">— auto (discover when pipeline set, halt otherwise) —</option>
                            <option value="halt">Halt and notify (operator decides)</option>
                            <option value="discover_once">Run discovery once, then wait</option>
                            <option value="discover_continuous">Keep running discovery (paced by cooldown / cap)</option>
                          </select>
                        </div>
                        <div style={{ fontSize: 10, color: "var(--overlay0)", paddingLeft: 4, lineHeight: 1.5 }}>
                          To suspend dispatches and edit the kanban without interruption, click <strong>Pause</strong> on the project card or the kanban header — that stops new sprints regardless of mode and preserves all settings. Resume when ready.
                        </div>
                      </div>
                      {/* Per-sprint approval gate — opt-in human checkpoint
                          between sprints. Useful for regulated domains or
                          early-tuning phases where you don't want unattended
                          dispatch yet. */}
                      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginTop: 4 }}>
                        <input
                          type="checkbox"
                          checked={approvalRequired}
                          onChange={(e) => setApprovalRequired(e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                          style={{ width: 13, height: 13, accentColor: "var(--blue)", marginTop: 2, cursor: "pointer" }}
                        />
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>
                            Require approval between sprints
                          </div>
                          <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2, lineHeight: 1.5 }}>
                            After each sprint completes, the loop pauses until you click <strong>Approve</strong> on the project card. Use when full autonomy is too aggressive — every sprint gets a human checkpoint.
                          </div>
                        </div>
                      </label>
                    </div>
                  )}
                </div>
              </div>
                );
              })()}
            </div>
          )}

          {/* ── 3. Export Destinations ──────────────────────────────────────
              Additional targets the operator can export sprint artifacts to,
              separate from the project's working repo (the working repo is
              already pushed/committed by the local-git path). Each
              destination has its own auto-push toggle so the operator can
              mix automatic + manual targets in the same project. */}
          <SectionHeader id="github" title="Export Destinations" icon={<GitBranch size={14} color="var(--text)" />} collapsed={collapsed.github ?? false} onToggle={() => toggleSection("github")} />
          {!collapsed.github && (
            <div style={{ marginBottom: 14 }}>
              <p style={{ fontSize: 11, color: "var(--overlay1)", margin: "0 0 10px", lineHeight: 1.5 }}>
                Additional GitHub owners to export sprint artifacts to (separate from the working repo, which is already pushed by local-git). Factory-level destinations come from Factory Manager; the Global one comes from Integrations → Storage. Toggle <strong>auto-push</strong> per destination — destinations without auto-push remain available for manual export.
              </p>

              {destsLoading && (
                <div style={{ fontSize: 12, color: "var(--overlay0)" }}>Loading destinations…</div>
              )}

              {!destsLoading && factoryDestinations.length === 0 && !globalDestAvailable && (
                <div style={{
                  fontSize: 11, color: "var(--overlay0)", padding: "8px 10px",
                  background: "var(--surface0)", borderRadius: 7,
                  border: "1px dashed var(--surface1)",
                }}>
                  No destinations configured yet. Add one in <strong>Factory Manager</strong> (per-factory) or <strong>Integrations → Storage</strong> (global).
                </div>
              )}

              {!destsLoading && (factoryDestinations.length > 0 || globalDestAvailable) && (() => {
                // The working repo is the storage repo (committed/pushed by
                // the local-git path) — it's redundant as an export target
                // for the same project, so hide it here. Other projects that
                // happen to share the destination still see it.
                const showGlobal = !!globalDestAvailable;
                const workingRepoDestId = workingDestId || null;
                const visibleFactory = factoryDestinations.filter((d) => d.id !== workingRepoDestId);
                const hiddenCount = factoryDestinations.length - visibleFactory.length;
                const isWorkingRepoDest = (_id: string): boolean => false;
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                    {showGlobal && (
                      <DestCheckbox
                        checked={selectedDestIds.has("global")}
                        onChange={(v) => setSelectedDestIds((prev) => {
                          const next = new Set(prev);
                          if (v) next.add("global"); else next.delete("global");
                          return next;
                        })}
                        autoPush={!!destAutoPush["global"]}
                        onAutoPushChange={(v) => setDestAutoPush((prev) => ({ ...prev, global: v }))}
                        label="Global"
                        sublabel={`owner: ${globalDestAvailable!.owner} · from Integrations → Storage`}
                      />
                    )}
                    {visibleFactory.map((d) => {
                      const isWorking = isWorkingRepoDest(d.id);
                      return (
                        <DestCheckbox
                          key={d.id}
                          checked={selectedDestIds.has(d.id)}
                          onChange={(v) => setSelectedDestIds((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(d.id); else next.delete(d.id);
                            return next;
                          })}
                          autoPush={!!destAutoPush[d.id]}
                          onAutoPushChange={(v) => setDestAutoPush((prev) => ({ ...prev, [d.id]: v }))}
                          label={isWorking ? `${d.name} (also working repo)` : d.name}
                          sublabel={`owner: ${d.owner} · token ${d.tokenMask}${d.branch ? ` · branch ${d.branch}` : ""}${isWorking ? " · sprint already commits here via git CLI" : ""}`}
                        />
                      );
                    })}
                    {/* hiddenCount is 0 since the working-repo filter was
                        removed — kept the binding for future re-introduction
                        if operators ask for it back. */}
                  </div>
                );
              })()}

              {selectedDestIds.size > 0 && gitStatus && (
                <div style={{
                  padding: "7px 10px", borderRadius: 7, fontSize: 11, lineHeight: 1.6,
                  display: "flex", alignItems: "flex-start", gap: 7, marginBottom: 10,
                  background: gitStatus.exists === true  ? "rgba(28,191,107,0.08)"
                            : gitStatus.exists === false ? "rgba(107,122,158,0.08)"
                            : "rgba(254,188,43,0.08)",
                  border: `1px solid ${gitStatus.exists === true  ? "rgba(28,191,107,0.25)"
                                      : gitStatus.exists === false ? "rgba(107,122,158,0.2)"
                                      : "rgba(254,188,43,0.25)"}`,
                  color: gitStatus.exists === true  ? "var(--green)"
                       : gitStatus.exists === false ? "var(--subtext0)"
                       : "var(--yellow)",
                }}>
                  <GitBranch size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    {gitStatus.exists === true  && <>Repo <code style={{ fontFamily: "monospace" }}>{gitStatus.repoName}</code> found — will be cloned automatically on first sprint.</>}
                    {gitStatus.exists === false && <>Repo <code style={{ fontFamily: "monospace" }}>{gitStatus.repoName}</code> does not exist — will be created on first Push.</>}
                    {gitStatus.exists === null  && <>Check against the global destination only.</>}
                  </span>
                </div>
              )}

              {selectedDestIds.size > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <label style={labelStyle}>Branch name</label>
                  <input
                    value={githubBranch}
                    onChange={(e) => setGithubBranch(e.target.value)}
                    placeholder="main"
                    style={{ ...ss, width: "100%", maxWidth: 240 }}
                  />
                  <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 3 }}>
                    Defaults to <code style={{ fontFamily: "monospace" }}>main</code>. Per-destination overrides (set in Factory Manager) take precedence.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── 4. CLI Agents (only when orchMode is a local-ish mode) ──────── */}
          {(orchMode === "local" || orchMode === "local-git") && (
            <>
              <SectionHeader id="cli" title="CLI Agents" icon={<Terminal size={14} color="var(--green)" />} collapsed={collapsed.cli ?? false} onToggle={() => toggleSection("cli")}
                badge={<a href="/providers" target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                  style={{ fontSize: 10, color: "var(--blue)", textDecoration: "none", display: "flex", alignItems: "center", gap: 3 }}>
                  <ExternalLink size={10} /> Providers
                </a>}
              />
              {!collapsed.cli && (
                <div style={{ paddingLeft: 8, display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>

                  {/* Base path / Repository / Auto-push moved to the
                      Orchestration / Storage Mode section above (those are
                      storage-layer concerns; CLI Agents owns CLI runtime). */}

                  {/* Prepare workspace — materialises the agent scaffold
                      (CLAUDE.md, .claude/agents/, .mcp.json) at the
                      project's local working dir so the operator can
                      run claude-code manually without dispatching a
                      pipeline. Only meaningful for local / local-git. */}
                  {/* Parent conditional already gates this on
                      orchMode ∈ {local, local-git}; the cloud-disabled
                      branch is dead code here. */}
                  <PrepareWorkspaceButton
                    projectId={project.id}
                    disabled={false}
                    requiresRepoUrl={
                      orchMode === "local-git"
                      && !workingDestId.trim()
                      && !(useOperatorGitAuth && repoUrl.trim())
                    }
                    authToken={authSession?.access_token}
                  />

                  {/* MCP server toggle */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--subtext0)", width: 100, flexShrink: 0 }}>MCP server</span>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11 }}>
                      <input type="checkbox" checked={cliMcpEnabled} onChange={(e) => setCliMcpEnabled(e.target.checked)}
                        style={{ width: 13, height: 13, accentColor: "var(--blue)" }} />
                      Expose {brand.shortName} tools to MCP-capable CLIs
                    </label>
                  </div>

                  {/* Hooks toggle */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--subtext0)", width: 100, flexShrink: 0 }}>Hooks</span>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 11 }}>
                      <input type="checkbox" checked={cliHooksEnabled} onChange={(e) => setCliHooksEnabled(e.target.checked)}
                        style={{ width: 13, height: 13, accentColor: "var(--blue)" }} />
                      Install PreToolUse / PostToolUse / Stop hooks
                    </label>
                    <span style={{ fontSize: 10, color: "var(--overlay0)" }}>Claude Code only</span>
                  </div>

                  {/* Auto-compose toggle — execution sprints try the
                      pipeline-composer's most recent valid proposal before
                      falling back to the project pipeline. Discovery
                      pipelines unaffected. */}
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--subtext0)", width: 100, flexShrink: 0, paddingTop: 1 }}>Auto-compose</span>
                    <label style={{ display: "flex", alignItems: "flex-start", gap: 6, cursor: "pointer", fontSize: 11, lineHeight: 1.5 }}>
                      <input type="checkbox" checked={cliAutoCompose} onChange={(e) => setCliAutoCompose(e.target.checked)}
                        style={{ width: 13, height: 13, accentColor: "var(--blue)", marginTop: 2 }} />
                      <span>
                        Use last pipeline-composer proposal for execution sprints
                        <span style={{ display: "block", fontSize: 10, color: "var(--overlay0)", lineHeight: 1.4, marginTop: 2 }}>
                          When on, the next execution sprint reads <code>composed_pipeline</code> from the most recent discovery sprint and uses it instead of <code>project.pipeline</code>. Validates agent slugs first; falls back to default on missing agents.
                        </span>
                      </span>
                    </label>
                  </div>

                  {/* Default CLI tool */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--subtext0)", width: 100, flexShrink: 0 }}>Default CLI</span>
                    <select value={cliDefaultCli} onChange={(e) => setCliDefaultCli(e.target.value as SupportedCli | "")}
                      style={{ ...inputStyle, padding: "5px 8px", fontSize: 11, height: 28, width: 160 }}>
                      <option value="">— pick a CLI —</option>
                      {CLI_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}{opt.status === "experimental" ? " (experimental)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Default max turns */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "var(--subtext0)", width: 100, flexShrink: 0 }}>Default turns</span>
                    <input type="number" value={cliDefaultMaxTurns} onChange={(e) => setCliDefaultMaxTurns(e.target.value)}
                      placeholder="1"
                      style={{ ...inputStyle, padding: "5px 8px", fontSize: 11, height: 28, width: 80 }} />
                    <span style={{ fontSize: 10, color: "var(--overlay0)" }}>Max turns per agent (default: 1)</span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── 4. Agent Configuration (unified table) ────────────────── */}
          <SectionHeader id="agents" title="Agent Configuration" icon={<Sparkles size={14} color="var(--yellow)" />} collapsed={collapsed.agents ?? false} onToggle={() => toggleSection("agents")} />
          {!collapsed.agents && (
            <div style={{ marginBottom: 14 }}>
              {Object.keys(agentCfgs).length === 0 && pipelineAgents.length === 0 && (
                <div style={{ fontSize: 12, color: "var(--overlay0)", padding: "8px 0 12px" }}>
                  Select a pipeline above to see its agents here.
                </div>
              )}

              {/* Unified agent rows */}
              {(pipelineAgents.length > 0 ? pipelineAgents : Object.keys(agentCfgs)).map((agentName) => {
                const cfg = agentCfgs[agentName] ?? emptyAgentCfg();
                const override = cliOverrides[agentName];
                // Default routing follows the orchestration mode when the
                // agent has no explicit override yet — local / local-git
                // projects naturally want CLI SUBS (operator's coding-CLI
                // subscription), cloud wants API. Operators in local mode
                // shouldn't have to flip every agent manually.
                const isLocalish = orchMode === "local" || orchMode === "local-git";
                const hasOverride = override !== undefined;
                const usesCli = hasOverride ? override.enabled === true : isLocalish;
                const routingMode = !usesCli
                  ? "api"
                  : hasOverride
                    ? (override.authMode === "oauth" ? "cli-subs" : "cli-api")
                    : (isLocalish ? "cli-subs" : "cli-api");
                const isApiExpanded = expandedAgent === agentName;
                const isCliExpanded = expandedCliAgent === agentName;
                const activeCli = override?.cli ?? cliDefaultCli ?? "claude-code";
                const active = !cfg.disabled && hasOverrides(cfg);

                return (
                  <div key={agentName} style={{ marginBottom: 6, borderRadius: 10, overflow: "hidden",
                    border: `1px solid ${active ? "rgba(20,99,255,0.3)" : usesCli ? "rgba(166,227,161,0.2)" : "var(--surface1)"}`,
                    background: active ? "rgba(20,99,255,0.04)" : usesCli ? "rgba(166,227,161,0.04)" : "var(--surface0)",
                  }}>
                    {/* Row header */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px" }}>
                      <code style={{ fontSize: 11, fontWeight: 700, color: active ? "#1463ff" : "var(--text)", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {agentName}
                      </code>

                      {/* Pipeline provenance — small pills indicating which
                          pipeline(s) include this agent. Operators tuning a
                          per-agent override should see whether they're
                          affecting discovery, execution, or both. */}
                      <div style={{ display: "flex", gap: 3, flex: 1, minWidth: 0, overflow: "hidden" }}>
                        {(agentPipelineMap[agentName] ?? []).map((scope) => {
                          const meta =
                            scope === "default"   ? { label: "default",   bg: "rgba(108,112,134,0.15)", fg: "var(--overlay1, #6b7a9e)" } :
                            scope === "discovery" ? { label: "discovery", bg: "rgba(203,166,247,0.15)", fg: "var(--mauve, #cba6f7)"   } :
                                                    { label: "execution", bg: "rgba(28,191,107,0.15)",  fg: "var(--green, #40a02b)" };
                          return (
                            <span key={scope} title={`Used in ${scope} pipeline`} style={{
                              fontSize: 9, padding: "1px 5px", borderRadius: 3, fontWeight: 700,
                              background: meta.bg, color: meta.fg,
                              textTransform: "uppercase", letterSpacing: "0.04em",
                              flexShrink: 0,
                            }}>
                              {meta.label}
                            </span>
                          );
                        })}
                      </div>

                      {/* Routing: API / CLI API / CLI SUBS */}
                      <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1px solid var(--surface1)", flexShrink: 0 }}>
                        {([
                          { id: "api" as const,      label: "API",      color: "#1463ff", bg: "rgba(20,99,255,0.15)", disabled: false },
                          { id: "cli-api" as const,  label: "CLI API",  color: "var(--green)", bg: "rgba(166,227,161,0.18)", disabled: true },
                          { id: "cli-subs" as const, label: "CLI SUBS", color: "var(--yellow)", bg: "rgba(249,226,175,0.18)", disabled: orchMode === "cloud" },
                        ]).map((opt, i) => (
                          <button key={opt.id} title={opt.id === "cli-api" ? "Coming soon" : opt.disabled ? "Switch to Local orchestration to enable" : undefined}
                            onClick={() => {
                              if (opt.disabled) return;
                              if (opt.id === "api") { setCliAgentEnabled(agentName, false); }
                              else { setCliAgentEnabled(agentName, true); setCliAgentField(agentName, "authMode", opt.id === "cli-subs" ? "oauth" : "api-key"); }
                            }} style={{
                              padding: "3px 8px", fontSize: 10, fontWeight: routingMode === opt.id ? 700 : 400,
                              background: routingMode === opt.id ? opt.bg : "transparent",
                              color: opt.disabled ? "var(--surface2)" : routingMode === opt.id ? opt.color : "var(--overlay0)",
                              border: "none", borderLeft: i > 0 ? "1px solid var(--surface1)" : "none",
                              cursor: opt.disabled ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)",
                              opacity: opt.disabled ? 0.5 : 1,
                            }}>{opt.label}</button>
                        ))}
                      </div>

                      {/* Config button */}
                      <button onClick={() => {
                        if (routingMode === "cli-subs") { setExpandedCliAgent(isCliExpanded ? null : agentName); setExpandedAgent(null); }
                        else if (routingMode === "api") { setExpandedAgent(isApiExpanded ? null : agentName); setExpandedCliAgent(null); }
                      }} title="Configure agent"
                        style={{ background: "none", border: "none", cursor: routingMode === "cli-api" ? "not-allowed" : "pointer", color: "var(--overlay0)", padding: "2px 4px", flexShrink: 0, opacity: routingMode === "cli-api" ? 0.3 : 1 }}
                        disabled={routingMode === "cli-api"}
                      >
                        <Settings size={12} />
                      </button>
                    </div>

                    {/* Expanded API config */}
                    {routingMode === "api" && isApiExpanded && (
                      <div style={{ padding: "0 12px 12px", borderTop: "1px solid var(--surface1)" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10, marginBottom: 8 }}>
                          <div>
                            <label style={{ ...labelStyle, marginBottom: 4 }}>Provider</label>
                            <ProviderSelect value={cfg.provider} onChange={(v) => { setAgentField(agentName, "provider", v); setAgentField(agentName, "model", ""); }} style={ss} providers={liveProviders} />
                          </div>
                          <div>
                            <label style={{ ...labelStyle, marginBottom: 4 }}>Model</label>
                            <ModelSelect provider={cfg.provider} value={cfg.model} onChange={(v) => setAgentField(agentName, "model", v)} style={ss} providers={liveProviders} />
                          </div>
                          <div>
                            <label style={{ ...labelStyle, marginBottom: 4 }}>Max tool rounds</label>
                            <input value={cfg.max_tool_rounds} onChange={(e) => setAgentField(agentName, "max_tool_rounds", e.target.value)} placeholder="e.g. 15" type="number" style={ss} />
                          </div>
                          <div>
                            <label style={{ ...labelStyle, marginBottom: 4 }}>Timeout (ms)</label>
                            <input value={cfg.timeout_ms} onChange={(e) => setAgentField(agentName, "timeout_ms", e.target.value)} placeholder="e.g. 300000" type="number" style={ss} />
                          </div>
                          <div>
                            <label style={{ ...labelStyle, marginBottom: 4 }}>Max tokens</label>
                            <input value={cfg.max_tokens} onChange={(e) => setAgentField(agentName, "max_tokens", e.target.value)} placeholder="e.g. 8192" type="number" style={ss} />
                          </div>
                          <div style={{ display: "flex", alignItems: "flex-end" }}>
                            <button onClick={() => removeAgent(agentName)} style={{ width: "100%", padding: "6px", borderRadius: 7, border: "1px solid rgba(228,75,95,0.3)", background: "rgba(228,75,95,0.08)", color: "var(--red)", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                              Remove overrides
                            </button>
                          </div>
                        </div>
                        <div>
                          <label style={{ ...labelStyle, marginBottom: 4 }}>Agent-specific guidelines</label>
                          <textarea value={cfg.guidelines} onChange={(e) => setAgentField(agentName, "guidelines", e.target.value)}
                            placeholder="Extra instructions appended to this agent's system prompt…"
                            rows={2} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, fontSize: 12 }} />
                        </div>
                      </div>
                    )}

                    {/* Expanded CLI SUBS config */}
                    {routingMode === "cli-subs" && isCliExpanded && (
                      <div style={{ padding: "8px 12px 10px", borderTop: "1px solid var(--surface0)", display: "flex", flexDirection: "column", gap: 7 }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                          <div style={{ width: 140 }}>
                            <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>CLI</label>
                            <select value={activeCli} onChange={(e) => setCliAgentField(agentName, "cli", e.target.value as SupportedCli)}
                              style={{ ...inputStyle, padding: "4px 7px", fontSize: 11, height: 26, width: "100%" }}>
                              {(["claude-code", "aider", "codex", "plandex", "goose", "amp", "gemini-cli"] as SupportedCli[]).map((c) => (
                                <option key={c} value={c}>{c}</option>
                              ))}
                            </select>
                          </div>
                          <div style={{ width: 80 }}>
                            <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Turns</label>
                            <input type="number" value={override?.max_turns ?? ""} onChange={(e) => setCliAgentField(agentName, "max_turns", e.target.value ? Number(e.target.value) : undefined as unknown as number)}
                              placeholder="1"
                              style={{ ...inputStyle, padding: "4px 7px", fontSize: 11, height: 26, width: "100%" }} />
                          </div>
                          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11, paddingBottom: 4 }}>
                            <input type="checkbox" checked={cliMcpEnabled} onChange={(e) => setCliMcpEnabled(e.target.checked)}
                              style={{ width: 12, height: 12, accentColor: "var(--blue)" }} />
                            MCP
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", fontSize: 11, paddingBottom: 4 }}>
                            <input type="checkbox" checked={cliHooksEnabled} onChange={(e) => setCliHooksEnabled(e.target.checked)}
                              style={{ width: 12, height: 12, accentColor: "var(--blue)" }} />
                            Hooks
                          </label>
                        </div>
                        {/* BL-26 Phase 4 — pick a factory harness preset to
                          *  apply UNDER this override. Only renders when the
                          *  factory has at least one preset configured. The
                          *  override's own fields (CLI/Turns above) still
                          *  take precedence over preset values. */}
                        {harnessPresets.length > 0 && (
                          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                            <div style={{ flex: 1 }}>
                              <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>
                                Harness preset
                                <span style={{ marginLeft: 6, color: "var(--overlay0)", fontWeight: 400 }}>· merged under fields above</span>
                              </label>
                              <select
                                value={override?.harness_preset_id ?? ""}
                                onChange={(e) => setCliAgentField(agentName, "harness_preset_id", e.target.value || (undefined as unknown as string))}
                                style={{ ...inputStyle, padding: "4px 7px", fontSize: 11, height: 26, width: "100%" }}
                              >
                                <option value="">(none — use override only)</option>
                                {harnessPresets.map((p) => (
                                  <option key={p.id} value={p.id}>{p.name} · @{p.slug}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Add agent from pipeline dropdown */}
              {pipelineAgents.filter((a) => !agentCfgs[a]).length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const name = e.target.value;
                      if (!name) return;
                      setAgentCfgs((prev) => ({ ...prev, [name]: emptyAgentCfg() }));
                      setExpandedAgent(name);
                      e.target.value = "";
                    }}
                    style={{ ...ss, width: "100%", color: "var(--subtext0)" }}
                  >
                    <option value="">+ Add agent override…</option>
                    {pipelineAgents.filter((a) => !agentCfgs[a]).map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* ── 5. CAG — Context-Augmented Generation ─────────────── */}
          <SectionHeader id="cag" title="CAG — Context-Augmented Generation" icon={<Brain size={14} color="var(--peach)" />} collapsed={collapsed.cag ?? false} onToggle={() => toggleSection("cag")} />
          {!collapsed.cag && (
            <div style={{ marginBottom: 14, display: "flex", flexDirection: "column", gap: 14 }}>

              <div style={divider} />

              {/* DNA Context */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <label style={labelStyle}>DNA Context</label>
                  <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
                    Inject factory DNA (stack, standards, identity) into agent briefings. Disable for standalone projects.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setUseDna((v: boolean) => !v)}
                  style={{
                    flexShrink: 0, background: "none", border: "none", cursor: "pointer", padding: 0,
                    color: useDna ? "var(--green)" : "var(--overlay0)",
                  }}
                >
                  {useDna ? "●  On" : "○  Off"}
                </button>
              </div>

              <div style={divider} />

              {/* AI Focus Mode */}
              <div>
                <label style={labelStyle}>AI Focus Mode</label>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {(["speed", "balanced", "quality"] as FocusMode[]).map((f) => (
                    <button key={f} onClick={() => applyAutoConfig(f)} style={{
                      padding: "9px 8px", borderRadius: 9, cursor: "pointer", fontFamily: "var(--font-sans)",
                      border: `1.5px solid ${focus === f ? "rgba(20,99,255,0.5)" : "var(--surface1)"}`,
                      background: focus === f ? "rgba(20,99,255,0.08)" : "var(--surface0)",
                      color: focus === f ? "#1463ff" : "var(--subtext0)", fontSize: 12, fontWeight: 600,
                    }}>
                      {f === "speed" ? "⚡ Low" : f === "balanced" ? "⚖️ Balanced" : "🔬 High"}
                    </button>
                  ))}
                </div>
              </div>

              <div style={divider} />

              {/* Guidelines (legacy — Skills with category='guideline' are
                 token-efficient and structured; this textarea is always
                 loaded into every agent's persona). */}
              <div>
                <label style={labelStyle}>
                  Guidelines{" "}
                  <span style={{ fontWeight: 400, color: "var(--overlay0)" }}>(legacy — prefer Skills with category=guideline)</span>
                </label>
                <textarea value={guidelines} onChange={(e) => setGuidelines(e.target.value)}
                  placeholder="e.g. Always use TypeScript strict mode. Prefer functional components. Target Node 22."
                  rows={3} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} />
              </div>
            </div>
          )}

          {/* ── 5b. Skills (project-specific, Phase 5 Slice A) ─────── */}
          <SectionHeader id="skills" title="Skills" icon={<Sparkles size={14} color="var(--mauve)" />}
            collapsed={collapsed.skills ?? false} onToggle={() => toggleSection("skills")}
          />
          {!collapsed.skills && (
            <div style={{ marginBottom: 14 }}>
              <SkillsSection
                factoryId={project.factory_id ?? ""}
                projectId={project.id}
                canWrite={true}
                hideTitle
              />
            </div>
          )}

          {/* ── 6. RAG — Retrieval-Augmented Generation ────────────── */}
          <SectionHeader id="rag" title="RAG — Retrieval-Augmented Generation" icon={<Brain size={14} color="var(--mauve)" />}
            collapsed={collapsed.rag ?? false} onToggle={() => toggleSection("rag")}
            badge={knowledgeInstances.filter((i) => i.enabled).length > 0
              ? <span style={{ fontSize: 10, color: "var(--green)" }}>{knowledgeInstances.filter((i) => i.enabled).length} active</span>
              : undefined}
          />
          {!collapsed.rag && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 10 }}>
                Link knowledge instances to this project. Agents will search linked instances during sprints.
                <a href="/knowledge" target="_blank" rel="noreferrer" style={{ color: "var(--blue)", textDecoration: "none", marginLeft: 6 }}>
                  Manage instances <ExternalLink size={9} style={{ verticalAlign: "middle" }} />
                </a>
              </div>

              {!knowledgeLoaded ? (
                <div style={{ fontSize: 12, color: "var(--overlay0)" }}>Loading...</div>
              ) : knowledgeInstances.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--overlay0)", padding: "12px", background: "var(--crust)", borderRadius: 8, textAlign: "center" }}>
                  No knowledge instances available.{" "}
                  <a href="/knowledge" target="_blank" rel="noreferrer" style={{ color: "var(--blue)", textDecoration: "none" }}>
                    Create one first.
                  </a>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {knowledgeInstances.map((inst) => (
                    <div key={inst.id} style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "7px 10px", borderRadius: 6,
                      background: inst.enabled ? "rgba(203,166,247,0.06)" : "var(--crust)",
                      border: `1px solid ${inst.enabled ? "rgba(203,166,247,0.2)" : "var(--surface0)"}`,
                    }}>
                      <button type="button"
                        onClick={() => setKnowledgeInstances((prev) =>
                          prev.map((i) => i.id === inst.id ? { ...i, enabled: !i.enabled } : i)
                        )}
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: inst.enabled ? "var(--mauve)" : "var(--overlay0)", fontSize: 14 }}>
                        {inst.enabled ? "●" : "○"}
                      </button>
                      <span style={{ flex: 1, fontSize: 12, color: "var(--text)", fontWeight: inst.enabled ? 600 : 400 }}>{inst.name}</span>
                      <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{inst.chunkCount} chunks</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── 8. Budget & Limits ────────────────────────────────────── */}
          <SectionHeader id="budget" title="Budget & Limits" icon={<AlertTriangle size={14} color="var(--peach)" />} collapsed={collapsed.budget ?? false} onToggle={() => toggleSection("budget")} />
          {!collapsed.budget && (
            <div style={{ marginBottom: 14 }}>
              <div style={grid2}>
                <div>
                  <label style={labelStyle}>Budget cap (USD)</label>
                  <input value={budget}  onChange={(e) => setBudget(e.target.value)}   placeholder="e.g. 5.00"    type="number" step="0.01"  style={ss} />
                </div>
                <div>
                  <label style={labelStyle}>Agent timeout (ms)</label>
                  <input value={timeout} onChange={(e) => setTimeout_(e.target.value)} placeholder="e.g. 600000" type="number" step="1000" style={ss} />
                </div>
              </div>
            </div>
          )}

          {/* ── 9. Monitoring ─────────────────────────────────────────── */}
          <SectionHeader id="monitoring" title="Monitoring" icon={<Search size={14} color="var(--blue)" />} collapsed={collapsed.monitoring ?? false} onToggle={() => toggleSection("monitoring")} />
          {!collapsed.monitoring && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 10 }}>
                <div>
                  <div style={labelStyle}>Detailed monitoring</div>
                  <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
                    Emit DB events per tool-call round for the live execution log.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailedMonitoring((v: boolean) => !v)}
                  style={{
                    flexShrink: 0, background: "none", border: "none", cursor: "pointer", padding: 0,
                    color: detailedMonitoring ? "var(--green)" : "var(--overlay0)",
                  }}
                >
                  {detailedMonitoring ? "●  On" : "○  Off"}
                </button>
              </div>
              <div>
                <label style={labelStyle}>On human rejection</label>
                <select value={onReject} onChange={(e) => setOnReject(e.target.value as OnRejection)} style={ss}>
                  <option value="end_sprint">End sprint (default)</option>
                  <option value="retry_once">Retry agent once</option>
                  <option value="skip">Skip step and continue</option>
                  <option value="request_instructions">Pause and request instructions</option>
                </select>
              </div>
            </div>
          )}

          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, background: "rgba(228,75,95,0.1)", border: "1px solid rgba(228,75,95,0.3)", color: "var(--red)", fontSize: 13, marginTop: 10 }}>
              <AlertTriangle size={13} /> {error}
            </div>
          )}
        </div>

        {/* Sticky footer — only in modal mode */}
        {!inline && (
          <div style={{ padding: "12px 20px", borderTop: "1px solid var(--surface0)", display: "flex", gap: 10, position: "sticky", bottom: 0, background: "var(--mantle)" }}>
            <button onClick={onClose} style={{ padding: "9px 18px", borderRadius: 9, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "9px", borderRadius: 9, border: "none", background: "#1463ff", color: "#fff", fontSize: 13, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1, fontFamily: "var(--font-sans)" }}>
              {saving ? <><RefreshCw size={13} style={{ animation: "spin 1s linear infinite" }} /> Saving…</> : "Save settings"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Button that triggers the `prepare-workspace` worker task.
 *
 * Materialises CLAUDE.md, `.claude/agents/`, `.mcp.json`,
 * `.tp/mcp-secrets.json` into the project's local working dir so the
 * operator can launch claude-code there without dispatching a pipeline.
 *
 * Disabled for cloud mode (no local dir). Disabled for local-git when
 * repo_url is missing (worker would refuse anyway — fail fast in UI).
 */
function PrepareWorkspaceButton({
  projectId,
  disabled,
  requiresRepoUrl,
  authToken,
}: {
  projectId:       string;
  disabled:        boolean;
  requiresRepoUrl: boolean;
  authToken:       string | undefined;
}) {
  const [busy,    setBusy]    = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const blocked = disabled || requiresRepoUrl || !authToken;
  const blockedReason =
    disabled        ? "Cloud projects don't have a local working tree."
  : requiresRepoUrl ? "Set the Repository URL above first."
  : !authToken      ? "Sign in to dispatch."
                    : "";

  async function trigger() {
    if (blocked) return;
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/prepare-workspace`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      });
      const body = await res.json() as { ok?: boolean; message?: string; error?: string };
      if (!res.ok) {
        setMessage({ kind: "err", text: body.error ?? "Prepare workspace failed." });
      } else {
        setMessage({ kind: "ok", text: body.message ?? "Workspace preparation dispatched." });
      }
    } catch (e) {
      setMessage({ kind: "err", text: (e as Error).message ?? "Network error." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        onClick={trigger}
        disabled={blocked || busy}
        title={blocked ? blockedReason : "Materialise CLAUDE.md, .claude/agents/, .mcp.json at the project's working dir without dispatching a pipeline."}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          padding: "8px 12px", borderRadius: 8,
          border: "1px solid var(--surface1)",
          background: blocked || busy ? "var(--surface0)" : "rgba(20,99,255,0.08)",
          color: blocked ? "var(--overlay0)" : "var(--blue, #1463ff)",
          fontSize: 12, fontWeight: 600,
          cursor: blocked || busy ? "not-allowed" : "pointer",
          opacity: blocked || busy ? 0.6 : 1,
          fontFamily: "var(--font-sans)",
          alignSelf: "flex-start",
        }}
      >
        {busy ? <RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> : <FolderOpen size={12} />}
        Prepare workspace
      </button>
      {message && (
        <div style={{
          fontSize: 11, lineHeight: 1.5,
          color: message.kind === "ok" ? "var(--green)" : "var(--red, #d20f39)",
        }}>
          {message.text}
        </div>
      )}
      {blocked && !message && (
        <div style={{ fontSize: 10, color: "var(--overlay0)", lineHeight: 1.5 }}>
          {blockedReason}
        </div>
      )}
    </div>
  );
}

/** Row for a single destination choice inside the project settings modal. */
function DestCheckbox({
  checked, onChange, label, sublabel, autoPush, onAutoPushChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  sublabel: string;
  autoPush: boolean;
  onAutoPushChange: (v: boolean) => void;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 10px", borderRadius: 7,
      background: checked ? "rgba(20,99,255,0.06)" : "var(--surface0)",
      border: `1px solid ${checked ? "rgba(20,99,255,0.3)" : "var(--surface1)"}`,
      fontFamily: "var(--font-sans)",
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 14, height: 14, accentColor: "var(--blue)", flexShrink: 0, cursor: "pointer" }}
      />
      <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => onChange(!checked)}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--subtext0)", fontFamily: "var(--font-mono)" }}>{sublabel}</div>
      </div>
      {/* Per-destination auto-push toggle. Disabled when the destination
          itself isn't selected — auto-push only makes sense for active
          destinations. */}
      <label
        title={checked
          ? "Push to this destination automatically at sprint end"
          : "Select this destination first to enable auto-push"}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          fontSize: 10, color: !checked ? "var(--overlay0)" : autoPush ? "var(--green)" : "var(--subtext0)",
          fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
          cursor: checked ? "pointer" : "not-allowed",
          opacity: checked ? 1 : 0.4,
          flexShrink: 0,
        }}
      >
        <input
          type="checkbox"
          checked={autoPush}
          disabled={!checked}
          onChange={(e) => onAutoPushChange(e.target.checked)}
          style={{ width: 12, height: 12, accentColor: "var(--green)", cursor: checked ? "pointer" : "not-allowed" }}
        />
        Auto-push
      </label>
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  fontSize: 10, padding: "1px 7px", borderRadius: 4,
  background: "rgba(20,99,255,0.12)", color: "#1463ff", fontWeight: 600,
};

/* ── ProjectCard + SprintRow imported from @/components/ProjectCard ─────────── */

// Section helper wraps ProjectCard list with a label
/* ── Section (module-level to preserve ProjectCard state across parent re-renders) */
function Section({ label, items, onDelete, onToggleLock, onEditSettings }: {
  label: string;
  items: Project[];
  onDelete: (p: Project) => void;
  onToggleLock: (p: Project) => void;
  onEditSettings: (p: Project) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--overlay0)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
        {label} <span style={{ fontSize: 10, background: "var(--surface1)", borderRadius: 99, padding: "0 5px", lineHeight: "16px", fontWeight: 400 }}>{items.length}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {items.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            onDelete={onDelete}
            onToggleLock={onToggleLock}
            onEditSettings={onEditSettings}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Main Projects Page ──────────────────────────────────────────────────────── */

export function ProjectsPageInner({ asPanel = false }: { asPanel?: boolean } = {}) {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const autoOpened   = useRef(false);
  const { session, tenantId, factoryId, factorySlug, loading: authLoading } = useAuth();
  const [projects,     setProjects]     = useState<Project[]>([]);
  const [pipelines,    setPipelines]    = useState<Pipeline[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [search,       setSearch]       = useState("");
  const [showNew,      setShowNew]      = useState(false);
  const [editSettings, setEditSettings] = useState<Project | null>(null);
  const [dataReady,    setDataReady]    = useState(false);

  useEffect(() => {
    if (asPanel) return; // Studio already handles auth guard
    if (!authLoading && !session) router.replace("/login");
  }, [asPanel, authLoading, session, router]);

  useEffect(() => {
    if (!factoryId || !tenantId || !session) return;

    // Load projects first — show page immediately
    fetch(`/api/projects?factoryId=${factoryId}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then(async (projRes) => {
        if (projRes.ok) { const b = await projRes.json() as { projects: Project[] }; setProjects(b.projects); }
        setLoading(false);
        setDataReady(true);
        if (!autoOpened.current && searchParams.get("pipeline")) {
          autoOpened.current = true;
          setShowNew(true);
        }
      });

    // Load pipelines for the project settings picker. The /api/pipelines
    // endpoint returns own customs + canonical pipelines this tenant
    // installed as refs (migration 171). Refs come back resolved with
    // the canonical row inlined (or null when the upstream was deleted).
    fetch(`/api/pipelines?tenantId=${tenantId}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then(async (pipeRes) => {
        if (pipeRes.ok) {
          const b = await pipeRes.json() as {
            system: Pipeline[];
            custom: Pipeline[];
            installed?: Array<{ install_id: string; listing_id: string; broken: boolean; pipeline: Pipeline | null }>;
          };
          const refs = (b.installed ?? [])
            .map((r) => r.pipeline)
            .filter((p): p is Pipeline => p !== null);
          setPipelines([...b.system, ...b.custom, ...refs]);
        }
      });
  }, [factoryId, tenantId, session, searchParams]);

  const filtered = projects.filter((p) =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.slug.includes(search.toLowerCase())
  );

  // Studio bucketing follows the simplified taxonomy (migration 160).
  // Sprint-side flags (paused/waiting/pending_save) live on the sprint
  // row and are surfaced inside the project detail, not here.
  const byStatus = {
    active: filtered.filter((p) => p.status === "running"),
    queued: filtered.filter((p) => p.status === "queued"),
    rest:   filtered.filter((p) => p.status !== "running" && p.status !== "queued"),
  };

  if (!dataReady) {
    return (
      <div style={{ display: "flex", height: asPanel ? "100%" : "100vh", alignItems: "center", justifyContent: "center", background: "var(--base)" }}>
        <div style={{ fontSize: 13, color: "var(--overlay0)" }}>Loading…</div>
      </div>
    );
  }

  async function handleDelete(project: Project) {
    if (project.locked) return;
    if (ACTIVE_STATUSES.includes(project.status as string)) return;
    const input = prompt(`Type "${project.slug}" to confirm deletion of this project, all sprints, and all artifacts:`);
    if (input !== project.slug) return;
    if (!session) return;
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (res.ok) {
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
    } else {
      const body = await res.json() as { error?: string };
      alert(body.error ?? "Failed to delete project.");
    }
  }

  async function handleToggleLock(project: Project) {
    if (!session) return;
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ locked: !project.locked }),
    });
    if (res.ok) {
      setProjects((prev) => prev.map((p) => p.id === project.id ? { ...p, locked: !p.locked } : p));
    }
  }

  return (
    <div style={{ display: "flex", height: asPanel ? "100%" : "100vh", background: "var(--base)", fontFamily: "var(--font-sans)", color: "var(--text)", overflow: "hidden", flex: asPanel ? 1 : undefined }}>
      {!asPanel && <AppSidebar active="projects" />}

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* List view */}
        <div style={{ flex: 1, overflowY: "auto", display: (showNew || editSettings) ? "none" : "block" }}>
        <div style={{ maxWidth: 920, margin: "0 auto", padding: "28px 24px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Projects</h2>
              <p style={{ fontSize: 13, color: "var(--subtext0)" }}>
                {loading ? "Loading…" : `${projects.length} projects · each pipeline run = one sprint`}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ position: "relative" }}>
                <Search size={13} color="var(--overlay0)" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter projects…"
                  style={{ ...inputStyle, padding: "7px 10px 7px 30px", width: 200, fontSize: 12 }} />
              </div>
              <button
                onClick={() => setShowNew(true)}
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 16px", borderRadius: 9, border: "none", background: "#1463ff", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)", whiteSpace: "nowrap" }}
              >
                <Plus size={14} /> New project
              </button>
            </div>
          </div>

          <div>
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, color: "var(--overlay0)", fontSize: 13 }}>Loading projects…</div>
          ) : projects.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, gap: 16, color: "var(--overlay0)" }}>
              <FolderOpen size={40} />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>No projects yet</div>
                <p style={{ fontSize: 13, margin: 0 }}>Create your first project to start running pipelines.</p>
              </div>
              <button onClick={() => setShowNew(true)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, border: "none", background: "#1463ff", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                <Plus size={14} /> New project
              </button>
            </div>
          ) : (
            <>
              <Section label="Active" items={byStatus.active} onDelete={handleDelete} onToggleLock={handleToggleLock} onEditSettings={(proj) => setEditSettings(proj)} />
              <Section label="In Office" items={byStatus.queued} onDelete={handleDelete} onToggleLock={handleToggleLock} onEditSettings={(proj) => setEditSettings(proj)} />
              {byStatus.rest.map((p) => (
                <ProjectCard key={p.id} project={p} onDelete={handleDelete} onToggleLock={handleToggleLock} onEditSettings={(proj) => setEditSettings(proj)} />
              ))}
              {filtered.length === 0 && projects.length > 0 && (
                <div style={{ textAlign: "center", padding: 32, color: "var(--overlay0)", fontSize: 13 }}>No results for "{search}"</div>
              )}
            </>
          )}
          </div>
        </div>
        </div>{/* end list view */}

        {/* Inline: New Project */}
        {showNew && factoryId && (
          <NewProjectModal
            factoryId={factoryId}
            factorySlug={factorySlug ?? ""}
            onClose={() => setShowNew(false)}
            onCreated={(p) => { setProjects((prev) => [p, ...prev]); setShowNew(false); }}
            onOpenSettings={(p) => { setShowNew(false); setEditSettings(p); }}
            inline
          />
        )}

        {/* Inline: Project Settings */}
        {editSettings && (
          <ProjectSettingsModal
            project={editSettings as Project & { settings?: ProjectSettings }}
            pipelines={pipelines}
            onClose={() => setEditSettings(null)}
            onSaved={(p) => {
              setProjects((prev) => prev.map((x) => x.id === p.id ? p : x));
              setEditSettings(null);
            }}
            inline
          />
        )}
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <React.Suspense fallback={<div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", background: "var(--base)", color: "var(--overlay0)", fontSize: 13 }}>Loading…</div>}>
      <ProjectsPageInner />
    </React.Suspense>
  );
}
