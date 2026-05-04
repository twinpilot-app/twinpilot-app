"use client";

import React, { useEffect, useRef, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";
import type { Project, AgentRun, SprintRunOverrides, SprintIntent } from "@/lib/types";
import { CLI_OPTIONS } from "@/lib/types";
import ReviewSprintModal from "@/components/ReviewSprintModal";
import type { Session } from "@supabase/supabase-js";
import InfraMonitor from "@/components/InfraMonitor";
import AgentCatalog from "@/components/AgentCatalog";
// SipocCanvas removed — SIPOC contracts live in pipelines now
import AppSidebar from "@/components/AppSidebar";
import ProjectCanvas from "@/components/ProjectCanvas";
import { SprintRow, type Sprint as SharedSprint } from "@/components/ProjectCard";
import {
  LayoutDashboard, Server, Users, Workflow,
  Plus, Play, SkipForward, X, Zap, Clock, FolderOpen, Cloud,
  AlertTriangle, Loader2, RefreshCw, GitBranch, RotateCcw,
  Pause, ChevronDown, ChevronRight, CheckCircle2, Circle, XCircle,
  Download, Trash2, FileText, ExternalLink, Pencil, HelpCircle, Bot, Layers,
  SlidersHorizontal, Sparkles,
} from "lucide-react";

/* ─── Local DB type (supabase returns more fields than the shared type) ─── */
type DBProject = Project & {
  sprint_count?: number;
  intake_brief?: string | null;
  last_error?: string | null;
  mode?: string;
};

/* ─── Provider catalogue for StartSprintModal ───────── */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google",
  mistral: "Mistral", perplexity: "Perplexity", xai: "xAI",
  deepseek: "DeepSeek", qwen: "Qwen",
};
interface LiveProvider { id: string; models: { id: string; name: string }[] }

/* ─── Queue status sets ─────────────────────────────────────────────
 * After the project-status simplification (migration 160) projects only
 * carry idle / queued / running / locked. Sprints own paused / waiting /
 * pending_save / completed / failed / cancelled. The Office still shows
 * a project in the queue when its latest sprint is paused or waiting on
 * a save, so we union the project-side states with the sprint-side
 * "needs attention" states.
 */
const QUEUE_PROJECT_STATUSES = new Set(["queued", "running"]);
const QUEUE_SPRINT_STATUSES  = new Set(["paused", "waiting", "pending_save"]);

/* ─── Views ──────────────────────────────────────────── */
type View = "queue" | "squads" | "infra";

const NAV_ITEMS: { id: View; icon: React.FC<{ size?: number }>; label: string }[] = [
  { id: "queue",  icon: LayoutDashboard, label: "Office" },
  { id: "squads", icon: Users,           label: "Squads" },
  // SIPOC Map removed
  { id: "infra",  icon: Server,          label: "Infrastructure" },
];

/* ─── Responsive hook ────────────────────────────────── */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

/* ─── Status helpers ─────────────────────────────────── */
const STATUS_COLOR: Record<string, string> = {
  provisioning: "#6b7a9e", ready: "#10b981", executing: "#1463ff",
  waiting: "#f59f00", completed: "#00c2a8", paused: "#f59f00",
  cancelled: "#6b7a9e", failed: "#e44b5f", queued: "#6b7a9e", running: "#1463ff",
  pending_save: "#f59f00",
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "#6b7a9e";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em",
      padding: "2px 8px", borderRadius: 99,
      background: `${color}18`, color,
    }}>
      {status}
    </span>
  );
}

/* ─── Main ───────────────────────────────────────────── */
export default function Home() {
  const router = useRouter();
  const { session, factoryId, loading: authLoading, factories } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("queue");
  const [runsMap, setRunsMap] = useState<Map<string, AgentRun[]>>(new Map());
  const isMobile = useIsMobile();
  // Tracks IDs of projects belonging to this factory — used to scope Realtime callbacks.
  const projectIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!authLoading && !session) {
      if (brand.urls.landing) window.location.href = brand.urls.landing;
      else router.replace("/login");
    }
  }, [authLoading, session, router]);

  // Redirect to factory settings if user has no factories
  useEffect(() => {
    if (!authLoading && session && (!factoryId || factories.length === 0)) {
      router.replace("/factory-settings");
    }
  }, [authLoading, session, factories, router]);

  useEffect(() => {
    if (!authLoading && !factoryId && session) setLoading(false);
  }, [authLoading, factoryId, session]);

  useEffect(() => {
    if (!factoryId) return;
    async function fetchProjects() {
      const { data } = await supabase
        .from("projects")
        .select("*")
        .eq("factory_id", factoryId)
        .order("created_at", { ascending: false });
      if (data) {
        setProjects(data);
        projectIdsRef.current = new Set(data.map((p: Project) => p.id));
      }
      setLoading(false);
    }
    fetchProjects();

    const channel = supabase
      .channel(`projects-list:${factoryId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "projects", filter: `factory_id=eq.${factoryId}` }, (payload) => {
        if (payload.eventType === "INSERT") {
          const p = payload.new as Project;
          projectIdsRef.current.add(p.id);
          setProjects((prev) => [p, ...prev]);
        } else if (payload.eventType === "UPDATE") {
          setProjects((prev) =>
            prev.map((p) => p.id === (payload.new as Project).id ? (payload.new as Project) : p)
          );
        }
      })
      .subscribe();
    return () => { channel.unsubscribe().then(() => supabase.removeChannel(channel)); };
  }, [factoryId]);

  useEffect(() => {
    if (!factoryId) return;

    async function fetchAllRuns() {
      // Join !inner so only runs whose project belongs to this factory are returned.
      const { data } = await supabase
        .from("agent_runs")
        .select("*, projects!inner(factory_id)")
        .eq("projects.factory_id", factoryId)
        .order("step", { ascending: true });
      if (!data) return;
      const map = new Map<string, AgentRun[]>();
      for (const { projects: _projects, ...r } of data as (AgentRun & { projects: unknown })[]) {
        const arr = map.get(r.project_id) ?? [];
        arr.push(r as AgentRun);
        map.set(r.project_id, arr);
      }
      setRunsMap(map);
    }
    fetchAllRuns();

    const channel = supabase
      .channel(`all-runs:${factoryId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_runs" }, (payload) => {
        const run = payload.new as AgentRun;
        // Only process runs that belong to this factory's projects.
        if (!projectIdsRef.current.has(run.project_id)) return;
        setRunsMap((prev) => {
          const next = new Map(prev);
          const arr = [...(next.get(run.project_id) ?? [])];
          if (payload.eventType === "INSERT") {
            arr.push(run);
          } else if (payload.eventType === "UPDATE") {
            const idx = arr.findIndex((r) => r.id === run.id);
            if (idx >= 0) arr[idx] = run; else arr.push(run);
          }
          next.set(run.project_id, arr);
          return next;
        });
      })
      .subscribe();
    return () => { channel.unsubscribe().then(() => supabase.removeChannel(channel)); };
  }, [factoryId]);

  function updateProject(p: Project) {
    setProjects((prev) => prev.map((x) => x.id === p.id ? p : x));
  }

  if (authLoading) {
    return (
      <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", background: "var(--base)" }}>
        <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px solid var(--surface1)", borderTopColor: "var(--blue)", animation: "spin 1s linear infinite" }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }
  if (!session) return null;

  return (
    <div style={{
      display: "flex", height: "100vh",
      fontFamily: "var(--font-sans)",
      background: "linear-gradient(180deg, var(--base) 0%, var(--mantle) 100%)",
      color: "var(--text)",
    }}>
      <AppSidebar active="command-center" />

      <div className="main-content" style={{
        width: isMobile ? "100vw" : "calc(100vw - 240px)",
        height: "100%",
        overflow: "hidden",
      }}>
        {view === "queue" && (
          <QueueView
            projects={projects}
            loading={loading}
            runsMap={runsMap}
            session={session}
            onProjectUpdate={updateProject}
          />
        )}
        {view === "squads" && <SquadsView />}
        {/* SIPOC canvas removed — SIPOC contracts now live in pipelines */}
        {view === "infra" && (
          <div style={{ padding: 24, overflowY: "auto", height: "100%" }}>
            <div style={{ maxWidth: 900, margin: "0 auto" }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", margin: "0 0 16px 0" }}>Infrastructure</h2>
              <InfraMonitor />
            </div>
          </div>
        )}
      </div>

      <nav className="bottom-nav">
        {NAV_ITEMS.map((item) => {
          const active = view === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              style={{
                flex: 1, display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 4,
                background: "none", border: "none", cursor: "pointer",
                color: active ? "var(--blue)" : "var(--overlay1)",
                padding: "8px 0",
                transition: "color 0.15s ease",
              }}
            >
              <Icon size={20} />
              <span style={{ fontSize: 9, fontWeight: active ? 600 : 400, letterSpacing: "0.3px" }}>
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/* ─── Squads View ─────────────────────────────────────── */
function SquadsView() {
  return (
    <div style={{ padding: "32px 40px", overflowY: "auto", height: "100%" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: "0 0 4px 0" }}>Squads</h2>
        <p style={{ fontSize: 13, color: "var(--subtext0)", margin: "0 0 28px 0" }}>
          All 38 factory agents organized by squad.
        </p>
        <AgentCatalog />
      </div>
    </div>
  );
}

/* ─── Queue View ─────────────────────────────────────── */
type ActionState = { loading: boolean; msg?: { type: "error" | "cli"; text: string } };

// CompletedProjectCard removed — projects no longer have a "completed"
// status (migration 118). Only sprints complete; projects sit at `ready`
// when idle and `cancelled` when archived. Operators archive projects via
// the Archive button on idle/paused cards (now in QueueRow).


/** Running/paused project card: QueueRow header + collapsible ProjectCanvas */
function RunningProjectCard({ project, db, sprintInfoMap, latestSprintFlags, actions, runsMap, onPause, onRemove, session, onPlay, onSprintModal, onAutoDrainPauseToggle, onAutoDrainHardStop, onAutoDrainApprove }: {
  project: Project;
  db: DBProject;
  sprintInfoMap: Map<string, SprintInfo>;
  latestSprintFlags?: LatestSprintFlags;
  actions: Record<string, ActionState>;
  runsMap: Map<string, AgentRun[]>;
  onPause: () => void;
  onRemove: () => void;
  session: Session;
  onPlay?: () => void;
  onSprintModal?: () => void;
  onAutoDrainPauseToggle?: () => void;
  onAutoDrainHardStop?: () => void;
  onAutoDrainApprove?: () => void;
}) {
  const sprintStatus = sprintInfoMap.get(project.id)?.status;
  const isPaused = sprintStatus === "paused" || sprintStatus === "waiting";
  const [canvasOpen, setCanvasOpen] = useState(!isPaused);
  const sprintInfo = sprintInfoMap.get(project.id);

  // Only show runs that belong to the current sprint (created after the sprint started).
  // This prevents stale runs from a previous sprint polluting the Agent Pipeline view.
  const allRuns = runsMap.get(project.id) ?? [];
  const runs = sprintInfo?.created_at
    ? allRuns.filter((r) => r.created_at >= sprintInfo.created_at)
    : allRuns;

  return (
    <div>
      <QueueRow
        project={project}
        sprintCount={db.sprint_count}
        activeSprintNum={sprintInfo?.sprint_num}
        brief={db.intake_brief}
        lastError={db.last_error}
        state={actions[project.id]}
        // Office row collapses project + sprint state. Sprint flags
        // (paused/waiting/pending_save) take precedence so the row
        // renders the right Continue/Save affordances; otherwise we
        // fall back to project.status.
        status={sprintStatus ?? (project.status as string)}
        canStart={isPaused}
        runs={runs}
        onPause={onPause}
        onRemove={onRemove}
        {...(onPlay ? { onPlay } : {})}
        {...(onSprintModal ? { onSprintModal } : {})}
        {...(onAutoDrainPauseToggle ? { onAutoDrainPauseToggle } : {})}
        {...(onAutoDrainHardStop ? { onAutoDrainHardStop } : {})}
        {...(onAutoDrainApprove ? { onAutoDrainApprove } : {})}
        {...(latestSprintFlags ? { latestSprintFlags } : {})}
      />

      {/* Agent Pipeline — collapsible, scoped to current sprint */}
      <div style={{ marginTop: 8, borderRadius: 10, border: "1px solid rgba(20,99,255,0.15)", overflow: "hidden" }}>
        <button
          onClick={() => setCanvasOpen((o) => !o)}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            width: "100%", padding: "8px 14px",
            background: "var(--surface0)", border: "none", cursor: "pointer",
            color: "var(--subtext0)", fontSize: 11, fontFamily: "var(--font-sans)",
            borderBottom: canvasOpen ? "1px solid rgba(20,99,255,0.12)" : "none",
          }}
        >
          {canvasOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Agent Pipeline
          {sprintInfo && (
            <span style={{ fontSize: 10, color: "var(--overlay0)", marginLeft: 4 }}>
              · sprint {sprintInfo.sprint_num}
            </span>
          )}
          {sprintInfo?.briefing && (
            <span style={{ fontSize: 10, color: "var(--overlay0)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 2 }}>
              — {sprintInfo.briefing.slice(0, 60)}{sprintInfo.briefing.length > 60 ? "…" : ""}
            </span>
          )}
        </button>

        {canvasOpen && (
          <div style={{ background: "var(--surface0)" }}>
            {/* Initializing banner — shown when no agent_runs exist yet for this sprint */}
            {runs.length === 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 20px", borderBottom: "1px solid rgba(20,99,255,0.1)",
                background: "rgba(20,99,255,0.04)",
              }}>
                <Loader2 size={14} color="#1463ff" style={{ animation: "spin 1s linear infinite", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                    Initializing pipeline…
                  </div>
                  {sprintInfo?.briefing && (
                    <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {sprintInfo.briefing}
                    </div>
                  )}
                </div>
                {sprintInfo?.trigger_run_id && (
                  <a
                    href={`https://cloud.trigger.dev/runs/${sprintInfo.trigger_run_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 10, color: "var(--blue)", textDecoration: "none", flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}
                  >
                    Trigger.dev run ↗
                  </a>
                )}
              </div>
            )}
            <div style={{ padding: "16px 20px" }}>
              <ProjectCanvas
                projectId={project.id}
                projectName={project.name}
                projectSlug={(project as DBProject).slug}
                projectStatus={project.status as string}
                projectPhase={(project as { phase?: string }).phase ?? "validate"}
                projectRepoUrl={(project as { repo_url?: string | null }).repo_url}
                projectBaseRef={(project as { base_ref?: string }).base_ref}
                pipeline={
                  // Effective pipeline: prefer the running sprint's resolved
                  // steps (so a discovery sprint shows its own agent list);
                  // fall back to project.pipeline when no sprint is active.
                  // Same precedence the worker uses — UI + runtime stay in sync.
                  (sprintInfo?.steps && sprintInfo.steps.length > 0
                    ? sprintInfo.steps
                    : (project.pipeline ?? [])) as { step: number; agent: string; gate: string | null }[]
                }
                sprintIntent={sprintInfo?.intent ?? null}
                externalRuns={runs}
                sprintNum={sprintInfo?.sprint_num}
                sprintBriefing={sprintInfo?.briefing ?? undefined}
                triggerRunId={sprintInfo?.trigger_run_id ?? undefined}
                executionBackend={((project as DBProject).settings?.cli_agents as { execution_backend?: "supabase" | "local" } | undefined)?.execution_backend}
              />
            </div>
          </div>
        )}
      </div>

      {/* Sprint History — collapsed by default */}
      <SprintHistoryPanel projectId={project.id} session={session} runsMap={runsMap} currentSprintInfo={sprintInfo} sprintCount={db.sprint_count} />
    </div>
  );
}

function QueueView({
  projects, loading, runsMap, session, onProjectUpdate,
}: {
  projects: Project[];
  loading: boolean;
  runsMap: Map<string, AgentRun[]>;
  session: Session;
  onProjectUpdate: (p: Project) => void;
}) {
  const { factoryId, factories } = useAuth();
  const [showAdd, setShowAdd] = useState(false);
  // Office tab partitions the view by autonomy. "all" mirrors the legacy
  // pre-tabs layout and is the default — operators with no autonomous
  // projects yet shouldn't suddenly see two near-empty tabs.
  const [officeTab, setOfficeTab] = useState<"all" | "regular" | "autonomous">("all");
  const [sprintModal, setSprintModal] = useState<DBProject | null>(null);
  /**
   * Review modal — opened from inside Start Sprint when the operator hits
   * "Review →". Holds the project + the overrides that were configured so
   * the Review modal can compose the SprintPlan against them. Only one of
   * `sprintModal` / `reviewState` is non-null at a time.
   */
  const [reviewState, setReviewState] = useState<{ project: DBProject; overrides: SprintRunOverrides } | null>(null);
  /**
   * Per-project stash of the overrides last shown in the Start Sprint modal.
   * When the operator hits "Back" inside Review we re-open Start with the
   * same configuration so editing → reviewing → editing → reviewing doesn't
   * lose state. Cleared after a successful dispatch.
   */
  const [stashedOverrides, setStashedOverrides] = useState<Map<string, SprintRunOverrides>>(new Map());
  const [actions, setActions] = useState<Record<string, ActionState>>({});
  // Maps project_id → { sprint_num, created_at } of the currently active (non-tagged) sprint
  const [sprintInfoMap, setSprintInfoMap] = useState<Map<string, SprintInfo>>(new Map());
  const [latestSprintFlagsMap, setLatestSprintFlagsMap] = useState<Map<string, LatestSprintFlags>>(new Map());
  const sprintDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const projectIds = projects.map((p) => p.id);

    async function fetchActiveSprints() {
      const query = supabase
        .from("sprints")
        .select("project_id, sprint_num, status, created_at, trigger_run_id, briefing, intent, steps")
        .is("repo_tag", null)
        .not("status", "in", '("completed","failed","cancelled")');
      // Scope to this factory's projects when we have them.
      const { data } = projectIds.length > 0
        ? await query.in("project_id", projectIds)
        : await query;
      if (!data) return;
      const map = new Map<string, SprintInfo>();
      for (const s of data as {
        project_id: string;
        sprint_num: number;
        status: string;
        created_at: string;
        trigger_run_id: string | null;
        briefing: string | null;
        intent: string | null;
        steps: { step: number; agent: string; gate: string | null }[] | null;
      }[]) {
        // If multiple active sprints exist (edge case), keep the highest sprint_num
        const existing = map.get(s.project_id);
        if (existing === undefined || s.sprint_num > existing.sprint_num) {
          const intent: SprintIntent | null =
            s.intent === "discovery" || s.intent === "planning" ||
            s.intent === "execution" || s.intent === "review"
              ? (s.intent as SprintIntent) : null;
          map.set(s.project_id, {
            sprint_num: s.sprint_num,
            status: s.status,
            created_at: s.created_at,
            trigger_run_id: s.trigger_run_id,
            briefing: s.briefing,
            intent,
            steps: Array.isArray(s.steps) ? s.steps : null,
          });
        }
      }
      setSprintInfoMap(map);
    }
    fetchActiveSprints();

    // Latest-sprint flags — distinct from active-sprint info. We need the
    // MOST RECENT sprint per project (any status) to surface the "needs
    // human" badge. The partial index on (project_id, completed_at) WHERE
    // needs_human=true makes this cheap; we additionally check that the
    // flagged sprint is the latest one (not buried under a newer sprint).
    async function fetchLatestSprintFlags() {
      if (projectIds.length === 0) return;
      // Fetch sprints in scope with their outcome — order by sprint_num
      // desc and take the first per project client-side. Limited to recent
      // sprints (last 100 per call) to stay cheap.
      const { data } = await supabase
        .from("sprints")
        .select("project_id, sprint_num, needs_human, outcome")
        .in("project_id", projectIds)
        .order("sprint_num", { ascending: false })
        .limit(projectIds.length * 5);
      if (!data) return;
      const map = new Map<string, LatestSprintFlags>();
      for (const row of data as {
        project_id: string;
        sprint_num: number;
        needs_human: boolean | null;
        outcome: {
          verdict?: string;
          reason?: string;
          needs_human_reason?: string;
          suggested_action?: string;
          pending_push?: { branch: string | null; tag?: string };
          auto_composed?: { source_sprint_id: string };
        } | null;
      }[]) {
        if (map.has(row.project_id)) continue; // first hit = highest sprint_num
        const verdictRaw = row.outcome?.verdict;
        const verdict = verdictRaw === "success" || verdictRaw === "no-output" || verdictRaw === "partial" || verdictRaw === "failed"
          ? verdictRaw : null;
        map.set(row.project_id, {
          sprint_num:        row.sprint_num,
          needs_human:       row.needs_human === true,
          verdict,
          reason:            row.outcome?.reason ?? null,
          needs_human_reason: row.outcome?.needs_human_reason ?? null,
          suggested_action:   row.outcome?.suggested_action ?? null,
          pending_push:       row.outcome?.pending_push ?? null,
          auto_composed:     row.outcome?.auto_composed ?? null,
        });
      }
      setLatestSprintFlagsMap(map);
    }
    fetchLatestSprintFlags();

    const channel = supabase
      .channel("active-sprints")
      .on("postgres_changes", { event: "*", schema: "public", table: "sprints" }, () => {
        // Debounce: rapid sprint changes (e.g. bulk updates) collapse into a single fetch.
        if (sprintDebounceRef.current) clearTimeout(sprintDebounceRef.current);
        sprintDebounceRef.current = setTimeout(() => {
          fetchActiveSprints();
          fetchLatestSprintFlags();
        }, 400);
      })
      .subscribe();
    return () => {
      if (sprintDebounceRef.current) clearTimeout(sprintDebounceRef.current);
      channel.unsubscribe().then(() => supabase.removeChannel(channel));
    };
  }, [projects]);

  // ── Office tabs: All | Regular | Autonomous ─────────────────────────
  // Operators with mixed workloads (some hands-on projects, some auto-
  // drained) end up scrolling past irrelevant cards. Tabs partition the
  // view by autonomy. "All" preserves the legacy behaviour as default.
  const isAutonomous = (p: Project): boolean =>
    (p as DBProject).execution_mode === "kanban_auto";
  const autonomousAll = projects.filter(isAutonomous);
  const regularAll    = projects.filter((p) => !isAutonomous(p));
  const tabProjects =
    officeTab === "regular"    ? regularAll :
    officeTab === "autonomous" ? autonomousAll :
                                 projects;

  const isInQueue = (p: Project) => {
    if (QUEUE_PROJECT_STATUSES.has(p.status as string)) return true;
    const s = sprintInfoMap.get(p.id);
    return !!s && QUEUE_SPRINT_STATUSES.has(s.status);
  };

  const inQueue  = tabProjects.filter(isInQueue);
  // notQueue = idle projects available to add to the queue. Archived
  // projects (status=locked AND archived_at non-null) are hidden from
  // Office entirely; Studio still surfaces them.
  const notQueue = tabProjects.filter((p) => !isInQueue(p) && !p.archived_at);

  const running     = inQueue.filter((p) => (p.status as string) === "running");
  const queued      = inQueue.filter((p) => (p.status as string) === "queued");
  const paused      = inQueue.filter((p) => {
    const s = sprintInfoMap.get(p.id);
    return s?.status === "paused" || s?.status === "waiting";
  });
  const pendingSave = inQueue.filter((p) => sprintInfoMap.get(p.id)?.status === "pending_save");

  const activeFactory = factories.find((f) => f.id === factoryId) ?? null;
  const maxConcurrent = (() => {
    const raw = Number((activeFactory?.config as Record<string, unknown> | null | undefined)?.max_concurrent_projects);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  })();
  const atCapacity = running.length >= maxConcurrent;

  function setAction(id: string, state: ActionState) {
    setActions((prev) => ({ ...prev, [id]: state }));
  }

  async function addToQueue(project: Project) {
    setAction(project.id, { loading: true });
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "queued" }),
    });
    if (res.ok) {
      onProjectUpdate({ ...project, status: "queued" as Project["status"] });
      setShowAdd(false);
    } else {
      const body = await res.json() as { error?: string };
      setAction(project.id, { loading: false, msg: { type: "error", text: body.error ?? "Failed." } });
    }
    setActions((prev) => { const next = { ...prev }; delete next[project.id]; return next; });
  }

  async function removeFromQueue(project: Project) {
    setAction(project.id, { loading: true });
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "idle" }),
    });
    if (res.ok) {
      onProjectUpdate({ ...project, status: "idle" as Project["status"] });
    } else {
      const body = await res.json() as { error?: string };
      setAction(project.id, { loading: false, msg: { type: "error", text: body.error ?? "Failed." } });
    }
    setActions((prev) => { const next = { ...prev }; delete next[project.id]; return next; });
  }

  /**
   * Archive a project — sets status='locked' + archived_at=now() so it
   * falls off the Office. The project stays in Studio (/projects can
   * include archived rows), and can be unarchived from there. Distinct
   * from delete (which removes the row entirely and tears down sprint
   * artifacts).
   */
  async function archiveProject(project: Project) {
    if (!confirm(`Archive "${project.name}"? It'll disappear from Office. Project stays available in Studio.`)) return;
    setAction(project.id, { loading: true });
    const res = await fetch(`/api/projects/${project.id}`, {
      method:  "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ status: "cancelled" }),  // legacy alias — server translates to locked + archived_at
    });
    if (res.ok) {
      onProjectUpdate({ ...project, status: "locked" as Project["status"], archived_at: new Date().toISOString() });
    } else {
      const body = await res.json() as { error?: string };
      setAction(project.id, { loading: false, msg: { type: "error", text: body.error ?? "Archive failed." } });
    }
    setActions((prev) => { const next = { ...prev }; delete next[project.id]; return next; });
  }

  // markAsCompleted removed — projects no longer have a "completed"
  // status (migration 118). To clean up Office, operators use Archive
  // (status='cancelled'); to revisit, the project sits at 'ready'.

  /**
   * Hard-stop an autonomous project: cancels any in-flight sprint AND
   * sets the auto-drain pause flag in one call. Use when the operator
   * wants to halt everything right now (vs the graceful pause, which
   * lets the current sprint finish). The PATCH endpoint already
   * cancels the Trigger.dev run when status flips to "paused", so we
   * just thread both fields through.
   */
  async function hardStopAutoDrain(project: Project) {
    if (!confirm("Hard-stop will cancel the in-flight sprint immediately and pause auto-drain. The graceful pause finishes the current sprint first — usually preferred. Proceed with hard-stop?")) {
      return;
    }
    setAction(project.id, { loading: true });
    const currentSettings = ((project as DBProject).settings ?? {}) as Record<string, unknown>;
    const nextSettings = { ...currentSettings, auto_drain_pause_requested: true };
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused", settings: nextSettings }),
    });
    if (res.ok) {
      onProjectUpdate({ ...(project as DBProject), status: "idle" as Project["status"], settings: nextSettings } as Project);
    } else {
      const body = await res.json() as { error?: string };
      setAction(project.id, { loading: false, msg: { type: "error", text: body.error ?? "Hard-stop failed." } });
      return;
    }
    setActions((prev) => { const next = { ...prev }; delete next[project.id]; return next; });
  }

  /**
   * Toggle the autonomous-pause flag on a project. The cron checks
   * `settings.auto_drain_pause_requested` and skips dispatch when it's
   * true; the in-flight sprint (if any) finishes naturally. We round-
   * trip the entire `settings` JSON because PATCH replaces the column,
   * so we merge the toggle into whatever was already there.
   */
  async function toggleAutoDrainPause(project: Project) {
    setAction(project.id, { loading: true });
    const currentSettings = ((project as DBProject).settings ?? {}) as Record<string, unknown>;
    const currentlyPaused = currentSettings.auto_drain_pause_requested === true;
    const nextSettings = { ...currentSettings, auto_drain_pause_requested: !currentlyPaused };
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ settings: nextSettings }),
    });
    if (res.ok) {
      onProjectUpdate({ ...(project as DBProject), settings: nextSettings } as Project);
    } else {
      const body = await res.json() as { error?: string };
      setAction(project.id, { loading: false, msg: { type: "error", text: body.error ?? "Failed to toggle pause." } });
      return;
    }
    setActions((prev) => { const next = { ...prev }; delete next[project.id]; return next; });
  }

  /**
   * Clear the per-sprint approval gate. Worker sets
   * `auto_drain_awaiting_approval=true` after each sprint; the dispatcher
   * skips while the flag is on. Operator clicks Approve to release the
   * loop for one cycle — the next completion will set it back to true.
   */
  async function approveAutoDrain(project: Project) {
    setAction(project.id, { loading: true });
    const currentSettings = ((project as DBProject).settings ?? {}) as Record<string, unknown>;
    const nextSettings = { ...currentSettings, auto_drain_awaiting_approval: false };
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ settings: nextSettings }),
    });
    if (res.ok) {
      onProjectUpdate({ ...(project as DBProject), settings: nextSettings } as Project);
    } else {
      const body = await res.json() as { error?: string };
      setAction(project.id, { loading: false, msg: { type: "error", text: body.error ?? "Failed to approve." } });
      return;
    }
    setActions((prev) => { const next = { ...prev }; delete next[project.id]; return next; });
  }

  async function startProject(project: Project) {
    if (atCapacity) return; // respect factories.config.max_concurrent_projects
    setAction(project.id, { loading: true });
    const res = await fetch(`/api/projects/${project.id}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json() as { triggered?: boolean; cli_command?: string | null; error?: string };
    if (res.status === 429) {
      setAction(project.id, { loading: false, msg: { type: "error", text: "Factory is at its concurrent project limit. Wait for a running sprint to finish, or raise Max concurrent projects in Factory Settings." } });
      return;
    }
    if (res.status === 503) {
      // Local Trigger.dev worker isn't running — the dispatcher already
      // cancelled the orphan trigger run and stamped the sprint as
      // no_worker. Surface a precise hint instead of a generic 5xx.
      setAction(project.id, { loading: false, msg: { type: "error", text: body.error ?? "Local worker is not running. Start it with `tp workers dev` and retry." } });
      return;
    }
    if (!res.ok) {
      setAction(project.id, { loading: false, msg: { type: "error", text: body.error ?? "Start failed." } });
      return;
    }
    if (body.cli_command) {
      setAction(project.id, { loading: false, msg: { type: "cli", text: body.cli_command } });
      return;
    }
    if (body.triggered) {
      onProjectUpdate({ ...project, status: "running" as Project["status"] });
    } else {
      setAction(project.id, { loading: false, msg: { type: "error", text: "Trigger.dev not configured. Check Integrations → Platforms." } });
      return;
    }
    setActions((prev) => { const next = { ...prev }; delete next[project.id]; return next; });
  }

  async function resumeProject(project: Project) {
    setAction(project.id, { loading: true });
    // Resolve execution mode from project settings to use the correct trigger key
    const db = project as DBProject;
    const cliCfg = db.settings?.cli_agents as { execution_mode?: "cloud" | "local" } | undefined;
    const cliExecutionMode = cliCfg?.execution_mode ?? "local";
    const res = await fetch(`/api/projects/${project.id}/continue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cliExecutionMode }),
    });
    const body = await res.json() as { triggered?: boolean; cli_command?: string | null; error?: string };
    if (res.status === 429) {
      setAction(project.id, { loading: false, msg: { type: "error", text: "Factory is at its concurrent project limit. Wait for a running sprint to finish, or raise Max concurrent projects in Factory Settings." } });
      return;
    }
    if (!res.ok) {
      setAction(project.id, { loading: false, msg: { type: "error", text: body.error ?? "Resume failed." } });
      return;
    }
    if (body.cli_command) {
      setAction(project.id, { loading: false, msg: { type: "cli", text: body.cli_command } });
      return;
    }
    if (body.triggered) {
      onProjectUpdate({ ...project, status: "running" as Project["status"] });
    } else {
      setAction(project.id, { loading: false, msg: { type: "error", text: "Trigger.dev not configured. Check Integrations → Platforms." } });
      return;
    }
    setActions((prev) => { const next = { ...prev }; delete next[project.id]; return next; });
  }

  async function pauseProject(project: Project) {
    setAction(project.id, { loading: true });
    const res = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    if (res.ok) {
      onProjectUpdate({ ...project, status: "idle" as Project["status"] });
    } else {
      const body = await res.json() as { error?: string };
      setAction(project.id, { loading: false, msg: { type: "error", text: body.error ?? "Pause failed." } });
    }
    setActions((prev) => { const next = { ...prev }; delete next[project.id]; return next; });
  }

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
        <div style={{ width: 24, height: 24, borderRadius: "50%", border: "2px solid var(--surface1)", borderTopColor: "var(--blue)", animation: "spin 1s linear infinite" }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{
        padding: "18px 24px", borderBottom: "1px solid var(--surface0)",
        background: "var(--mantle)", display: "flex", alignItems: "center", gap: 14, flexShrink: 0,
      }}>
        <LayoutDashboard size={20} color="var(--blue)" />
        <div>
          <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Office</h1>
          <p style={{ fontSize: 12, color: "var(--subtext0)", margin: 0, marginTop: 2 }}>
            {inQueue.length === 0
              ? "No projects in the pipeline"
              : `${running.length}/${maxConcurrent} running · ${queued.length} queued · ${paused.length} paused`}
          </p>
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setShowAdd(true)}
          disabled={notQueue.length === 0}
          style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "8px 16px", borderRadius: 9, border: "none",
            background: notQueue.length === 0 ? "var(--surface1)" : "#1463ff",
            color: notQueue.length === 0 ? "var(--overlay0)" : "#fff",
            fontSize: 13, fontWeight: 700, cursor: notQueue.length === 0 ? "not-allowed" : "pointer",
            fontFamily: "var(--font-sans)", whiteSpace: "nowrap",
          }}
        >
          <Plus size={14} /> Add to queue
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        <div style={{ maxWidth: 820, margin: "0 auto" }}>

          {/* Tabs — partition by autonomy. Hidden when there are no
              autonomous projects yet (single-mode workspace doesn't
              need the chrome). */}
          {autonomousAll.length > 0 && (
            <div style={{
              display: "flex", gap: 4,
              marginBottom: 18,
              borderBottom: "1px solid var(--surface0)",
            }}>
              {([
                { id: "all"        as const, label: "All",         count: projects.length        },
                { id: "regular"    as const, label: "Regular",     count: regularAll.length      },
                { id: "autonomous" as const, label: "Autonomous",  count: autonomousAll.length, icon: <Bot size={11} /> },
              ]).map((t) => {
                const active = officeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setOfficeTab(t.id)}
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      padding: "8px 14px",
                      background: "transparent", border: "none",
                      borderBottom: active ? "2px solid var(--blue, #1463ff)" : "2px solid transparent",
                      marginBottom: -1,
                      color: active ? "var(--text)" : "var(--overlay0)",
                      fontSize: 12, fontWeight: active ? 700 : 500,
                      cursor: "pointer", fontFamily: "var(--font-sans)",
                    }}
                  >
                    {t.icon}
                    {t.label}
                    <span style={{
                      fontSize: 10, fontWeight: 700,
                      padding: "1px 6px", borderRadius: 99,
                      background: active ? "var(--blue, #1463ff)" : "var(--surface1)",
                      color:      active ? "#fff" : "var(--overlay1)",
                    }}>
                      {t.count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {inQueue.length === 0 && (
            <div style={{
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              gap: 16, padding: "60px 32px", textAlign: "center",
            }}>
              <div style={{ width: 64, height: 64, borderRadius: 16, background: "var(--surface0)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <FolderOpen size={28} color="var(--overlay1)" />
              </div>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>Office is empty</div>
                <div style={{ fontSize: 13, color: "var(--subtext0)", maxWidth: 340, lineHeight: 1.5 }}>
                  {notQueue.length === 0
                    ? "Create projects first, then add them to the Office queue."
                    : "Add a project to the queue to start running your pipeline."}
                </div>
              </div>
              {notQueue.length > 0 && (
                <button
                  onClick={() => setShowAdd(true)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, border: "none", background: "#1463ff", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}
                >
                  <Plus size={14} /> Add to queue
                </button>
              )}
            </div>
          )}

          {/* Running */}
          {running.length > 0 && (
            <QueueSection
              label="Running"
              indicator={<Zap size={13} color="#1463ff" />}
              count={running.length}
            >
              {running.map((project) => {
                const db = project as DBProject;
                return (
                  <RunningProjectCard
                    key={project.id}
                    project={project}
                    db={db}
                    sprintInfoMap={sprintInfoMap}
                    latestSprintFlags={latestSprintFlagsMap.get(project.id)}
                    actions={actions}
                    runsMap={runsMap}
                    session={session}
                    onPause={() => pauseProject(project)}
                    onRemove={() => removeFromQueue(project)}
                    onAutoDrainPauseToggle={() => toggleAutoDrainPause(project)}
                    onAutoDrainHardStop={() => hardStopAutoDrain(project)}
                    onAutoDrainApprove={() => approveAutoDrain(project)}
                  />
                );
              })}
            </QueueSection>
          )}

          {/* Queued */}
          {queued.length > 0 && (
            <QueueSection
              label="Queued Projects"
              indicator={<Clock size={13} color="var(--overlay0)" />}
              count={queued.length}
            >
              {queued.map((project, i) => {
                const db = project as DBProject;
                return (
                  <QueueRow
                    key={project.id}
                    project={project}
                    index={i + 1}
                    sprintCount={db.sprint_count}
                    activeSprintNum={sprintInfoMap.get(project.id)?.sprint_num}
                    brief={db.intake_brief}
                    state={actions[project.id]}
                    status={project.status as string}
                    canStart={!atCapacity && project.status !== "locked"}
                    blockedReason={
                      project.status === "locked"
                        ? "Project is locked — open Project Settings → Pipeline (or unarchive) to start."
                        : atCapacity
                          ? `Factory at capacity (${running.length}/${maxConcurrent})`
                          : undefined
                    }
                    onPlay={() => setSprintModal(db)}
                    onSprintModal={() => setSprintModal(db)}
                    onRemove={() => removeFromQueue(project)}
                    onAutoDrainPauseToggle={() => toggleAutoDrainPause(project)}
                    onAutoDrainApprove={() => approveAutoDrain(project)}
                    latestSprintFlags={latestSprintFlagsMap.get(project.id)}
                  />
                );
              })}
            </QueueSection>
          )}

          {/* Paused */}
          {paused.length > 0 && (
            <QueueSection
              label="Paused"
              indicator={<Clock size={13} color="#f59f00" />}
              count={paused.length}
            >
              {paused.map((project) => {
                const db = project as DBProject;
                return (
                  <RunningProjectCard
                    key={project.id}
                    project={project}
                    db={db}
                    sprintInfoMap={sprintInfoMap}
                    latestSprintFlags={latestSprintFlagsMap.get(project.id)}
                    actions={actions}
                    runsMap={runsMap}
                    onPause={() => pauseProject(project)}
                    onRemove={() => removeFromQueue(project)}
                    onPlay={() => resumeProject(project)}
                    onSprintModal={() => setSprintModal(db)}
                    onAutoDrainPauseToggle={() => toggleAutoDrainPause(project)}
                    onAutoDrainApprove={() => approveAutoDrain(project)}
                    session={session!}
                  />
                );
              })}
            </QueueSection>
          )}

          {/* Pending Save */}
          {pendingSave.length > 0 && (
            <QueueSection
              label="Pending Save"
              indicator={<Download size={13} color="#f59f00" />}
              count={pendingSave.length}
            >
              {pendingSave.map((project) => {
                const db = project as DBProject;
                return (
                  <PendingSaveCard
                    key={project.id}
                    project={project}
                    db={db}
                    sprintInfoMap={sprintInfoMap}
                    runsMap={runsMap}
                    session={session}
                    onSaved={(p) => onProjectUpdate(p)}
                  />
                );
              })}
            </QueueSection>
          )}

          {/* Note: there is no "Completed Projects" section here. Projects
              don't complete — only sprints do. A project sitting idle is
              just `ready`, available to run another sprint. To archive a
              project so it disappears from Office, use the Archive button
              on the card (flips to `cancelled`). Sprint history per
              project is browsable in Studio. */}
        </div>
      </div>

      {/* Add to queue modal */}
      {showAdd && (
        <AddToQueueModal
          projects={notQueue}
          actionStates={actions}
          onAdd={addToQueue}
          onClose={() => setShowAdd(false)}
        />
      )}

      {/* Start Sprint modal */}
      {sprintModal && (
        <StartSprintModal
          project={sprintModal}
          activeSprintStatus={sprintInfoMap.get(sprintModal.id)?.status ?? null}
          session={session}
          runsMap={runsMap}
          onClose={() => setSprintModal(null)}
          onStarted={(p) => {
            onProjectUpdate(p);
            setSprintModal(null);
            // Successful direct dispatch — clear any stashed overrides for this project
            setStashedOverrides((prev) => {
              const next = new Map(prev);
              next.delete(p.id);
              return next;
            });
          }}
          onReview={(overrides) => {
            // Stash overrides so a subsequent Back from Review re-opens this
            // modal with the same state, then close us and open Review.
            setStashedOverrides((prev) => new Map(prev).set(sprintModal.id, overrides));
            setReviewState({ project: sprintModal, overrides });
            setSprintModal(null);
          }}
          initialOverrides={stashedOverrides.get(sprintModal.id)}
        />
      )}

      {/* Review Sprint modal */}
      {reviewState && (
        <ReviewSprintModal
          project={reviewState.project}
          overrides={reviewState.overrides}
          session={session}
          onBack={() => {
            // Reopen Start with the same overrides preserved
            setSprintModal(reviewState.project);
            setReviewState(null);
          }}
          onDispatched={() => {
            const dispatched = reviewState.project;
            setReviewState(null);
            setStashedOverrides((prev) => {
              const next = new Map(prev);
              next.delete(dispatched.id);
              return next;
            });
            onProjectUpdate({ ...(dispatched as unknown as Project), status: "running" as Project["status"] });
          }}
        />
      )}
    </div>
  );
}

/* ─── PendingSaveCard ───────────────────────────────── */

type PendingSaveAction = "idle" | "done" | "error";
type LoadingAction = "export" | "discard" | "close" | null;

function PendingSaveCard({ project, db, sprintInfoMap, runsMap, session, onSaved }: {
  project: Project;
  db: DBProject;
  sprintInfoMap: Map<string, SprintInfo>;
  runsMap: Map<string, AgentRun[]>;
  session: Session;
  onSaved: (p: Project) => void;
}) {
  const { tenantId: authTenantId } = useAuth();
  const cliSettings = ((db.settings as Record<string, unknown> | null)?.cli_agents as Record<string, unknown> | undefined) ?? {};
  const storageType = (cliSettings.execution_backend as "supabase" | "local" | undefined) ?? "supabase";
  const sprintInfo = sprintInfoMap.get(project.id);
  const sprintNum  = sprintInfo?.sprint_num ?? db.sprint_count ?? 1;
  const [state, setState] = useState<PendingSaveAction>("idle");
  const [loadingAction, setLoadingAction] = useState<LoadingAction>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filter runs to current sprint (by start time), same logic as RunningProjectCard
  const allRuns = runsMap.get(project.id) ?? [];
  const runs = sprintInfo?.created_at
    ? allRuns.filter((r) => r.created_at >= sprintInfo.created_at)
    : allRuns;

  const [pipelineOpen, setPipelineOpen] = useState(true);

  // We need the sprint ID to call the save API.
  //
  // Two competing concerns:
  //   1. The worker writes projects.status='pending_save' and
  //      sprints.status='pending_save' as SEPARATE UPDATEs — realtime
  //      can fire the project update first. If we hard-filter by
  //      sprint.status the query returns null during that race window
  //      and the save buttons stay disabled until the component remounts.
  //   2. Just taking the latest sprint by sprint_num would pick a newer
  //      sprint (e.g. one that failed immediately on dispatch) when
  //      what we actually want is the one that's currently pending save.
  //
  // Compromise: prefer the latest sprint with status='pending_save' when
  // present (the normal case), fall back to the absolute latest sprint
  // for the race window. The server validates state on the save call,
  // so passing a slightly-stale id at most surfaces a clear error.
  //
  // Re-runs when project status changes (catches the race once the
  // sprint UPDATE lands) and when db.sprint_count bumps (new sprint).
  const [sprintId, setSprintId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: ps } = await supabase
        .from("sprints").select("id")
        .eq("project_id", project.id)
        .eq("status", "pending_save")
        .order("sprint_num", { ascending: false })
        .limit(1).maybeSingle();
      if (cancelled) return;
      if (ps?.id) { setSprintId(ps.id as string); return; }
      const { data: latest } = await supabase
        .from("sprints").select("id")
        .eq("project_id", project.id)
        .order("sprint_num", { ascending: false })
        .limit(1).maybeSingle();
      if (cancelled) return;
      if (latest?.id) setSprintId(latest.id as string);
    })();
    return () => { cancelled = true; };
  }, [project.id, project.status, db.sprint_count]);

  // Auto-push on sprint completion. Fires once per pending_save card
  // when the project has at least one destination with auto_push=true.
  //
  // We re-query `projects.settings` fresh here instead of reading the
  // `db.settings` prop — the dashboard loads projects once on mount
  // and holds stale settings; on cloud execution the sprint transitions
  // to pending_save long after that initial fetch, so the prop can miss
  // a more recent toggle. Re-querying keeps the decision consistent
  // with what the operator last saved.
  //
  // Guarded by a ref so StrictMode doesn't double-dispatch.
  const autoPushFired = React.useRef(false);
  useEffect(() => {
    if (autoPushFired.current) return;
    if (!sprintId || loadingAction) return;

    let cancelled = false;
    supabase
      .from("projects")
      .select("settings")
      .eq("id", project.id)
      .single()
      .then(({ data }) => {
        if (cancelled) return;
        const settings = (data?.settings as Record<string, unknown> | null) ?? {};
        const dests = Array.isArray(settings.destinations)
          ? settings.destinations as Array<{ id: string; auto_push?: boolean }>
          : [];
        const autoPushIds = dests.filter((d) => d.auto_push).map((d) => d.id);
        if (autoPushIds.length === 0) return;
        if (autoPushFired.current) return; // recheck under async

        autoPushFired.current = true;
        setLoadingAction("export"); setErrorMsg(null);
        fetch(`/api/projects/${project.id}/sprints/${sprintId}/save`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "github" }),
        })
          .then(async (res) => {
            if (!res.ok) {
              const body = await res.json().catch(() => ({})) as { error?: string };
              throw new Error(body.error ?? "Auto-push failed");
            }
            setState("done");
            onSaved({ ...project, status: "idle" as Project["status"] });
          })
          .catch((e: Error) => {
            // Non-fatal — user can still push manually. Show the error
            // so they know auto-push tried and didn't land.
            setErrorMsg(`Auto-push failed: ${e.message}`);
          })
          .finally(() => setLoadingAction(null));
      });

    return () => { cancelled = true; };
  }, [sprintId, loadingAction, project, session.access_token, onSaved]);

  const [exportOpen, setExportOpen] = useState(false);
  // Selected target IDs. Per-destination IDs look like "dest:<uuid>" or
  // "dest:global"; the literal "download" is the ZIP target.
  const [exportTargets, setExportTargets] = useState<Set<string>>(new Set());
  interface ExportDest { id: string; label: string; sublabel: string; }
  const [exportDestinations, setExportDestinations] = useState<ExportDest[]>([]);
  const [exportReady, setExportReady] = useState(false);

  // Load the factory's destinations + the global one (when configured)
  // so the export modal can list every target explicitly. This mirrors
  // what the Project Settings modal shows under Output Destinations.
  const authFactoryId = useAuth().factoryId;
  useEffect(() => {
    if (!session || !authTenantId) return;
    setExportReady(false);
    const headers = { Authorization: `Bearer ${session.access_token}` };
    Promise.all([
      authFactoryId
        ? fetch(`/api/factory/output-destinations?factoryId=${authFactoryId}`, { headers })
            .then((r) => r.ok ? r.json() : { destinations: [] })
            .catch(() => ({ destinations: [] }))
        : Promise.resolve({ destinations: [] }),
      fetch(`/api/settings/integrations?tenantId=${authTenantId}`, { headers })
        .then((r) => r.ok ? r.json() : { configured: [] })
        .catch(() => ({ configured: [] })),
      supabase.from("projects").select("settings").eq("id", project.id).single()
        .then(({ data }) => data),
    ]).then(([facBody, intBody, projRow]) => {
      const dests: ExportDest[] = [];
      const configured = new Set<string>(intBody.configured ?? []);
      const projSettings = (projRow?.settings as Record<string, unknown> | null) ?? {};
      const savedDests = Array.isArray(projSettings.destinations)
        ? projSettings.destinations as Array<{ id: string }>
        : [];
      const savedIds = new Set<string>(savedDests.map((d) => d.id));

      // Global destination row — shown whenever tenant-level GitHub
      // integration is configured, regardless of selection state.
      if (configured.has("github:GITHUB_TOKEN") && configured.has("github:GITHUB_OWNER")) {
        dests.push({
          id: "dest:global",
          label: "Global",
          sublabel: "Integrations → Storage",
        });
      }
      for (const d of (facBody.destinations ?? []) as { id: string; name: string; owner: string; tokenMask: string; branch: string | null }[]) {
        dests.push({
          id: `dest:${d.id}`,
          label: d.name,
          sublabel: `owner ${d.owner}${d.branch ? ` · branch ${d.branch}` : ""}`,
        });
      }

      setExportDestinations(dests);
      // Pre-select the destinations saved on the project so the most
      // common "export what the project is configured for" flow is a
      // single click.
      const preselected = new Set<string>();
      for (const d of dests) {
        const rawId = d.id.slice("dest:".length);
        if (savedIds.has(rawId)) preselected.add(d.id);
      }
      setExportTargets(preselected);
      setExportReady(true);
    });
  }, [session, authTenantId, authFactoryId, project.id]);

  async function actExport() {
    if (!sprintId || exportTargets.size === 0) return;
    setLoadingAction("export"); setErrorMsg(null);
    try {
      const selected = Array.from(exportTargets);
      // Translate the per-destination targets into (targets, destinations):
      //   - "github" target when at least one dest:* is selected
      //   - "download" passthrough
      //   - destinations[] filter: the dest ids, "global" stays as the
      //     special identifier the server recognises
      const destIds = selected
        .filter((t) => t.startsWith("dest:"))
        .map((t) => t.slice("dest:".length));
      const targets: string[] = [];
      if (destIds.length > 0) targets.push("github");
      if (selected.includes("download")) targets.push("download");

      const res = await fetch(`/api/projects/${project.id}/sprints/${sprintId}/save`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export", targets, destinations: destIds }),
      });

      // If download is a target and response is a zip, stream it
      if (targets.includes("download") && res.headers.get("content-type")?.includes("application/zip")) {
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href = url;
        a.download = `${project.slug}-sprint-${sprintNum}.zip`;
        a.click();
        URL.revokeObjectURL(url);
        setLoadingAction(null); setState("done"); setExportOpen(false);
        onSaved({ ...project, status: "idle" as Project["status"] });
        return;
      }

      const body = await res.json() as { ok?: boolean; error?: string; results?: { target: string; ok: boolean; error?: string }[] };
      if (!res.ok) { setErrorMsg(body.error ?? `Export failed (${res.status})`); setLoadingAction(null); setState("error"); return; }

      setLoadingAction(null); setState("done"); setExportOpen(false);
      onSaved({ ...project, status: "idle" as Project["status"] });
    } catch (e) {
      setErrorMsg((e as Error).message ?? "Network error");
      setLoadingAction(null); setState("error");
    }
  }

  async function actSimple(action: "discard" | "close") {
    if (!sprintId) { setErrorMsg("Sprint ID not loaded yet — try again."); return; }
    setLoadingAction(action); setErrorMsg(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/sprints/${sprintId}/save`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) { setErrorMsg(body.error ?? `Action failed (${res.status})`); setLoadingAction(null); setState("error"); return; }
      setLoadingAction(null); setState("done");
      onSaved({ ...project, status: "idle" as Project["status"] });
    } catch (e) {
      setErrorMsg((e as Error).message ?? "Network error");
      setLoadingAction(null); setState("error");
    }
  }

  const isAnyLoading = loadingAction !== null;

  return (
    <div style={{
      borderRadius: 10, background: "var(--surface0)",
      border: "1px solid rgba(245,159,0,0.3)",
      overflow: "hidden", marginBottom: 8,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {project.name}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <code style={{ fontSize: 10, color: "var(--overlay0)" }}>{project.slug}</code>
            <span style={{ fontSize: 10, color: "var(--overlay0)", display: "flex", alignItems: "center", gap: 3 }}>
              <GitBranch size={9} /> sprint {sprintNum}
            </span>
            {sprintInfo?.briefing && (
              <span style={{ fontSize: 10, color: "var(--overlay0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
                — {sprintInfo.briefing.slice(0, 50)}{sprintInfo.briefing.length > 50 ? "…" : ""}
              </span>
            )}
          </div>
        </div>
        <span style={{
          fontSize: 10, padding: "2px 8px", borderRadius: 6, fontWeight: 700,
          background: "rgba(245,159,0,0.12)", color: "#f59f00", flexShrink: 0,
        }}>
          pending save
        </span>
      </div>

      {/* Agent Pipeline — collapsible, shows completed sprint pipeline */}
      <div style={{ borderTop: "1px solid rgba(245,159,0,0.15)" }}>
        <button
          onClick={() => setPipelineOpen((o) => !o)}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            width: "100%", padding: "7px 14px",
            background: "transparent", border: "none", cursor: "pointer",
            color: "var(--overlay0)", fontSize: 11, fontFamily: "var(--font-sans)",
            borderBottom: pipelineOpen ? "1px solid rgba(245,159,0,0.1)" : "none",
          }}
        >
          {pipelineOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          Agent Pipeline
          <span style={{ fontSize: 10, color: "var(--overlay0)", marginLeft: 2 }}>
            · {new Set(runs.filter((r) => r.status === "done").map((r) => r.agent)).size} done
          </span>
        </button>
        {pipelineOpen && (
          <div style={{ padding: "12px 14px", background: "var(--crust)" }}>
            <ProjectCanvas
              projectId={project.id}
              projectName={project.name}
              projectSlug={(project as DBProject).slug}
              projectStatus={project.status as string}
              projectPhase={(project as { phase?: string }).phase ?? "validate"}
              projectRepoUrl={(project as { repo_url?: string | null }).repo_url}
              projectBaseRef={(project as { base_ref?: string }).base_ref}
              pipeline={
                (sprintInfo?.steps && sprintInfo.steps.length > 0
                  ? sprintInfo.steps
                  : (project.pipeline ?? [])) as { step: number; agent: string; gate: string | null }[]
              }
              sprintIntent={sprintInfo?.intent ?? null}
              externalRuns={runs}
              sprintNum={sprintNum}
              sprintBriefing={sprintInfo?.briefing ?? undefined}
              executionBackend={((project as DBProject).settings?.cli_agents as { execution_backend?: "supabase" | "local" } | undefined)?.execution_backend}
            />
          </div>
        )}
      </div>

      {/* Action bar */}
      {/* ── Action bar ── */}
      <div style={{ padding: "10px 14px", borderTop: "1px solid rgba(245,159,0,0.15)" }}>
        <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 8 }}>
          Sprint complete — artifacts are in storage. Export, close, or discard.
        </div>

        {errorMsg && (
          <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <AlertTriangle size={11} />{errorMsg}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {/* Export — opens modal */}
          <button disabled={isAnyLoading || !sprintId} onClick={() => setExportOpen(true)} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8,
            border: "none", background: "#1463ff", color: "#fff",
            fontSize: 12, fontWeight: 700, cursor: isAnyLoading || !sprintId ? "not-allowed" : "pointer",
            opacity: isAnyLoading || !sprintId ? 0.6 : 1, fontFamily: "var(--font-sans)",
          }}>
            <ExternalLink size={12} />
            Export
          </button>

          {/* Close — keep artifacts, close sprint */}
          <button disabled={isAnyLoading || !sprintId} onClick={() => actSimple("close")} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8,
            border: "1px solid rgba(20,99,255,0.4)", background: "rgba(20,99,255,0.06)", color: "#1463ff",
            fontSize: 12, fontWeight: 600, cursor: isAnyLoading || !sprintId ? "not-allowed" : "pointer",
            opacity: isAnyLoading || !sprintId ? 0.6 : 1, fontFamily: "var(--font-sans)",
          }}>
            {loadingAction === "close" ? <RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> : <CheckCircle2 size={12} />}
            Close
          </button>

          {/* Discard */}
          <button disabled={isAnyLoading || !sprintId} onClick={() => {
            if (!confirm("Delete all sprint artifacts and close this sprint?")) return;
            actSimple("discard");
          }} style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8,
            border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)",
            fontSize: 12, cursor: isAnyLoading || !sprintId ? "not-allowed" : "pointer",
            opacity: isAnyLoading || !sprintId ? 0.6 : 1, fontFamily: "var(--font-sans)",
          }}>
            {loadingAction === "discard" ? <RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={12} />}
            Discard
          </button>
        </div>
      </div>

      {/* ── Export Modal ── */}
      {exportOpen && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)",
        }} onClick={() => setExportOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: 380, background: "var(--mantle)", borderRadius: 12,
            border: "1px solid var(--surface1)", padding: 24,
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 16px", color: "var(--text)" }}>
              Export Sprint {sprintNum}
            </h3>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
              {/* Push to GitHub — one row per destination */}
              {exportReady && exportDestinations.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--overlay0)", marginBottom: 6 }}>
                    Push to GitHub
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {exportDestinations.map((d) => {
                      const checked = exportTargets.has(d.id);
                      return (
                        <label key={d.id} style={{
                          display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                          borderRadius: 8, border: `1px solid ${checked ? "rgba(20,99,255,0.3)" : "var(--surface1)"}`,
                          background: checked ? "rgba(20,99,255,0.06)" : "var(--surface0)",
                          cursor: "pointer",
                        }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setExportTargets((prev) => {
                                const next = new Set(prev);
                                if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                                return next;
                              });
                            }}
                            style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>{d.label}</div>
                            <div style={{ fontSize: 11, color: "var(--subtext0)", fontFamily: "var(--font-mono)" }}>{d.sublabel}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {exportReady && exportDestinations.length === 0 && (
                <div style={{
                  fontSize: 11, color: "var(--overlay0)", padding: "8px 10px",
                  borderRadius: 8, background: "var(--surface0)", border: "1px dashed var(--surface1)",
                }}>
                  No GitHub destinations configured — add one under Factory Manager or Integrations → Storage.
                </div>
              )}

              {/* Download ZIP */}
              <label style={{
                display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                borderRadius: 8, border: `1px solid ${exportTargets.has("download") ? "rgba(20,99,255,0.3)" : "var(--surface1)"}`,
                background: exportTargets.has("download") ? "rgba(20,99,255,0.06)" : "var(--surface0)",
                cursor: "pointer",
              }}>
                <input
                  type="checkbox"
                  checked={exportTargets.has("download")}
                  onChange={() => {
                    setExportTargets((prev) => {
                      const next = new Set(prev);
                      if (next.has("download")) next.delete("download"); else next.add("download");
                      return next;
                    });
                  }}
                  style={{ accentColor: "var(--blue)", cursor: "pointer" }}
                />
                <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>Download ZIP</span>
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setExportOpen(false)} style={{
                padding: "7px 14px", borderRadius: 8, border: "1px solid var(--surface1)",
                background: "transparent", color: "var(--subtext0)", fontSize: 12, cursor: "pointer",
                fontFamily: "var(--font-sans)",
              }}>
                Cancel
              </button>
              <button
                disabled={exportTargets.size === 0 || loadingAction === "export"}
                onClick={actExport}
                style={{
                  padding: "7px 14px", borderRadius: 8, border: "none",
                  background: "#1463ff", color: "#fff", fontSize: 12, fontWeight: 700,
                  cursor: exportTargets.size === 0 ? "not-allowed" : "pointer",
                  opacity: exportTargets.size === 0 ? 0.5 : 1,
                  fontFamily: "var(--font-sans)",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                {loadingAction === "export" ? <RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> : <ExternalLink size={12} />}
                Export
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sprint History */}
      <SprintHistoryPanel projectId={project.id} session={session} runsMap={runsMap} currentSprintInfo={sprintInfo} sprintCount={db.sprint_count} />
    </div>
  );
}

/* ─── SprintHistoryPanel (uses shared SprintRow from ProjectCard) ─── */

function SprintHistoryPanel({ projectId, session, runsMap, currentSprintInfo, sprintCount }: {
  projectId: string;
  session: Session;
  runsMap: Map<string, AgentRun[]>;
  currentSprintInfo?: SprintInfo;
  sprintCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [sprints, setSprints] = useState<SprintSummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || sprints !== null || loading) return;
    setLoading(true);
    fetch(`/api/projects/${projectId}/sprints`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (res) => {
        if (res.ok) {
          const body = await res.json() as { sprints: SprintSummary[] };
          setSprints(body.sprints ?? []);
        }
      })
      .finally(() => setLoading(false));
  }, [open, sprints, loading, projectId, session.access_token]);

  // Exclude current active sprint from history (it's shown in Agent Pipeline above)
  const historyItems = (sprints ?? []).filter(
    (s) => !currentSprintInfo || s.sprint_num !== currentSprintInfo.sprint_num,
  );

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%", padding: "7px 16px",
          display: "flex", alignItems: "center", gap: 8,
          background: "var(--crust)", border: "none", borderTop: "1px solid var(--surface1)",
          cursor: "pointer", textAlign: "left", fontFamily: "var(--font-sans)",
          color: "var(--subtext0)", fontSize: 11,
        }}
      >
        <GitBranch size={11} color="var(--overlay0)" />
        <span style={{ flex: 1 }}>
          {(sprints !== null ? historyItems.length : (sprintCount ?? 0))} sprint{(sprints !== null ? historyItems.length : (sprintCount ?? 0)) !== 1 ? "s" : ""}
        </span>
        {loading
          ? <RefreshCw size={10} style={{ animation: "spin 1s linear infinite" }} />
          : open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
      </button>

      {open && (
        <div style={{ background: "var(--crust)" }}>
          {loading && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--overlay0)", padding: "4px 16px" }}>
              <RefreshCw size={11} style={{ animation: "spin 1s linear infinite" }} /> Loading…
            </div>
          )}
          {!loading && historyItems.length === 0 && (
            <div style={{ padding: "10px 16px", fontSize: 11, color: "var(--overlay0)" }}>No sprints yet.</div>
          )}
          {historyItems.map((s) => (
            <SprintRow
              key={s.id}
              sprint={{
                id: s.id, sprint_num: s.sprint_num, status: s.status,
                briefing: s.briefing, started_at: s.created_at,
                completed_at: s.completed_at, steps: [],
                trigger_run_id: null, repo_tag: null, tap_status: "pending",
                base_ref: null, commit_sha: null, init_commit_sha: null,
                sprint_completed_saved: s.sprint_completed_saved ?? null,
                config: s.config ?? null,
              } satisfies SharedSprint}
              projectId={projectId}
              projectStatus="completed"
              storageBackend="supabase"
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* SprintHistoryRow removed — now uses shared SprintRow from @/components/ProjectCard */

/* ─── Queue primitives ──────────────────────────────── */

function QueueSection({ label, indicator, count, children }: {
  label: string; indicator: React.ReactNode; count: number; children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 10, fontWeight: 700, textTransform: "uppercase",
        letterSpacing: "0.08em", color: "var(--overlay0)", marginBottom: 10,
      }}>
        {indicator} {label}
        <span style={{ fontSize: 10, background: "var(--surface1)", borderRadius: 99, padding: "0 5px", lineHeight: "16px", fontWeight: 400, color: "var(--subtext0)" }}>{count}</span>
      </div>
      {children}
    </div>
  );
}

/* ─── Icon button (icon-only, tooltip via title) ────── */
function PipelineIconBtn({ title, icon, color, onClick, disabled, loading }: {
  title: string; icon: React.ReactNode; color: string;
  onClick?: () => void; disabled?: boolean; loading?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 28, height: 28, borderRadius: 7, border: "none", flexShrink: 0,
        background: `${color}18`, color,
        cursor: disabled || loading ? "not-allowed" : "pointer",
        opacity: disabled ? 0.35 : 1,
        transition: "opacity 0.12s",
      }}
    >
      {loading ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : icon}
    </button>
  );
}

/* ─── Agent run status icon ─────────────────────────────── */
function RunStatusIcon({ status }: { status: string }) {
  if (status === "done")        return <CheckCircle2 size={11} color="#00c2a8" />;
  if (status === "failed")      return <XCircle size={11} color="var(--red)" />;
  if (status === "running")     return <Loader2 size={11} color="#1463ff" style={{ animation: "spin 1s linear infinite" }} />;
  if (status === "waiting")     return <Circle size={11} color="#f59f00" />;
  if (status === "interrupted") return <XCircle size={11} color="var(--yellow, #df8e1d)" />;
  return <Circle size={11} color="var(--overlay0)" />;
}

/* ─── Queue row — same layout for queued / paused / running states ─
 *
 * `status` here is a derived Office-row status, NOT projects.status. It
 * collapses project + latest-sprint state into one of:
 *   "queued"   — project.status === "queued"
 *   "running"  — project.status === "running" with no human-gate
 *   "paused"   — sprint.status in (paused, waiting)
 *   "pending_save" — sprint.status === "pending_save"
 * The icons in the row decide their behaviour from this collapsed view.
 */
function QueueRow({ project, index, sprintCount, activeSprintNum, brief, lastError, state, status, canStart, blockedReason,
                    runs, onPlay, onSprintModal, onRemove, onPause, onAutoDrainPauseToggle, onAutoDrainHardStop, onAutoDrainApprove, latestSprintFlags }: {
  project: Project; index?: number;
  sprintCount?: number;
  /** sprint_num of the currently active sprint record — sourced directly from the sprints table,
   *  not from projects.sprint_count, which can be inflated by failed sprint attempts. */
  activeSprintNum?: number;
  brief?: string | null;
  /** Infra-readiness blocker message stored on the project when pipeline fails pre-flight. */
  lastError?: string | null;
  state?: ActionState;
  status: string; canStart: boolean;
  /** Shown in the Start tooltip when canStart=false (e.g. "Factory at capacity (3/3)"). */
  blockedReason?: string;
  runs?: AgentRun[];
  onPlay?: () => void;
  onSprintModal?: () => void;
  onRemove: () => void;
  onPause?: () => void;
  /** Toggle auto_drain_pause_requested on/off — only wired for autonomous projects. */
  onAutoDrainPauseToggle?: () => void;
  /** Cancel in-flight sprint AND set auto_drain_pause_requested — only when running and autonomous. */
  onAutoDrainHardStop?: () => void;
  /** Clear auto_drain_awaiting_approval — release the per-sprint approval gate. */
  onAutoDrainApprove?: () => void;
  /** Verdict + needs_human flags for the project's most-recent sprint. Drives
   *  the "needs review" badge so operators can spot stalled discoveries / no-diff
   *  executions without opening each sprint. */
  latestSprintFlags?: LatestSprintFlags;
}) {
  const isLoading = state?.loading ?? false;
  const isPaused  = status === "paused" || status === "waiting";
  const isRunning = status === "running";
  // Sprint number to display in tooltips:
  //   - If there's an active sprint record → use its sprint_num (source of truth)
  //   - If paused (sprint exists, sprint_count = current num) → use sprint_count
  //   - Otherwise (queued, no sprint yet) → next sprint = sprint_count + 1
  const displaySprintNum = activeSprintNum
    ?? (isPaused ? (sprintCount ?? 1) : (sprintCount ?? 0) + 1);
  const [runsOpen, setRunsOpen] = useState(false);

  const sortedRuns = runs ? [...runs].sort((a, b) => (a.step ?? 0) - (b.step ?? 0)) : [];

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{
        borderRadius: 10, background: "var(--surface0)",
        border: isRunning ? "1px solid rgba(20,99,255,0.3)" : "1px solid var(--surface1)",
        borderLeft: isRunning ? "3px solid #1463ff" : undefined,
        overflow: "hidden",
      }}>
        {/* Main row */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px" }}>
          {index !== undefined && (
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", width: 18, textAlign: "center", flexShrink: 0 }}>
              #{index}
            </span>
          )}

          {/* Project info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
              {project.name}
              {(() => {
                // Tri-modal: orchestration_mode wins; fall back to deriving
                // from execution_backend for legacy rows. local and local-git
                // share execution_backend="local" so we need orchestration_mode
                // to render the right badge.
                const cliCfg = ((project as DBProject).settings?.cli_agents as {
                  execution_backend?: string;
                  orchestration_mode?: "cloud" | "local" | "local-git";
                } | undefined);
                const mode: "cloud" | "local" | "local-git" =
                  cliCfg?.orchestration_mode
                  ?? (cliCfg?.execution_backend === "local" ? "local" : "cloud");
                const visual =
                  mode === "local-git" ? { bg: "rgba(203,166,247,0.12)", fg: "var(--mauve)", icon: <GitBranch size={8} />, label: "local + git", title: "Local + Git execution" }
                  : mode === "local"   ? { bg: "rgba(166,227,161,0.12)", fg: "var(--green)", icon: <FolderOpen size={8} />, label: "local",       title: "Local execution" }
                  :                      { bg: "rgba(20,99,255,0.10)",   fg: "var(--blue)",  icon: <Cloud size={8} />,      label: "cloud",       title: "Cloud execution" };
                return (
                  <span title={visual.title} style={{
                    display: "inline-flex", alignItems: "center", gap: 2,
                    fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 700,
                    background: visual.bg, color: visual.fg, flexShrink: 0,
                  }}>
                    {visual.icon}{visual.label}
                  </span>
                );
              })()}
              {(() => {
                // Autonomous badge — shown when execution_mode is kanban_auto.
                // Three sub-states: paused, awaiting approval, active.
                if ((project as DBProject).execution_mode !== "kanban_auto") return null;
                const projSettings = (project as DBProject).settings as {
                  auto_drain_pause_requested?: boolean;
                  auto_drain_awaiting_approval?: boolean;
                } | null | undefined;
                const paused = projSettings?.auto_drain_pause_requested === true;
                const awaitingApproval = projSettings?.auto_drain_awaiting_approval === true;
                const visual = paused
                  ? { bg: "rgba(245,159,0,0.12)", fg: "var(--yellow, #df8e1d)", label: "autonomous · paused", title: "Auto-drain enabled but paused — dispatcher skips this project until you resume" }
                  : awaitingApproval
                    ? { bg: "rgba(28,191,107,0.12)", fg: "var(--green, #1cbf6b)", label: "autonomous · awaiting approval", title: "Last sprint completed — click Approve to release the loop for the next dispatch" }
                    : { bg: "rgba(20,99,255,0.12)", fg: "var(--blue, #1463ff)",  label: "autonomous",                   title: "Auto-drain enabled — the dispatcher picks up the next backlog item on every tick" };
                return (
                  <span title={visual.title} style={{
                    display: "inline-flex", alignItems: "center", gap: 3,
                    fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 700,
                    background: visual.bg, color: visual.fg, flexShrink: 0,
                  }}>
                    <Bot size={9} />{visual.label}
                  </span>
                );
              })()}
              {(() => {
                // Sprint outcome badge — surfaces when the latest sprint
                // requires human attention (no-output discovery, no-diff
                // execution, agent failures). Hidden during active runs
                // (the running indicator already takes the slot) and when
                // no recent sprint has flagged review.
                if (isRunning || !latestSprintFlags?.needs_human) return null;
                const tooltip = [
                  `Sprint #${latestSprintFlags.sprint_num} needs review`,
                  latestSprintFlags.reason,
                  latestSprintFlags.needs_human_reason,
                  latestSprintFlags.suggested_action ? `→ ${latestSprintFlags.suggested_action}` : null,
                ].filter(Boolean).join("\n\n");
                return (
                  <span title={tooltip} style={{
                    display: "inline-flex", alignItems: "center", gap: 3,
                    fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 700,
                    background: "rgba(245,159,0,0.18)", color: "var(--yellow, #df8e1d)", flexShrink: 0,
                    cursor: "help",
                  }}>
                    <AlertTriangle size={9} />needs review
                  </span>
                );
              })()}
              {(() => {
                // Auto-composed sprint badge — the pipeline-composer's proposal
                // drove this execution sprint's pipeline. Just informational.
                const ac = latestSprintFlags?.auto_composed;
                if (isRunning || !ac) return null;
                return (
                  <span title={`Pipeline auto-composed from discovery sprint (id: ${ac.source_sprint_id.slice(0, 8)}…)`} style={{
                    display: "inline-flex", alignItems: "center", gap: 3,
                    fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 700,
                    background: "rgba(203,166,247,0.14)", color: "var(--mauve, #cba6f7)", flexShrink: 0,
                    cursor: "help",
                  }}>
                    <Bot size={9} />auto-composed
                  </span>
                );
              })()}
              {(() => {
                // Local-git auto-push off: render a small "ready to push"
                // badge with the exact git push command in the tooltip.
                // Hidden during active runs and when there's nothing pending.
                const pp = latestSprintFlags?.pending_push;
                if (isRunning || !pp) return null;
                const branch = pp.branch ?? "<branch>";
                const tag    = pp.tag;
                const cmd = tag
                  ? `git push origin ${branch} && git push origin ${tag}`
                  : `git push origin ${branch}`;
                const tooltip = [
                  `Sprint #${latestSprintFlags!.sprint_num} committed locally — auto-push is off.`,
                  `Run in your project working tree:`,
                  cmd,
                ].join("\n\n");
                return (
                  <span title={tooltip} style={{
                    display: "inline-flex", alignItems: "center", gap: 3,
                    fontSize: 9, padding: "1px 5px", borderRadius: 4, fontWeight: 700,
                    background: "rgba(20,99,255,0.14)", color: "var(--blue, #1463ff)", flexShrink: 0,
                    cursor: "help",
                  }}>
                    <GitBranch size={9} />ready to push
                  </span>
                );
              })()}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
              <code style={{ fontSize: 10, color: "var(--overlay0)" }}>{project.slug}</code>
              {sprintCount !== undefined && sprintCount > 0 && (
                <span style={{ fontSize: 10, color: "var(--overlay0)", display: "flex", alignItems: "center", gap: 3 }}>
                  <GitBranch size={9} /> {sprintCount} sprint{sprintCount !== 1 ? "s" : ""}
                </span>
              )}
              {/* Show next sprint number when not running */}
              {!isRunning && (
                <span style={{ fontSize: 10, color: isPaused ? "var(--yellow, #df8e1d)" : "var(--blue, #1463ff)", fontWeight: 500 }}>
                  {isPaused ? `sprint ${displaySprintNum} paused` : `next: sprint ${displaySprintNum}`}
                </span>
              )}
              {isRunning && (
                sortedRuns.length > 0 ? (
                  <button
                    onClick={() => setRunsOpen((o) => !o)}
                    style={{
                      display: "flex", alignItems: "center", gap: 3,
                      background: "none", border: "none", cursor: "pointer",
                      color: "var(--subtext0)", fontSize: 10, padding: 0,
                      fontFamily: "var(--font-sans)",
                    }}
                  >
                    {runsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    sprint {displaySprintNum} · {sortedRuns.length} agent{sortedRuns.length !== 1 ? "s" : ""}
                  </button>
                ) : (
                  <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--overlay0)" }}>
                    <Loader2 size={9} style={{ animation: "spin 1s linear infinite" }} />
                    sprint {displaySprintNum} · initializing…
                  </span>
                )
              )}
            </div>
          </div>

          {!isPaused && !isRunning && <StatusBadge status={status} />}

          {/* Actions — icon only */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <PipelineIconBtn
              title="View in Studio (Project Settings + sprint history)"
              icon={<Layers size={13} />}
              color="var(--overlay0)"
              onClick={() => { window.location.href = `/projects?focus=${project.id}`; }}
              loading={false}
            />
            {(() => {
              // Prepare workspace — materialises CLAUDE.md / .claude/agents/
              // / .mcp.json at the project's local working dir without
              // dispatching a pipeline. Operator runs claude-code there
              // manually. Disabled for cloud (no local dir).
              const cliCfg = ((project as DBProject).settings?.cli_agents as {
                orchestration_mode?: "cloud" | "local" | "local-git";
                execution_backend?: "supabase" | "local";
              } | undefined);
              const mode: "cloud" | "local" | "local-git" =
                cliCfg?.orchestration_mode
                ?? (cliCfg?.execution_backend === "local" ? "local" : "cloud");
              const isCloud = mode === "cloud";
              return (
                <PipelineIconBtn
                  title={isCloud
                    ? "Prepare workspace — only available for local / local-git projects"
                    : "Prepare workspace — write CLAUDE.md, .claude/agents/, .mcp.json without dispatching a sprint"}
                  icon={<FolderOpen size={13} />}
                  color={isCloud ? "var(--overlay0)" : "var(--blue, #1463ff)"}
                  onClick={async () => {
                    if (isCloud) return;
                    try {
                      const res = await fetch(`/api/projects/${project.id}/prepare-workspace`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token ?? ""}`, "Content-Type": "application/json" },
                        body: JSON.stringify({}),
                      });
                      const body = await res.json() as { ok?: boolean; message?: string; error?: string };
                      if (!res.ok) alert(body.error ?? "Prepare workspace failed.");
                      else alert(body.message ?? "Workspace preparation dispatched.");
                    } catch (e) {
                      alert((e as Error).message);
                    }
                  }}
                  disabled={isCloud}
                  loading={false}
                />
              );
            })()}
            {(() => {
              // Run discovery — force-dispatch a discovery sprint regardless
              // of backlog state. Useful when the operator wants the PO to
              // refresh / refine the kanban without draining it first.
              // Hidden during active runs and paused projects.
              if (isRunning || status === "paused") return null;
              const proj = project as DBProject;
              const hasDiscoveryPipeline = Boolean(
                (proj as { discovery_pipeline_id?: string | null }).discovery_pipeline_id
                ?? (proj as { pipeline_id?: string | null }).pipeline_id,
              );
              if (!hasDiscoveryPipeline) return null;
              return (
                <PipelineIconBtn
                  title="Run discovery — dispatch a discovery sprint to refresh the backlog (skips the Start Sprint modal)"
                  icon={<Sparkles size={13} />}
                  color="var(--mauve, #cba6f7)"
                  onClick={async () => {
                    if (!confirm(`Run a discovery sprint for ${project.name}? Discovery agents will refresh / refine the backlog without draining existing items.`)) return;
                    try {
                      const sess = (await supabase.auth.getSession()).data.session;
                      const res = await fetch(`/api/projects/${project.id}/run`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${sess?.access_token ?? ""}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ intent: "discovery" }),
                      });
                      const body = await res.json() as { error?: string };
                      if (!res.ok) alert(body.error ?? "Discovery dispatch failed.");
                    } catch (e) {
                      alert((e as Error).message);
                    }
                  }}
                  disabled={false}
                  loading={isLoading}
                />
              );
            })()}
            {(() => {
              // Per-sprint approval gate — operator action. Worker sets
              // auto_drain_awaiting_approval=true after each sprint finishes
              // (when auto_drain_approval_required is on). The dispatcher
              // skips while this is true; clicking Approve releases the loop
              // for one cycle. Distinct icon (CheckCircle2) so it doesn't
              // visually collide with Resume / Play.
              if ((project as DBProject).execution_mode !== "kanban_auto" || !onAutoDrainApprove) return null;
              const projSettings = (project as DBProject).settings as { auto_drain_awaiting_approval?: boolean } | null | undefined;
              if (projSettings?.auto_drain_awaiting_approval !== true) return null;
              return (
                <PipelineIconBtn
                  title="Approve last sprint and let the autonomous loop dispatch the next one"
                  icon={<CheckCircle2 size={13} />}
                  color="var(--green, #1cbf6b)"
                  onClick={onAutoDrainApprove}
                  loading={isLoading}
                />
              );
            })()}
            {(() => {
              // Autonomous-mode pause/resume button. Visible only when the
              // project's execution_mode is kanban_auto. Independent from
              // the "pause current sprint" button — this controls whether
              // the cron will dispatch the NEXT sprint after the current
              // one finishes.
              if ((project as DBProject).execution_mode !== "kanban_auto" || !onAutoDrainPauseToggle) return null;
              const projSettings = (project as DBProject).settings as { auto_drain_pause_requested?: boolean } | null | undefined;
              const paused = projSettings?.auto_drain_pause_requested === true;
              return (
                <PipelineIconBtn
                  title={paused
                    ? "Resume autonomous loop — the daemon/cron starts dispatching the next backlog item again"
                    : "Pause autonomous loop — current sprint finishes naturally, no new dispatches until you resume"}
                  icon={paused ? <Bot size={13} /> : <Workflow size={13} />}
                  color={paused ? "var(--blue, #1463ff)" : "#f59f00"}
                  onClick={onAutoDrainPauseToggle}
                  loading={false}
                />
              );
            })()}
            {(() => {
              // Hard-stop: kills the in-flight sprint AND pauses auto-drain.
              // Only meaningful when the project is autonomous + currently
              // running — otherwise pause-now is graceful-pause's job.
              if ((project as DBProject).execution_mode !== "kanban_auto" || !onAutoDrainHardStop) return null;
              if (!isRunning) return null;
              const projSettings = (project as DBProject).settings as { auto_drain_pause_requested?: boolean } | null | undefined;
              if (projSettings?.auto_drain_pause_requested === true) return null;  // already paused
              return (
                <PipelineIconBtn
                  title="Hard-stop — cancel current sprint immediately and pause auto-drain. Use sparingly."
                  icon={<XCircle size={13} />}
                  color="var(--red, #d20f39)"
                  onClick={onAutoDrainHardStop}
                  loading={isLoading}
                />
              );
            })()}
            {isRunning ? (
              /* Running: only pause */
              <PipelineIconBtn
                title="Pause pipeline after current agent completes"
                icon={<Pause size={13} />}
                color="#f59f00"
                onClick={onPause}
                loading={isLoading}
              />
            ) : (
              <>
                {/* Play/Continue toggle */}
                <PipelineIconBtn
                  title={isPaused
                    ? `Continue Sprint ${displaySprintNum}`
                    : canStart
                      ? `Start Sprint ${displaySprintNum}`
                      : blockedReason ?? "Another project is running"}
                  icon={<Play size={13} />}
                  color="#1463ff"
                  onClick={onPlay}
                  disabled={!canStart && !isPaused}
                  loading={isLoading && !isPaused}
                />

                {/* Sprint modal */}
                <PipelineIconBtn
                  title={isPaused
                    ? `Restart Sprint ${displaySprintNum} — configure and re-run`
                    : `Configure Sprint ${displaySprintNum}`}
                  icon={isPaused ? <RotateCcw size={13} /> : <SkipForward size={13} />}
                  color="#00c2a8"
                  onClick={onSprintModal}
                  loading={false}
                />

                {/* Mark as completed removed — projects don't have a
                    completion concept. Only sprints do. To stop running
                    sprints on this project, leave it idle (`ready`) or
                    Archive it (Trash icon at the end of this row). */}
              </>
            )}

            {/* Remove */}
            <PipelineIconBtn
              title="Remove from pipeline"
              icon={<X size={13} />}
              color="var(--overlay1)"
              onClick={onRemove}
              disabled={isLoading || isRunning}
            />
          </div>
        </div>

        {/* Brief */}
        {brief && !isRunning && (
          <div style={{ padding: "0 14px 10px", paddingLeft: index !== undefined ? 44 : 14 }}>
            <p style={{ fontSize: 11, color: "var(--subtext0)", margin: 0, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {brief}
            </p>
          </div>
        )}

        {/* Infra-readiness error — shown when paused due to pre-flight failure */}
        {isPaused && lastError && (
          <div style={{
            padding: "6px 14px 10px",
            paddingLeft: index !== undefined ? 44 : 14,
            borderTop: "1px solid rgba(239,68,68,0.2)",
          }}>
            <p style={{
              fontSize: 11, color: "var(--red, #ef4444)", margin: 0, lineHeight: 1.5,
              display: "flex", alignItems: "flex-start", gap: 5,
            }}>
              <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
              {lastError}
            </p>
          </div>
        )}

        {/* Agent runs — collapsible, shown only when running and expanded */}
        {isRunning && runsOpen && sortedRuns.length > 0 && (
          <div style={{
            borderTop: "1px solid var(--surface1)",
            padding: "8px 14px 10px",
          }}>
            {sortedRuns.map((run) => (
              <div key={run.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "4px 0",
                borderBottom: "1px solid var(--surface1)",
              }}>
                <RunStatusIcon status={run.status} />
                <span style={{ fontSize: 11, color: "var(--overlay0)", width: 22, flexShrink: 0 }}>
                  {run.step ?? "—"}
                </span>
                <span style={{ fontSize: 12, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {run.agent}
                </span>
                {run.cost_usd > 0 && (
                  <span style={{ fontSize: 10, color: "var(--overlay0)", flexShrink: 0 }}>
                    ${run.cost_usd.toFixed(3)}
                  </span>
                )}
                {run.status === "failed" && run.error && (
                  <span title={run.error} style={{ fontSize: 10, color: "var(--red)", flexShrink: 0, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {run.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Inline feedback (error / CLI) */}
      {state?.msg && (() => {
        const isError = state.msg!.type === "error";
        return (
          <div style={{
            display: "flex", alignItems: "flex-start", gap: 8,
            padding: "8px 12px", borderRadius: 8, marginTop: 4,
            background: isError ? "rgba(228,75,95,0.08)" : "rgba(0,194,168,0.06)",
            border: `1px solid ${isError ? "rgba(228,75,95,0.25)" : "rgba(0,194,168,0.2)"}`,
            color: isError ? "var(--red)" : "var(--teal)", fontSize: 12,
          }}>
            {isError && <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />}
            <span style={{ flex: 1, fontFamily: isError ? "inherit" : "var(--font-mono)", fontSize: isError ? 12 : 11, wordBreak: "break-all" }}>
              {state.msg!.text}
            </span>
          </div>
        );
      })()}
    </div>
  );
}

/* ─── Available CLI agents ──────────────────────────────── */
// Ordered + tagged centrally in lib/types — keep an aliased id list so
// existing call sites that just want strings don't break.
const AVAILABLE_CLIS = CLI_OPTIONS.map((o) => o.id);

/* ─── Simple hover tooltip ─────────────────────────────── */
function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
          background: "var(--crust)", border: "1px solid var(--surface1)", borderRadius: 8,
          padding: "8px 12px", fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5,
          width: 260, zIndex: 400, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          pointerEvents: "none", whiteSpace: "normal",
        }}>
          {text}
        </div>
      )}
    </div>
  );
}

/* ─── Step routing type ────────────────────────────────── */
type StepRoutingMode = "api" | "cli-api" | "cli-subs";
interface StepRoutingEntry {
  mode: StepRoutingMode;
  cli?: string;
  /** Per-step model override. Empty / undefined falls back to the project
   *  cascade (planning/dev/governance category models, then default). */
  model?:     string;
  /** Claude Code reasoning effort — only meaningful when cli === "claude-code". */
  effort?:    "low" | "medium" | "high" | "max";
  /** Plan mode — agent proposes only, no writes. claude-code only. */
  planMode?:  boolean;
  /** Per-step budget cap in USD. claude-code only. */
  budgetUsd?: number;
}

const MODEL_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "claude-opus-4-7",            label: "Opus 4.7",   hint: "best reasoning · expensive" },
  { value: "claude-sonnet-4-6",          label: "Sonnet 4.6", hint: "balanced · default for dev" },
  { value: "claude-haiku-4-5-20251001",  label: "Haiku 4.5",  hint: "fast · cheap · local work" },
];

/* ─── Start Sprint Modal ─────────────────────────────── */
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

interface SprintSummary { id: string; sprint_num: number; status: string; created_at: string; completed_at: string | null; briefing: string | null; sprint_completed_saved?: boolean | null; config?: { mode?: string; [key: string]: unknown } | null }
interface SprintInfo {
  sprint_num: number;
  /** Sprint lifecycle status. Drives Office bucketing now that projects
   *  no longer carry pause/pending_save/waiting. */
  status: string;
  created_at: string;
  trigger_run_id: string | null;
  briefing: string | null;
  /** discovery / planning / execution / review — surfaced as a badge in the Agent Pipeline header. */
  intent: SprintIntent | null;
  /** The pipeline that was resolved for THIS sprint (intent-specific). The
   *  Agent Pipeline panel renders these instead of project.pipeline so a
   *  discovery sprint shows scout/intake/plm even when project.pipeline is
   *  the execution one. */
  steps: { step: number; agent: string; gate: string | null }[] | null;
}
/** Latest-sprint flags surfaced on the project card. Drives the "needs human"
 *  badge and tooltip. Populated alongside SprintInfo from the same realtime feed. */
interface LatestSprintFlags {
  sprint_num: number;
  needs_human: boolean;
  verdict: "success" | "no-output" | "partial" | "failed" | null;
  reason: string | null;
  needs_human_reason: string | null;
  suggested_action: string | null;
  /** local-git only: surfaces the manual push commands when auto-push is off. */
  pending_push: { branch: string | null; tag?: string } | null;
  /** Set when this execution sprint pulled its pipeline from a pipeline-composer
   *  proposal. Carries the source discovery sprint id for audit. */
  auto_composed: { source_sprint_id: string } | null;
}

function StartSprintModal({
  project, activeSprintStatus, session, runsMap, onClose, onStarted, onReview, initialOverrides,
}: {
  project: DBProject;
  /** Status of the project's active sprint (paused/waiting/pending_save/running)
   *  resolved by the parent from sprintInfoMap. Null when there's no active sprint. */
  activeSprintStatus: string | null;
  session: Session;
  runsMap: Map<string, AgentRun[]>;
  onClose: () => void;
  onStarted: (p: Project) => void;
  /** Open the Review modal with the current overrides. */
  onReview: (overrides: SprintRunOverrides) => void;
  /** Pre-seed the modal — used when returning from Review with Back. */
  initialOverrides?: SprintRunOverrides;
}) {
  // If there's an active sprint in progress (running) or one paused
  // mid-flight (paused/waiting/pending_save), sprint_count = current
  // sprint number. Otherwise (idle, no sprint started yet) the next
  // sprint number = sprint_count + 1.
  const hasActiveSprint =
    project.status === "running" ||
    activeSprintStatus === "paused" ||
    activeSprintStatus === "waiting" ||
    activeSprintStatus === "pending_save";
  const sprintNum = hasActiveSprint ? (project.sprint_count ?? 1) : (project.sprint_count ?? 0) + 1;

  // Determine if project has a configured default LLM
  const projProvider = project.settings?.default_provider ?? "";
  const projModel    = project.settings?.default_model ?? "";
  const hasProjectLLM = Boolean(projProvider);

  const cliCfg      = project.settings?.cli_agents as { enabled?: boolean; execution_mode?: "cloud" | "local"; default_cli?: string; agent_overrides?: Record<string, { enabled?: boolean; cli?: string }> } | undefined;
  const cliEnabled  = cliCfg?.enabled === true;
  // apiSteps/cliSteps moved below stepRouting declaration

  // Compute available resume steps for paused sprints
  const pipelineStepsAll = (project.pipeline ?? []) as { step: number; agent: string }[];
  const doneSteps = new Set(
    (runsMap.get(project.id) ?? [])
      .filter((r) => r.status === "done")
      .map((r) => r.step),
  );
  // Step N is available if: N === 1 OR step N-1 is done
  const availableSteps = pipelineStepsAll.filter(
    (s) => s.step === 1 || doneSteps.has(s.step - 1),
  );
  const autoResumeStep = availableSteps.length > 0
    ? Math.max(...availableSteps.map((s) => s.step))
    : 1;

  // ── Defaults from project settings ──────────────────────
  const projectDefaults = React.useMemo(() => {
    const cliCfg = project.settings?.cli_agents as {
      execution_backend?: string;
      orchestration_mode?: "cloud" | "local" | "local-git";
    } | undefined;
    // Tri-modal: prefer orchestration_mode (set when local-git is chosen);
    // fall back to deriving from execution_backend for legacy rows.
    const mode: "cloud" | "local" | "local-git" =
      cliCfg?.orchestration_mode
      ?? (cliCfg?.execution_backend === "supabase" ? "cloud" : "local");
    return {
      mode,
      bypassGates: true,
      llmSource:   (hasProjectLLM ? "project" : "global") as "project" | "global",
      provider:    projProvider,
      model:       projModel,
    };
  }, [project.settings, hasProjectLLM, projProvider, projModel]);

  // Mode lock — when off (default), the orchestration mode picker is
  // disabled and the project's stored mode is forced. The dispatcher does
  // the same enforcement server-side; this is the visual cue.
  const allowModeSwitch =
    (project.settings as { allow_mode_switch?: boolean } | undefined | null)?.allow_mode_switch === true;

  // ── Load last sprint config for inheritance ────────────
  const [lastSprintConfig, setLastSprintConfig] = useState<{
    mode?: string; provider?: string; model?: string;
    bypassGates?: boolean; stepRouting?: Record<string, unknown>;
  } | null>(null);

  useEffect(() => {
    supabase
      .from("sprints")
      .select("config")
      .eq("project_id", project.id)
      .not("config", "is", null)
      .order("sprint_num", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.config && typeof data.config === "object") {
          setLastSprintConfig(data.config as typeof lastSprintConfig);
        }
      });
  }, [project.id]);

  // ── Initialize from last sprint or project defaults ────
  const initMode = (lastSprintConfig?.mode as "cloud" | "local" | "local-git" | undefined) ?? projectDefaults.mode;
  const initBypass = lastSprintConfig?.bypassGates ?? projectDefaults.bypassGates;
  const initLlmSource = lastSprintConfig?.provider ? "global" as const : projectDefaults.llmSource;
  const initProvider = lastSprintConfig?.provider ?? projectDefaults.provider;
  const initModel = lastSprintConfig?.model ?? projectDefaults.model;

  const [briefing,         setBriefing]         = useState("");
  const [bypassGates,      setBypassGates]      = useState(initBypass);
  // Auto-close defaults to true: keeps the operator out of the
  // save/discard loop unless they explicitly opt in. Per-sprint —
  // overrides project setting via sprint.config.auto_close.
  const [autoClose,        setAutoClose]        = useState<boolean>(true);
  // "project" = use project settings (send undefined to API, let pipeline resolve)
  // "global"  = user picks explicitly from the live provider list
  const [llmSource,        setLlmSource]        = useState<"project" | "global">(initLlmSource);
  const [provider,         setProvider]         = useState(initProvider);
  const [model,            setModel]            = useState(initModel);
  // CLI execution mode — sprint-level override
  const [cliMode,          setCliMode]          = useState<"project" | "cloud" | "local" | "local-git">(initMode);

  // Update state when lastSprintConfig loads (async).
  // We DO NOT inherit `mode` from the previous sprint — always honour the
  // project's orchestration mode default. Inheriting mode was causing a
  // race where the user picked "Cloud" in the dialog, then the async fetch
  // of the previous sprint resolved and silently flipped them back to
  // "local" (or vice versa), so the sprint badge didn't match the toggle.
  useEffect(() => {
    if (!lastSprintConfig) return;
    if (lastSprintConfig.bypassGates !== undefined) setBypassGates(lastSprintConfig.bypassGates);
    if (lastSprintConfig.provider) { setLlmSource("global"); setProvider(lastSprintConfig.provider); }
    if (lastSprintConfig.model) setModel(lastSprintConfig.model);
  }, [lastSprintConfig]);

  // Reset to project defaults
  function resetToDefaults() {
    setCliMode(projectDefaults.mode);
    setBypassGates(projectDefaults.bypassGates);
    setLlmSource(projectDefaults.llmSource);
    setProvider(projectDefaults.provider);
    setModel(projectDefaults.model);
    setBriefing("");
    // stepRouting will reset via cliMode useEffect
  }
  const [running,          setRunning]          = useState(false);
  const [error,            setError]            = useState<string | null>(null);
  const [cliCmd,           setCliCmd]           = useState<string | null>(null);
  const [liveProviders,    setLiveProviders]    = useState<LiveProvider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);

  // Mode availability — fetched from /api/projects/[id]/mode-availability so
  // the buttons reflect the same matrix the /run route enforces. Pre-loaded
  // with all-enabled defaults so the modal renders before the fetch resolves.
  type ModeEvalUI = { enabled: boolean; reason?: string; severity?: "error" | "warning" };
  const [modeAvailability, setModeAvailability] = useState<{
    cloud: ModeEvalUI; local: ModeEvalUI; "local-git": ModeEvalUI;
  }>({ cloud: { enabled: true }, local: { enabled: true }, "local-git": { enabled: true } });
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${project.id}/mode-availability`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (r) => {
        if (!r.ok) return;
        const body = await r.json() as { cloud: ModeEvalUI; local: ModeEvalUI; "local-git": ModeEvalUI };
        if (!cancelled) setModeAvailability({ cloud: body.cloud, local: body.local, "local-git": body["local-git"] });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [project.id, session.access_token]);
  // Cross-sprint context
  const [contextOpen,      setContextOpen]      = useState(false);
  const [pastSprints,      setPastSprints]      = useState<SprintSummary[]>([]);
  const [loadingSprints,   setLoadingSprints]   = useState(false);
  const [contextSprintIds, setContextSprintIds] = useState<string[]>([]);
  const [contextCategories, setContextCategories] = useState<("specs" | "docs")[]>(["specs", "docs"]);
  // Resume step — only relevant when hasActiveSprint; "auto" = server-computed
  const [resumeStep,       setResumeStep]       = useState<number | "auto">("auto");
  // Backlog selection — TODOs for this project. Default-select the next
  // one (lowest order_index). The orchestrator flips selected items
  // todo → doing on dispatch and doing → done at sprint success.
  interface BacklogTodo { id: string; title: string; description: string | null; order_index: number }
  const [backlogTodos, setBacklogTodos]       = useState<BacklogTodo[]>([]);
  const [backlogSelected, setBacklogSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data: { session: sess } } = await supabase.auth.getSession();
      if (!sess) return;
      const res = await fetch(`/api/projects/${project.id}/backlog`, {
        headers: { Authorization: `Bearer ${sess.access_token}` },
      });
      if (!res.ok || cancelled) return;
      const body = await res.json() as { items: { id: string; title: string; description: string | null; status: string; order_index: number }[] };
      const todos = (body.items ?? [])
        .filter((it) => it.status === "todo")
        .sort((a, b) => a.order_index - b.order_index)
        .map((it) => ({ id: it.id, title: it.title, description: it.description, order_index: it.order_index }));
      setBacklogTodos(todos);
      if (todos[0]) setBacklogSelected(new Set([todos[0].id]));
    })();
    return () => { cancelled = true; };
  }, [project.id]);

  // ── Intent + intent-specific pipeline steps ─────────────────────────
  // Sprint intent mirrors the server's smart fallback in
  // /api/projects/[id]/run/route.ts:
  //   1. operator selected items   → execution (explicit)
  //   2. backlog has pending todos → execution (server picks first)
  //   3. backlog empty             → discovery
  // Without step 2 the modal badge said "discovery" but the server
  // would silently promote to execution on dispatch — confusing the
  // operator and tripping the discover_once gate.
  // Intent derivation mirrors /api/projects/[id]/run logic. Critical: when
  // the backlog is empty, we don't blindly fall to discovery — discovery
  // only makes sense if the project has a discovery pipeline AND the
  // operator isn't providing a task source. When briefing/intake/PRD
  // exists, the operator already has a task in mind; promote to execution
  // so the verdict labels match what's actually happening.
  const hasDiscoveryPipeline = Boolean((project as { discovery_pipeline_id?: string | null }).discovery_pipeline_id);
  const hasOperatorTask = Boolean(
    (briefing?.trim()) ||
    ((project as { intake_brief?: string | null }).intake_brief ?? "").trim() ||
    ((project as { prd_md?: string | null }).prd_md ?? "").trim(),
  );
  // Heuristic suggestion (legacy 2-intent). Migration 169 added Planning
  // + Review intents; the API-side heuristic in /run covers all four when
  // project.heuristic_intent=true. Here we only pre-fill the UI's badge.
  const heuristicSprintIntent: SprintIntent =
    backlogSelected.size > 0 ? "execution"
    : backlogTodos.length > 0 ? "execution"
    : (!hasDiscoveryPipeline && hasOperatorTask) ? "execution"
    : "discovery";

  // Operator picks an intent explicitly when project.heuristic_intent is
  // false. null = use heuristic. The picker UI below the briefing flips
  // pickedIntent; buildOverrides forwards it as body.intent so the API
  // honours the operator's choice.
  const projectHeuristicIntent =
    Boolean(((project as { heuristic_intent?: boolean }).heuristic_intent) ?? false);
  const [pickedIntent, setPickedIntent] = useState<SprintIntent | null>(null);
  const sprintIntent: SprintIntent = pickedIntent ?? heuristicSprintIntent;
  const intentAutoPromoted =
    pickedIntent === null
    && backlogSelected.size === 0
    && backlogTodos.length === 0
    && !hasDiscoveryPipeline
    && hasOperatorTask;
  const intentPipelineId = sprintIntent === "discovery"
    ? ((project as { discovery_pipeline_id?: string | null }).discovery_pipeline_id ?? null)
    : ((project as { execution_pipeline_id?: string | null }).execution_pipeline_id ?? null);

  const projectDefaultPipelineId = (project as { pipeline_id?: string | null }).pipeline_id ?? null;
  const [intentPipelineSteps, setIntentPipelineSteps] = useState<{ step: number; agent: string; phaseName?: string }[] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    if (!intentPipelineId || intentPipelineId === projectDefaultPipelineId) {
      setIntentPipelineSteps(null);
      return () => { cancelled = true; };
    }
    void supabase
      .from("pipelines")
      .select("steps")
      .eq("id", intentPipelineId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        if (data?.steps && Array.isArray(data.steps)) {
          setIntentPipelineSteps(data.steps as { step: number; agent: string; phaseName?: string }[]);
        } else {
          setIntentPipelineSteps(null);
        }
      });
    return () => { cancelled = true; };
  }, [intentPipelineId, projectDefaultPipelineId]);

  // Effective pipeline steps for the chosen intent. Default pipeline
  // (project.pipeline JSONB) is the fallback when no intent-specific
  // pipeline is configured OR when its steps haven't loaded yet.
  const pipelineSteps = (intentPipelineSteps ?? (project.pipeline ?? [])) as { step: number; agent: string; phaseName?: string }[];
  const stepModes = pipelineSteps.map((s) => {
    const override = cliEnabled ? (cliCfg?.agent_overrides?.[s.agent] ?? null) : null;
    const usesCli  = override?.enabled === true;
    return { ...s, usesCli, cli: usesCli ? (override?.cli ?? "cli") : null };
  });

  // Which pipeline these steps came from — drives the inline source label.
  // intentPipelineSteps loaded => intent-specific. Otherwise project default.
  const pipelineSource: SprintIntent | "default" =
    intentPipelineSteps !== null
      ? sprintIntent
      : "default";

  // Per-step sprint instructions: stepNum → { text, override }
  const [stepInstructions, setStepInstructions] = useState<Map<number, { text: string; override: boolean }>>(new Map());
  // Which step's instruction modal is open (null = none)
  const [editingStep,      setEditingStep]      = useState<number | null>(null);
  // Draft state for the open instruction editor
  const [draftText,        setDraftText]        = useState("");
  const [draftOverride,    setDraftOverride]    = useState(false);
  // Which step has the per-step CLI tuning row expanded (null = none)
  const [tunedStep,        setTunedStep]        = useState<number | null>(null);
  // Per-step routing overrides (sprint-level)
  const [stepRouting,      setStepRouting]      = useState<Map<number, StepRoutingEntry>>(() => {
    const m = new Map<number, StepRoutingEntry>();
    // Both local execution modes default to CLI SUBS — they run on the
    // operator's machine and lean on the CLI's subscription session.
    // Cloud falls back to API so each agent calls the provider directly.
    const defaultToCli = cliMode === "local" || cliMode === "local-git";
    stepModes.forEach((s) => {
      if (s.usesCli || defaultToCli) {
        m.set(s.step, { mode: "cli-subs", cli: s.cli ?? "claude-code" });
      } else {
        m.set(s.step, { mode: "api" });
      }
    });
    return m;
  });

  // Skip the next cliMode reset — used during hydration so the routing
  // pulled from initialOverrides isn't immediately clobbered by the default
  // reset that fires when we set cliMode.
  const skipNextCliModeReset = useRef(false);

  // When cliMode changes, reset all steps to match the mode
  useEffect(() => {
    if (skipNextCliModeReset.current) { skipNextCliModeReset.current = false; return; }
    setStepRouting(() => {
      const m = new Map<number, StepRoutingEntry>();
      // Both local execution modes default to CLI SUBS — they run on the
      // operator's machine and lean on the CLI's subscription session.
      const defaultToCli = cliMode === "local" || cliMode === "local-git";
      stepModes.forEach((s) => {
        if (defaultToCli) {
          m.set(s.step, { mode: "cli-subs", cli: s.cli ?? "claude-code" });
        } else {
          m.set(s.step, { mode: "api" });
        }
      });
      return m;
    });
  }, [cliMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // When the active pipeline changes (sprintIntent flip discovery <-> execution
  // loads a different pipeline async), fully rebuild stepRouting from the
  // cliMode default — same shape the cliMode-change effect produces. Why
  // not preserve operator overrides: the agents themselves may have
  // changed (discovery and execution pipelines often have disjoint
  // squads), so an entry keyed by step number can't be reliably
  // re-applied to a different agent. Resetting is predictable; the
  // operator re-picks per-step routing on intent flip.
  const pipelineSignature = stepModes.map((s) => `${s.step}:${s.agent}`).join("|");
  useEffect(() => {
    if (skipNextCliModeReset.current) return; // hydration already populated
    setStepRouting(() => {
      const m = new Map<number, StepRoutingEntry>();
      const defaultToCli = cliMode === "local" || cliMode === "local-git";
      stepModes.forEach((s) => {
        if (s.usesCli || defaultToCli) {
          m.set(s.step, { mode: "cli-subs", cli: s.cli ?? "claude-code" });
        } else {
          m.set(s.step, { mode: "api" });
        }
      });
      return m;
    });
  }, [pipelineSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate state from initialOverrides on mount. Used when reopening from
  // the Review modal's "Back" so the operator returns to exactly the same
  // configuration they sent over for review.
  useEffect(() => {
    if (!initialOverrides) return;
    if (initialOverrides.briefing !== undefined)            setBriefing(initialOverrides.briefing);
    if (initialOverrides.bypassGates !== undefined)         setBypassGates(initialOverrides.bypassGates);
    if (initialOverrides.contextSprintIds)                  setContextSprintIds(initialOverrides.contextSprintIds);
    if (initialOverrides.contextCategories)                 setContextCategories(initialOverrides.contextCategories);
    if (typeof initialOverrides.startFromStep === "number") setResumeStep(initialOverrides.startFromStep);
    if (initialOverrides.provider) {
      setLlmSource("global");
      setProvider(initialOverrides.provider);
    }
    if (initialOverrides.model) {
      setLlmSource("global");
      setModel(initialOverrides.model);
    }
    if (initialOverrides.agentInstructions) {
      const m = new Map<number, { text: string; override: boolean }>();
      for (const [k, v] of Object.entries(initialOverrides.agentInstructions)) m.set(Number(k), v);
      setStepInstructions(m);
    }
    if (initialOverrides.cliExecutionMode || initialOverrides.stepRoutingOverrides) {
      skipNextCliModeReset.current = true;
      if (initialOverrides.cliExecutionMode) setCliMode(initialOverrides.cliExecutionMode);
      if (initialOverrides.stepRoutingOverrides) {
        const m = new Map<number, StepRoutingEntry>();
        for (const [k, v] of Object.entries(initialOverrides.stepRoutingOverrides)) {
          if (!v.cliOverride.enabled) {
            m.set(Number(k), { mode: "api" });
          } else {
            m.set(Number(k), {
              mode: v.cliOverride.authMode === "api-key" ? "cli-api" : "cli-subs",
              cli:  (v.cliOverride.cli as StepRoutingEntry["cli"]) ?? "claude-code",
              ...(v.cliOverride.model                ? { model:     v.cliOverride.model     } : {}),
              ...(v.cliOverride.effort               ? { effort:    v.cliOverride.effort    } : {}),
              ...(v.cliOverride.planMode             ? { planMode:  v.cliOverride.planMode  } : {}),
              ...(v.cliOverride.budgetUsd !== undefined ? { budgetUsd: v.cliOverride.budgetUsd } : {}),
            });
          }
        }
        setStepRouting(m);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive apiSteps/cliSteps from stepRouting (reflects modal changes)
  const apiSteps = stepModes.filter((s) => (stepRouting.get(s.step)?.mode ?? "api") === "api");
  const cliSteps = stepModes.filter((s) => (stepRouting.get(s.step)?.mode ?? "api") !== "api");

  useEffect(() => {
    if (!contextOpen || pastSprints.length > 0 || loadingSprints) return;
    setLoadingSprints(true);
    fetch(`/api/projects/${project.id}/sprints`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then(async (res) => {
        if (res.ok) {
          const body = await res.json() as { sprints: SprintSummary[] };
          setPastSprints(body.sprints ?? []);
        }
      })
      .finally(() => setLoadingSprints(false));
  }, [contextOpen, pastSprints.length, loadingSprints, project.id, session.access_token]);

  useEffect(() => {
    setLoadingProviders(true);
    fetch("/api/wizard/models", { headers: { Authorization: `Bearer ${session.access_token}` } })
      .then(async (res) => {
        if (res.ok) {
          const body = await res.json() as { providers: LiveProvider[] };
          const providers = body.providers ?? [];
          setLiveProviders(providers);
          if (providers[0]) { setProvider(providers[0].id); setModel(providers[0].models[0]?.id ?? ""); }
        }
      })
      .finally(() => setLoadingProviders(false));
  }, [session]);

  /**
   * Build the override payload from the current modal state. Used by both
   * `handleStart` (direct dispatch) and `handleReview` (open the Review
   * modal). The Review modal composes a SprintPlan from this same shape
   * and dispatches via plan id once the operator confirms.
   */
  function buildOverrides(): SprintRunOverrides {
    const useProjectSettings = llmSource === "project";
    return {
      briefing:            briefing || undefined,
      bypassGates:         bypassGates || undefined,
      provider:            useProjectSettings ? undefined : provider,
      model:               useProjectSettings ? undefined : model,
      cliExecutionMode:    cliMode === "project" ? undefined : cliMode,
      ...(contextSprintIds.length > 0 ? { contextSprintIds } : {}),
      ...(contextSprintIds.length > 0 && contextCategories.length < 2 ? { contextCategories } : {}),
      ...(hasActiveSprint && resumeStep !== "auto" ? { startFromStep: resumeStep } : {}),
      ...(stepInstructions.size > 0 ? {
        agentInstructions: Object.fromEntries(
          [...stepInstructions.entries()].map(([step, v]) => [String(step), v])
        ),
      } : {}),
      ...(stepRouting.size > 0 ? {
        stepRoutingOverrides: Object.fromEntries(
          [...stepRouting.entries()].map(([step, r]) => [
            String(step),
            r.mode === "api"
              ? { cliOverride: { enabled: false } }
              : { cliOverride: {
                  enabled: true,
                  cli:     r.cli ?? "claude-code",
                  authMode: r.mode === "cli-api" ? "api-key" as const : "oauth" as const,
                  ...(r.model                ? { model:     r.model     } : {}),
                  ...(r.effort               ? { effort:    r.effort    } : {}),
                  ...(r.planMode             ? { planMode:  r.planMode  } : {}),
                  ...(r.budgetUsd !== undefined ? { budgetUsd: r.budgetUsd } : {}),
                } },
          ])
        ),
      } : {}),
      ...(backlogSelected.size > 0 ? { backlogItemIds: [...backlogSelected] } : {}),
      // Always forward the auto-close decision so the worker doesn't need
      // to fall back to project setting + global default.
      autoClose,
      // Send intent explicitly — the UI already shows "execution"/"discovery"
      // as a colored badge in the modal, so the server gets the same answer
      // the operator saw. Avoids the foot-gun where the server defaulted to
      // discovery whenever no items were picked.
      intent: sprintIntent,
    };
  }

  /** Direct dispatch — unchanged behaviour from before the Review flow. */
  async function handleStart() {
    setRunning(true); setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildOverrides()),
      });
      let body: { triggered?: boolean; cli_command?: string | null; error?: string } = {};
      try { body = await res.json(); } catch { /* non-JSON response (e.g. 504) */ }
      if (res.status === 429) { setError("Factory is at its concurrent project limit. Wait for a running sprint to finish, or raise Max concurrent projects in Factory Settings."); return; }
      if (!res.ok) { setError(body.error ?? `Start failed (${res.status}).`); return; }
      if (body.cli_command) { setCliCmd(body.cli_command); return; }
      if (!body.triggered) { setError("Trigger.dev not configured. Check Integrations → Platforms."); return; }
      onStarted({ ...project, status: "running" as Project["status"] });
    } catch (e) {
      setError((e as Error).message ?? "Network error — could not reach server.");
    } finally {
      setRunning(false);
    }
  }

  /** Hand the current overrides up to the parent, which closes us and opens Review. */
  function handleReview() {
    setError(null);
    onReview(buildOverrides());
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div style={{
        background: "var(--mantle)",
        border: "1px solid var(--surface0)",
        borderRadius: 18,
        // Wider canvas (was 520) so per-step routing rows fit without
        // wrapping awkwardly. Cap at 95vw on small screens.
        width: "min(760px, 95vw)",
        // Cap height to viewport with scroll when content overflows —
        // operators on shorter screens couldn't reach the Start button
        // because pipeline + tuning sections pushed it offscreen.
        maxHeight: "92vh",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
      }}>
        {/* Sticky header — Reset / Close stay reachable while scrolling. */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "20px 24px 12px", borderBottom: "1px solid var(--surface0)",
          background: "var(--mantle)", borderTopLeftRadius: 18, borderTopRightRadius: 18,
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Start Sprint {sprintNum}</div>
            <div style={{ fontSize: 11, color: "var(--overlay0)" }}>{project.name}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={resetToDefaults} title="Reset to project defaults" style={{
              display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderRadius: 6,
              border: "1px solid var(--surface1)", background: "transparent",
              color: "var(--overlay0)", fontSize: 10, cursor: "pointer", fontFamily: "var(--font-sans)",
            }}>
              <RotateCcw size={10} /> Reset
            </button>
            <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)" }}><X size={16} /></button>
          </div>
        </div>

        {/* Scrollable body — pipeline + tuning + briefing sections grow
         *  past the viewport on small screens; this region absorbs the
         *  overflow while header (Reset/Close) and footer (Start/Review)
         *  stay reachable. */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 20px" }}>

        {cliCmd ? (
          <>
            <div style={{ background: "var(--crust)", border: "1px solid var(--surface0)", borderRadius: 10, padding: "12px 16px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--green)", marginBottom: 12 }}>{cliCmd}</div>
            <button onClick={onClose} style={{ width: "100%", padding: "9px", borderRadius: 9, border: "none", background: "#1463ff", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Close</button>
          </>
        ) : (
          <>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Sprint briefing <span style={{ fontWeight: 400 }}>(optional)</span></label>
              <textarea value={briefing} onChange={(e) => setBriefing(e.target.value)}
                placeholder={project.intake_brief ?? "Any specific focus for this sprint?"}
                rows={3} style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }} />
            </div>

            {/* Auto-close toggle — controls how this sprint resolves at
             *  end. Default ON: success auto-promotes to completed, failure
             *  is auto-acknowledged (no operator action required). Off
             *  forces the manual save/discard or finalize loop. */}
            <label style={{
              display: "flex", alignItems: "center", gap: 10, marginBottom: 14,
              padding: "8px 10px", borderRadius: 8,
              background: "var(--crust)", border: "1px solid var(--surface0)",
              cursor: "pointer", fontFamily: "var(--font-sans)",
            }}>
              <input
                type="checkbox"
                checked={autoClose}
                onChange={(e) => setAutoClose(e.target.checked)}
                style={{ width: 14, height: 14, cursor: "pointer" }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                  Auto-close on completion
                </span>
                <span style={{ display: "block", fontSize: 10, color: "var(--overlay0)", marginTop: 2, lineHeight: 1.4 }}>
                  {autoClose
                    ? "Sprint promotes itself: success → completed, failure → acknowledged (no manual action)."
                    : "Sprint stops at pending_save or failed. You decide save/discard or finalize manually."}
                </span>
              </span>
            </label>

            {/* ── Backlog items ── (only when there are TODOs) */}
            {backlogTodos.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>
                  Backlog items
                  <span style={{ fontWeight: 400, marginLeft: 6, color: "var(--overlay0)" }}>
                    ({backlogSelected.size}/{backlogTodos.length})
                  </span>
                  <a href={`/projects/${project.id}/backlog`} target="_blank" rel="noreferrer"
                    style={{ fontSize: 10, color: "var(--blue)", textDecoration: "none", marginLeft: 8, fontWeight: 500 }}>
                    Manage backlog →
                  </a>
                </label>
                <div style={{
                  display: "flex", flexDirection: "column", gap: 4,
                  maxHeight: 160, overflowY: "auto",
                  background: "var(--crust)", borderRadius: 8, padding: "6px 8px",
                  border: "1px solid var(--surface0)",
                }}>
                  {backlogTodos.map((it) => {
                    const checked = backlogSelected.has(it.id);
                    return (
                      <label key={it.id} style={{
                        display: "flex", alignItems: "flex-start", gap: 8,
                        padding: "4px 6px", borderRadius: 5, cursor: "pointer",
                        background: checked ? "rgba(20,99,255,0.06)" : "transparent",
                      }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setBacklogSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(it.id); else next.delete(it.id);
                            return next;
                          })}
                          style={{ width: 13, height: 13, accentColor: "var(--blue)", flexShrink: 0, marginTop: 2 }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: checked ? 600 : 500, color: checked ? "var(--text)" : "var(--subtext0)", lineHeight: 1.4 }}>
                            {it.title}
                          </div>
                          {it.description && (
                            <div style={{
                              fontSize: 10, color: "var(--overlay0)", lineHeight: 1.4, marginTop: 1,
                              display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden",
                            }}>
                              {it.description}
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4, lineHeight: 1.5 }}>
                  Selected items flip to <strong>Doing</strong> when the sprint starts and <strong>Done</strong> on success. Failed sprints leave them in <strong>Doing</strong> for the operator to decide.
                </div>
              </div>
            )}

            {/* ── Orchestration Mode ── */}
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>
                Orchestration Mode
                {!allowModeSwitch && (
                  <span style={{
                    marginLeft: 8, fontSize: 10, fontWeight: 600,
                    padding: "2px 7px", borderRadius: 99,
                    background: "rgba(245,159,0,0.12)", color: "var(--peach)",
                    textTransform: "uppercase", letterSpacing: "0.04em",
                  }}>
                    Locked
                  </span>
                )}
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                {([
                  { id: "cloud"     as const, label: "Cloud",       tooltip: "Tasks run entirely on Trigger.dev cloud workers. Artifacts are stored in Supabase and can be downloaded or pushed to Git." },
                  { id: "local"     as const, label: "Local",       tooltip: "Tasks orchestrated by Trigger.dev but executed on your machine via `trigger dev`. Use CLIs with subscription. Each sprint writes to its own staging/sprint-N/ folder." },
                  { id: "local-git" as const, label: "Local + Git", tooltip: "Local execution where artifacts are versioned at the project root via git. Each sprint mutates the live tree and (by default) auto-commits + tags at sprint end. Phase 1: type-only — runtime currently behaves like Local; git pre/post-flight ops land in Phase 2." },
                ] as const).map((opt) => {
                  const active = cliMode === opt.id;
                  const lockedOut = !allowModeSwitch && cliMode !== opt.id;
                  const evalForMode = modeAvailability[opt.id];
                  const unavailable = !evalForMode.enabled;
                  const disabled = lockedOut || unavailable;
                  const tooltipReason =
                    lockedOut    ? "Project is mode-locked. Toggle 'Allow per-sprint mode switching' in Project Settings to unlock."
                  : unavailable  ? evalForMode.reason ?? "This mode is unavailable for this project."
                  : evalForMode.severity === "warning" ? evalForMode.reason
                  : undefined;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => { if (!disabled) setCliMode(opt.id); }}
                      disabled={disabled}
                      title={tooltipReason}
                      style={{
                        display: "flex", alignItems: "center", gap: 7,
                        padding: "7px 14px", borderRadius: 8,
                        cursor: disabled ? "not-allowed" : "pointer",
                        opacity: disabled ? 0.4 : 1,
                        border: `1.5px solid ${active ? "rgba(20,99,255,0.5)" : "var(--surface1)"}`,
                        background: active ? "rgba(20,99,255,0.08)" : "var(--surface0)",
                        color: active ? "#1463ff" : "var(--subtext0)",
                        fontSize: 13, fontWeight: active ? 700 : 400, fontFamily: "var(--font-sans)",
                      }}
                    >
                      <span style={{ fontSize: 15, lineHeight: 1 }}>{active ? "\u25CF" : "\u25CB"}</span>
                      {opt.label}
                      <Tooltip text={opt.tooltip}>
                        <HelpCircle size={13} style={{ color: "var(--overlay0)", cursor: "help" }} />
                      </Tooltip>
                    </button>
                  );
                })}
              </div>
              {!allowModeSwitch && (
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 6, lineHeight: 1.5 }}>
                  Mode is fixed by the project. Open <strong>Project Settings &rarr; Orchestration Mode</strong> and turn on <em>Allow per-sprint mode switching</em> to override per sprint.
                </div>
              )}
            </div>

            <div style={{ borderTop: "1px solid var(--surface0)", margin: "14px 0" }} />

            {/* ── Sprint plan — agents that will run + per-step routing ── */}
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Sprint plan</label>

              {/* Operator-picked intent (only when project.heuristic_intent=false).
                  Replaces the heuristic — sprintIntent then drives which
                  pipeline loads + which intent is sent to /run. */}
              {!projectHeuristicIntent && (
                <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Intent</span>
                  {([
                    { id: "discovery", label: "Discovery", color: "var(--blue)"   },
                    { id: "planning",  label: "Planning",  color: "var(--mauve)"  },
                    { id: "execution", label: "Execution", color: "var(--green)"  },
                    { id: "review",    label: "Review",    color: "var(--peach)"  },
                  ] as const).map((opt) => {
                    const active = sprintIntent === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setPickedIntent(opt.id)}
                        title={`Run as ${opt.label}`}
                        style={{
                          padding: "3px 9px", borderRadius: 4,
                          border: `1px solid ${active ? opt.color : "var(--surface1)"}`,
                          background: active ? `${opt.color}18` : "transparent",
                          color:      active ? opt.color : "var(--subtext0)",
                          fontSize: 10, fontWeight: 700, cursor: "pointer",
                          fontFamily: "var(--font-sans)",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                  {pickedIntent !== null && (
                    <button
                      type="button"
                      onClick={() => setPickedIntent(null)}
                      title="Reset to heuristic"
                      style={{
                        padding: "3px 7px", borderRadius: 4, border: "1px dashed var(--surface1)",
                        background: "transparent", color: "var(--overlay0)",
                        fontSize: 10, cursor: "pointer", fontFamily: "var(--font-sans)",
                      }}
                    >
                      Auto
                    </button>
                  )}
                </div>
              )}

              {/* Pipeline source line — makes it obvious which of the
                  project's pipelines is loaded right now. Sprint intent
                  is derived from backlog selection, so the operator
                  can see WHY this set of steps appeared. */}
              {stepModes.length > 0 && (
                <div style={{
                  fontSize: 11, color: "var(--subtext0)", marginBottom: 8, lineHeight: 1.5,
                  padding: "6px 10px", borderRadius: 6, background: "var(--mantle)",
                  border: "1px solid var(--surface0)",
                }}>
                  Steps loaded from your{" "}
                  <strong style={{ color: pipelineSource === "execution" ? "var(--green)" : pipelineSource === "discovery" ? "var(--mauve)" : "var(--blue)" }}>
                    {pipelineSource === "default" ? "default" : pipelineSource}
                  </strong>{" "}
                  pipeline ({sprintIntent} intent).{" "}
                  {sprintIntent === "execution" && backlogSelected.size === 0 && backlogTodos.length > 0 && (
                    <span style={{ color: "var(--overlay0)" }}>
                      No items selected — the dispatcher will pick the first todo (<em>{backlogTodos[0]?.title}</em>). Tick items below to override.
                    </span>
                  )}
                  {sprintIntent === "execution" && backlogSelected.size > 0 && (
                    <span style={{ color: "var(--overlay0)" }}>
                      {backlogSelected.size} item{backlogSelected.size === 1 ? "" : "s"} selected.
                    </span>
                  )}
                  {sprintIntent === "discovery" && (
                    <span style={{ color: "var(--overlay0)" }}>Backlog is empty — discovery agents can populate it via the <code>add_backlog_items</code> MCP tool.</span>
                  )}
                  {sprintIntent === "execution" && intentAutoPromoted && (
                    <span style={{ color: "var(--mauve)" }}>
                      Backlog empty AND no discovery pipeline configured — running this as <strong>execution</strong> with your briefing/PRD as the task. To run discovery instead, configure a Discovery pipeline in Project Settings.
                    </span>
                  )}
                </div>
              )}

              {/* Empty state — project has no pipeline. Block visibly and
                  hint the operator at the fix instead of letting them hit
                  Start and get a generic 422 from the backend. */}
              {stepModes.length === 0 && (
                <div style={{
                  padding: "12px 14px", borderRadius: 8,
                  background: "rgba(245,159,0,0.06)",
                  border: "1px dashed rgba(245,159,0,0.3)",
                  color: "var(--peach)", fontSize: 12, lineHeight: 1.5,
                }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>No pipeline assigned</div>
                  <div style={{ color: "var(--subtext0)" }}>
                    Open <strong>Project Settings → Pipeline</strong> and pick one before starting a sprint. The sprint can&apos;t run without steps.
                  </div>
                </div>
              )}

              {/* Step breakdown — always visible so the user knows what will run */}
              {stepModes.length > 0 && (
                <div style={{
                  background: "var(--crust)", borderRadius: 8, padding: "8px 10px",
                  marginBottom: 10, display: "flex", flexDirection: "column", gap: 4,
                }}>
                  <div style={{ display: "flex", alignItems: "center", marginBottom: 2, gap: 6 }}>
                    <span style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>Steps</span>
                    <span
                      title={sprintIntent === "execution"
                        ? "Execution sprint — backlog item selected. Steps come from the project's execution pipeline (or default)."
                        : "Discovery sprint — no backlog item selected. Steps come from the project's discovery pipeline (or default). Agents decide what to do."}
                      style={{
                        fontSize: 9, padding: "1px 6px", borderRadius: 4, fontWeight: 700,
                        background: sprintIntent === "execution" ? "rgba(28,191,107,0.15)" : "rgba(203,166,247,0.15)",
                        color:      sprintIntent === "execution" ? "var(--green, #40a02b)" : "var(--mauve, #cba6f7)",
                        textTransform: "uppercase", letterSpacing: "0.04em",
                      }}
                    >
                      {sprintIntent}
                    </span>
                    <a href="/projects" style={{ fontSize: 10, color: "var(--blue)", textDecoration: "none" }}>Configure routing →</a>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700, width: 72, textAlign: "center" }}>Instruction</span>
                  </div>
                  {stepModes.map((s) => {
                    const instr = stepInstructions.get(s.step);
                    const hasInstr = Boolean(instr?.text);
                    const routing = stepRouting.get(s.step) ?? { mode: s.usesCli ? "cli-subs" as StepRoutingMode : "api" as StepRoutingMode, cli: s.cli ?? undefined };
                    const ROUTING_OPTIONS: { id: StepRoutingMode; label: string; bg: string; fg: string }[] = [
                      { id: "api",      label: "API",      bg: "rgba(20,99,255,0.10)",   fg: "#1463ff" },
                      { id: "cli-api",  label: "CLI API",  bg: "rgba(166,227,161,0.12)", fg: "var(--green)" },
                      { id: "cli-subs", label: "CLI SUBS", bg: "rgba(249,226,175,0.12)", fg: "var(--yellow)" },
                    ];
                    const activeOpt = ROUTING_OPTIONS.find((o) => o.id === routing.mode) ?? ROUTING_OPTIONS[0];
                    const tuneApplicable = routing.mode !== "api" && (routing.cli ?? "claude-code") === "claude-code";
                    const hasTuning = Boolean(routing.model || routing.effort || routing.planMode || routing.budgetUsd !== undefined);
                    const isTuneOpen = tunedStep === s.step;
                    return (
                      <React.Fragment key={s.step}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                        <span style={{ color: "var(--overlay0)", width: 18, flexShrink: 0, textAlign: "right" }}>{s.step}</span>
                        <span style={{ flex: 1, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.agent}</span>
                        {/* Routing mode selector */}
                        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                          {ROUTING_OPTIONS.map((opt) => {
                            const isActive = routing.mode === opt.id;
                            return (
                              <button
                                key={opt.id}
                                onClick={() => {
                                  setStepRouting((prev) => {
                                    const m = new Map(prev);
                                    const cur = m.get(s.step) ?? { mode: "api" as StepRoutingMode };
                                    m.set(s.step, { ...cur, mode: opt.id, cli: opt.id !== "api" ? (cur.cli ?? s.cli ?? "claude-code") : undefined });
                                    return m;
                                  });
                                }}
                                style={{
                                  padding: "1px 5px", borderRadius: 4, fontSize: 9, fontWeight: isActive ? 700 : 500,
                                  background: isActive ? opt.bg : "transparent",
                                  color: isActive ? opt.fg : "var(--overlay0)",
                                  border: isActive ? `1px solid ${opt.fg}33` : "1px solid transparent",
                                  cursor: "pointer", fontFamily: "var(--font-sans)",
                                  lineHeight: "16px", whiteSpace: "nowrap",
                                }}
                                title={
                                  opt.id === "api" ? "Uses provider API directly (no CLI)"
                                  : opt.id === "cli-api" ? "Uses CLI headless with API key"
                                  : "Uses CLI with subscription/OAuth"
                                }
                              >{opt.label}</button>
                            );
                          })}
                        </div>
                        {/* CLI selector — shown when cli-api or cli-subs */}
                        {routing.mode !== "api" && (
                          <select
                            value={routing.cli ?? "claude-code"}
                            onChange={(e) => {
                              setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                m.set(s.step, { ...cur, cli: e.target.value });
                                return m;
                              });
                            }}
                            style={{
                              padding: "1px 4px", borderRadius: 4, fontSize: 9, fontWeight: 600,
                              background: "var(--surface0)", border: "1px solid var(--surface1)",
                              color: "var(--text)", cursor: "pointer", fontFamily: "var(--font-sans)",
                              height: 20, flexShrink: 0,
                            }}
                          >
                            {CLI_OPTIONS.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}{opt.status === "experimental" ? " (experimental)" : ""}
                              </option>
                            ))}
                          </select>
                        )}
                        {/* Per-step tune toggle — only meaningful when running claude-code via CLI. */}
                        {tuneApplicable && (
                          <button
                            onClick={() => setTunedStep(isTuneOpen ? null : s.step)}
                            title={hasTuning ? "Edit Claude Code tuning (effort / plan-mode / budget)" : "Tune Claude Code (effort / plan-mode / budget)"}
                            style={{
                              background: hasTuning ? "rgba(245,194,231,0.10)" : (isTuneOpen ? "var(--surface0)" : "none"),
                              border: hasTuning ? "1px solid rgba(245,194,231,0.30)" : "1px solid transparent",
                              cursor: "pointer", padding: "2px 4px",
                              borderRadius: 4, display: "flex", alignItems: "center",
                              color: hasTuning ? "var(--pink)" : "var(--overlay0)",
                              flexShrink: 0,
                            }}
                          >
                            <SlidersHorizontal size={10} />
                          </button>
                        )}
                        <div style={{ width: 72, flexShrink: 0, display: "flex", justifyContent: "center" }}>
                          <button
                            onClick={() => {
                              setDraftText(instr?.text ?? "");
                              setDraftOverride(instr?.override ?? false);
                              setEditingStep(s.step);
                            }}
                            title={hasInstr ? `Edit instruction (${instr!.override ? "override" : "append"})` : "Add sprint instruction"}
                            style={{
                              background: hasInstr ? "rgba(20,99,255,0.08)" : "none",
                              border: hasInstr ? "1px solid rgba(20,99,255,0.25)" : "1px solid transparent",
                              cursor: "pointer", padding: "2px 6px",
                              borderRadius: 4, display: "flex", alignItems: "center", gap: 4,
                              color: hasInstr ? "var(--blue)" : "var(--overlay0)",
                            }}
                          >
                            <Pencil size={10} />
                            {hasInstr && <span style={{ fontSize: 9, fontWeight: 700 }}>{instr!.override ? "OVR" : "ADD"}</span>}
                          </button>
                        </div>
                      </div>
                      {/* Expanded tuning row — claude-code knobs (effort, plan-mode, budget). */}
                      {isTuneOpen && tuneApplicable && (
                        <div style={{
                          display: "flex", alignItems: "center", gap: 10, fontSize: 10,
                          padding: "6px 8px 6px 26px", marginBottom: 2,
                          background: "var(--mantle)", borderRadius: 4,
                          border: "1px solid var(--surface0)",
                        }}>
                          {/* Effort */}
                          {/* Model — overrides the project cascade (planning/dev/governance
                             category model → project default → factory default) for this
                             step only. Empty = inherit. */}
                          <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--overlay1)" }}>
                            <span style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>Model</span>
                            <select
                              value={routing.model ?? ""}
                              onChange={(e) => setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                if (e.target.value === "") { const { model: _drop, ...rest } = cur; m.set(s.step, rest); }
                                else                       { m.set(s.step, { ...cur, model: e.target.value }); }
                                return m;
                              })}
                              style={{
                                padding: "1px 4px", borderRadius: 3, fontSize: 10, fontWeight: 600,
                                background: "var(--surface0)", border: "1px solid var(--surface1)",
                                color: "var(--text)", cursor: "pointer", fontFamily: "var(--font-sans)",
                                height: 18,
                              }}
                              title="Per-step model override. Empty = inherit project cascade (planning/dev/governance category model → project default)."
                            >
                              <option value="">inherit</option>
                              {MODEL_OPTIONS.map((m) => (
                                <option key={m.value} value={m.value} title={m.hint}>{m.label}</option>
                              ))}
                            </select>
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--overlay1)" }}>
                            <span style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>Effort</span>
                            <select
                              value={routing.effort ?? ""}
                              onChange={(e) => setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                const v = e.target.value as "" | "low" | "medium" | "high" | "max";
                                if (v === "") { const { effort: _drop, ...rest } = cur; m.set(s.step, rest); }
                                else          { m.set(s.step, { ...cur, effort: v }); }
                                return m;
                              })}
                              style={{
                                padding: "1px 4px", borderRadius: 3, fontSize: 10, fontWeight: 600,
                                background: "var(--surface0)", border: "1px solid var(--surface1)",
                                color: "var(--text)", cursor: "pointer", fontFamily: "var(--font-sans)",
                                height: 18,
                              }}
                            >
                              <option value="">default</option>
                              <option value="low">low</option>
                              <option value="medium">medium</option>
                              <option value="high">high</option>
                              <option value="max">max</option>
                            </select>
                          </label>
                          {/* Plan mode */}
                          <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--overlay1)", cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={routing.planMode ?? false}
                              onChange={(e) => setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                if (e.target.checked) m.set(s.step, { ...cur, planMode: true });
                                else { const { planMode: _drop, ...rest } = cur; m.set(s.step, rest); }
                                return m;
                              })}
                              style={{ margin: 0 }}
                            />
                            <span style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>Plan mode</span>
                            <span style={{ color: "var(--overlay0)", fontSize: 9 }}>(no writes)</span>
                          </label>
                          {/* Budget */}
                          <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--overlay1)" }}>
                            <span style={{ textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700 }}>Budget $</span>
                            <input
                              type="number"
                              min={0}
                              step={0.5}
                              placeholder="—"
                              value={routing.budgetUsd ?? ""}
                              onChange={(e) => setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                if (e.target.value === "") { const { budgetUsd: _drop, ...rest } = cur; m.set(s.step, rest); }
                                else                       { m.set(s.step, { ...cur, budgetUsd: parseFloat(e.target.value) }); }
                                return m;
                              })}
                              style={{
                                padding: "1px 4px", borderRadius: 3, fontSize: 10, fontWeight: 600,
                                background: "var(--surface0)", border: "1px solid var(--surface1)",
                                color: "var(--text)", fontFamily: "var(--font-sans)",
                                height: 18, width: 56,
                              }}
                            />
                          </label>
                          <span style={{ flex: 1 }} />
                          {hasTuning && (
                            <button
                              onClick={() => setStepRouting((prev) => {
                                const m = new Map(prev);
                                const cur = m.get(s.step) ?? { mode: routing.mode };
                                const { model: _m, effort: _e, planMode: _p, budgetUsd: _b, ...rest } = cur;
                                m.set(s.step, rest);
                                return m;
                              })}
                              style={{
                                fontSize: 9, fontWeight: 600, color: "var(--overlay0)",
                                background: "none", border: "none", cursor: "pointer", padding: 0,
                              }}
                              title="Clear all tuning for this step"
                            >reset</button>
                          )}
                        </div>
                      )}
                      </React.Fragment>
                    );
                  })}
                </div>
              )}

              {/* Per-step agent instruction editor modal */}
              {editingStep !== null && (() => {
                const stepInfo = stepModes.find((s) => s.step === editingStep);
                return (
                  <div style={{
                    position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
                    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300,
                  }}>
                    <div style={{
                      background: "var(--mantle)", border: "1px solid var(--surface1)",
                      borderRadius: 14, width: "min(420px, 92vw)", padding: 20,
                      boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>Sprint Instruction</div>
                          <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
                            Step {editingStep} · <span style={{ color: "var(--text)" }}>{stepInfo?.agent}</span>
                          </div>
                        </div>
                        <button onClick={() => setEditingStep(null)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)" }}>
                          <X size={15} />
                        </button>
                      </div>

                      <textarea
                        autoFocus
                        value={draftText}
                        onChange={(e) => setDraftText(e.target.value)}
                        placeholder="Enter specific instructions for this agent in this sprint…"
                        rows={5}
                        style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5, marginBottom: 12 }}
                      />

                      <label style={{
                        display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer",
                        padding: "8px 10px", borderRadius: 8, marginBottom: 14,
                        border: `1px solid ${draftOverride ? "rgba(249,226,175,0.4)" : "var(--surface1)"}`,
                        background: draftOverride ? "rgba(249,226,175,0.06)" : "transparent",
                      }}>
                        <input
                          type="checkbox"
                          checked={draftOverride}
                          onChange={(e) => setDraftOverride(e.target.checked)}
                          style={{ marginTop: 2, accentColor: "#f9e2af" }}
                        />
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: draftOverride ? "var(--yellow)" : "var(--text)" }}>Override</div>
                          <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>
                            {draftOverride
                              ? "This instruction replaces the agent's original instructions."
                              : "This instruction is appended to the agent's original instructions."}
                          </div>
                        </div>
                      </label>

                      <div style={{ display: "flex", gap: 8 }}>
                        {stepInstructions.has(editingStep) && (
                          <button
                            onClick={() => {
                              setStepInstructions((prev) => { const m = new Map(prev); m.delete(editingStep); return m; });
                              setEditingStep(null);
                            }}
                            style={{
                              padding: "8px 14px", borderRadius: 8, border: "1px solid var(--surface1)",
                              background: "transparent", color: "var(--red)", fontSize: 12,
                              cursor: "pointer", fontFamily: "var(--font-sans)",
                            }}
                          >Remove</button>
                        )}
                        <button
                          onClick={() => setEditingStep(null)}
                          style={{
                            padding: "8px 14px", borderRadius: 8, border: "1px solid var(--surface1)",
                            background: "transparent", color: "var(--subtext0)", fontSize: 12,
                            cursor: "pointer", fontFamily: "var(--font-sans)", marginLeft: "auto",
                          }}
                        >Cancel</button>
                        <button
                          onClick={() => {
                            if (draftText.trim()) {
                              setStepInstructions((prev) => new Map(prev).set(editingStep, { text: draftText.trim(), override: draftOverride }));
                            } else {
                              setStepInstructions((prev) => { const m = new Map(prev); m.delete(editingStep); return m; });
                            }
                            setEditingStep(null);
                          }}
                          style={{
                            padding: "8px 16px", borderRadius: 8, border: "none",
                            background: "#1463ff", color: "#fff", fontSize: 12, fontWeight: 700,
                            cursor: "pointer", fontFamily: "var(--font-sans)",
                          }}
                        >Save</button>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* API steps config — only shown when there are API steps */}
              {apiSteps.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 6 }}>
                    LLM for <strong style={{ color: "var(--text)" }}>{apiSteps.length} API step{apiSteps.length !== 1 ? "s" : ""}</strong>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                    {(["project", "global"] as const).map((src) => {
                      const active = llmSource === src;
                      const label = src === "project"
                        ? `Project${hasProjectLLM ? ` (${projProvider}${projModel ? ` / ${projModel.split("-").slice(0,2).join("-")}` : ""})` : " — not set"}`
                        : "Global";
                      const disabled = src === "project" && !hasProjectLLM;
                      return (
                        <button
                          key={src}
                          disabled={disabled}
                          onClick={() => !disabled && setLlmSource(src)}
                          style={{
                            display: "flex", alignItems: "center", gap: 7,
                            padding: "5px 11px", borderRadius: 8, cursor: disabled ? "default" : "pointer",
                            border: `1.5px solid ${active ? "rgba(20,99,255,0.5)" : "var(--surface1)"}`,
                            background: active ? "rgba(20,99,255,0.08)" : "var(--surface0)",
                            color: disabled ? "var(--overlay0)" : active ? "#1463ff" : "var(--subtext0)",
                            fontSize: 12, fontWeight: active ? 700 : 400, fontFamily: "var(--font-sans)",
                            opacity: disabled ? 0.5 : 1,
                          }}
                        >
                          <span style={{ fontSize: 14, lineHeight: 1 }}>{active ? "●" : "○"}</span>
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  {llmSource === "global" && (
                    loadingProviders ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--overlay0)", padding: "4px 0" }}>
                        <RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> Loading…
                      </div>
                    ) : liveProviders.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--yellow)", padding: "4px 0" }}>
                        No providers configured. <a href="/providers" style={{ color: "var(--blue)" }}>Add an API key.</a>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8 }}>
                        <select value={provider} onChange={(e) => { setProvider(e.target.value); setModel(liveProviders.find((p) => p.id === e.target.value)?.models[0]?.id ?? ""); }}
                          style={{ ...inputStyle, padding: "6px 10px", height: 34, width: 140 }}>
                          {liveProviders.map((p) => <option key={p.id} value={p.id}>{PROVIDER_NAMES[p.id] ?? p.id}</option>)}
                        </select>
                        <select value={model} onChange={(e) => setModel(e.target.value)}
                          style={{ ...inputStyle, padding: "6px 10px", height: 34, flex: 1 }}>
                          {(liveProviders.find((p) => p.id === provider)?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                        </select>
                      </div>
                    )
                  )}
                </div>
              )}

            </div>

            {/* Bypass gates */}
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: "10px 12px", borderRadius: 10, border: `1px solid ${bypassGates ? "var(--yellow)" : "var(--surface1)"}`, background: bypassGates ? "rgba(249,226,175,0.06)" : "transparent", marginBottom: 8 }}>
              <input type="checkbox" checked={bypassGates} onChange={(e) => setBypassGates(e.target.checked)} style={{ marginTop: 2, accentColor: "#f9e2af" }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: bypassGates ? "var(--yellow)" : "var(--text)" }}>Bypass human gates</div>
                <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 2 }}>Auto-approve all gate pauses — pipeline runs fully unattended.</div>
              </div>
            </label>

            {/* ── Collapsible: Context & Resume ── */}
            <div style={{ borderRadius: 10, border: "1px solid var(--surface1)", marginBottom: 14, overflow: "hidden" }}>
              <button
                onClick={() => setContextOpen((o) => !o)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "9px 12px", background: "transparent", border: "none", cursor: "pointer",
                  color: (contextSprintIds.length > 0 || (hasActiveSprint && resumeStep !== "auto")) ? "var(--blue)" : "var(--subtext0)",
                  fontFamily: "var(--font-sans)",
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                  {contextOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Context &amp; Resume
                  {contextSprintIds.length > 0 && (
                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "rgba(20,99,255,0.12)", color: "#1463ff", fontWeight: 700 }}>
                      {contextSprintIds.length} sprint{contextSprintIds.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {hasActiveSprint && resumeStep !== "auto" && (
                    <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: "rgba(20,99,255,0.12)", color: "#1463ff", fontWeight: 700 }}>
                      from step {resumeStep}
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 10, color: "var(--overlay0)" }}>optional</span>
              </button>

              {contextOpen && (
                <div style={{ padding: "0 12px 12px 12px", borderTop: "1px solid var(--surface1)" }}>
                  {/* Resume step selector — only for active/paused sprints */}
                  {hasActiveSprint && availableSteps.length > 0 && (
                    <div style={{ marginTop: 10, marginBottom: 12 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                        Resume from step
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        <button
                          onClick={() => setResumeStep("auto")}
                          style={{
                            padding: "3px 9px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                            fontFamily: "var(--font-sans)", fontWeight: resumeStep === "auto" ? 700 : 400,
                            border: `1px solid ${resumeStep === "auto" ? "rgba(20,99,255,0.5)" : "var(--surface1)"}`,
                            background: resumeStep === "auto" ? "rgba(20,99,255,0.08)" : "transparent",
                            color: resumeStep === "auto" ? "#1463ff" : "var(--subtext0)",
                          }}
                        >
                          Auto (step {autoResumeStep})
                        </button>
                        {availableSteps.map((s) => (
                          <button
                            key={s.step}
                            onClick={() => setResumeStep(s.step)}
                            style={{
                              padding: "3px 9px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                              fontFamily: "var(--font-sans)", fontWeight: resumeStep === s.step ? 700 : 400,
                              border: `1px solid ${resumeStep === s.step ? "rgba(20,99,255,0.5)" : "var(--surface1)"}`,
                              background: resumeStep === s.step ? "rgba(20,99,255,0.08)" : "transparent",
                              color: resumeStep === s.step ? "#1463ff" : "var(--subtext0)",
                              maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}
                            title={`Step ${s.step}: ${s.agent}`}
                          >
                            {s.step}. {s.agent}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Cross-sprint context */}
                  <div style={{ marginTop: hasActiveSprint ? 0 : 10 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                      Context from previous sprints
                    </div>

                    {loadingSprints ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--overlay0)", padding: "4px 0" }}>
                        <RefreshCw size={11} style={{ animation: "spin 1s linear infinite" }} /> Loading…
                      </div>
                    ) : pastSprints.length === 0 ? (
                      <div style={{ fontSize: 11, color: "var(--overlay0)", padding: "4px 0" }}>No completed sprints to reference.</div>
                    ) : (
                      <>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                          {pastSprints.map((s) => {
                            const checked = contextSprintIds.includes(s.id);
                            return (
                              <label key={s.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    setContextSprintIds((prev) =>
                                      e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)
                                    );
                                  }}
                                  style={{ marginTop: 2, accentColor: "#1463ff" }}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <span style={{ fontSize: 12, fontWeight: 600, color: checked ? "var(--text)" : "var(--subtext0)" }}>
                                    Sprint {s.sprint_num}
                                  </span>
                                  {s.briefing && (
                                    <span style={{ fontSize: 11, color: "var(--overlay0)", marginLeft: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      — {s.briefing.slice(0, 50)}{s.briefing.length > 50 ? "…" : ""}
                                    </span>
                                  )}
                                </div>
                              </label>
                            );
                          })}
                        </div>

                        {contextSprintIds.length > 0 && (
                          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                            <span style={{ fontSize: 11, color: "var(--overlay0)", marginRight: 4 }}>Include:</span>
                            {(["specs", "docs"] as const).map((cat) => {
                              const active = contextCategories.includes(cat);
                              return (
                                <button
                                  key={cat}
                                  onClick={() => setContextCategories((prev) =>
                                    active
                                      ? prev.filter((c) => c !== cat)
                                      : [...prev, cat]
                                  )}
                                  style={{
                                    padding: "2px 8px", borderRadius: 5, fontSize: 11, cursor: "pointer",
                                    fontFamily: "var(--font-sans)", fontWeight: active ? 700 : 400,
                                    border: `1px solid ${active ? "rgba(20,99,255,0.5)" : "var(--surface1)"}`,
                                    background: active ? "rgba(20,99,255,0.08)" : "transparent",
                                    color: active ? "#1463ff" : "var(--subtext0)",
                                    textTransform: "capitalize",
                                  }}
                                >
                                  {cat}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {error && <div style={{ fontSize: 12, color: "var(--red)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><AlertTriangle size={12} />{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={onClose} style={{ padding: "9px 16px", borderRadius: 9, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext0)", fontSize: 13, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Cancel</button>
              <button
                onClick={handleStart}
                disabled={running || stepModes.length === 0}
                title={stepModes.length === 0 ? "Project has no pipeline assigned — configure one in Project Settings → Pipeline." : undefined}
                style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                  padding: "9px", borderRadius: 9, border: "none",
                  background: stepModes.length === 0 ? "var(--surface1)" : "#1463ff",
                  color: stepModes.length === 0 ? "var(--overlay0)" : "#fff",
                  fontSize: 13, fontWeight: 700,
                  cursor: (running || stepModes.length === 0) ? "not-allowed" : "pointer",
                  opacity: running ? 0.7 : 1, fontFamily: "var(--font-sans)",
                }}
              >
                {running ? <><RefreshCw size={13} style={{ animation: "spin 1s linear infinite" }} /> Starting…</> : <><Play size={12} /> Start Sprint {sprintNum}</>}
              </button>
              <button onClick={handleReview} disabled={running} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 14px", borderRadius: 9, border: "1px solid var(--surface1)", background: "transparent", color: "var(--subtext1)", fontSize: 13, fontWeight: 600, cursor: running ? "not-allowed" : "pointer", opacity: running ? 0.5 : 1, fontFamily: "var(--font-sans)" }}>
                Review <ChevronRight size={13} />
              </button>
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
}

/* ─── Add to Queue Modal ─────────────────────────────── */
function AddToQueueModal({
  projects, actionStates, onAdd, onClose,
}: {
  projects: Project[];
  actionStates: Record<string, ActionState>;
  onAdd: (p: Project) => void;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 18, width: "min(480px, 95vw)", maxHeight: "70vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Add project to pipeline</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)" }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {projects.length === 0 ? (
            <div style={{ textAlign: "center", padding: "24px 0", color: "var(--overlay0)", fontSize: 13 }}>
              All projects are already in the pipeline.
            </div>
          ) : (
            projects.map((project) => {
              const st = actionStates[project.id];
              return (
                <button
                  key={project.id}
                  disabled={st?.loading}
                  onClick={() => onAdd(project)}
                  style={{
                    display: "flex", alignItems: "center", gap: 12, width: "100%",
                    padding: "12px 14px", borderRadius: 10, marginBottom: 8,
                    background: "var(--surface0)", border: "1px solid var(--surface1)",
                    cursor: st?.loading ? "not-allowed" : "pointer", textAlign: "left",
                    opacity: st?.loading ? 0.6 : 1, transition: "border-color 0.12s",
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  {st?.loading
                    ? <Loader2 size={16} color="var(--blue)" style={{ animation: "spin 1s linear infinite" }} />
                    : <Plus size={16} color="var(--blue)" />
                  }
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{project.name}</div>
                    <code style={{ fontSize: 10, color: "var(--overlay0)" }}>{project.slug}</code>
                  </div>
                  {(() => {
                    // Surface only the statuses that change the operator's
                    // decision to enqueue. idle/queued/locked are the
                    // useful ones; running gets its own affordance row.
                    const s = project.status as string;
                    const labelStatuses = new Set(["idle", "queued", "locked"]);
                    if (!labelStatuses.has(s)) return null;
                    const label = project.archived_at && s === "locked" ? "archived" : s;
                    return (
                      <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: "var(--surface1)", color: "var(--overlay0)", textTransform: "uppercase", fontWeight: 600 }}>
                        {label}
                      </span>
                    );
                  })()}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

