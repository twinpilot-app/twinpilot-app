"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";
import { supabase } from "@/lib/supabase";
import type { Project, AgentRun, SprintIntent } from "@/lib/types";
import InfraMonitor from "@/components/InfraMonitor";
import AgentCatalog from "@/components/AgentCatalog";
import AppSidebar from "@/components/AppSidebar";
import QueueView from "@/components/QueueView";
import { LayoutDashboard, Server, Users } from "lucide-react";

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
        // Hide PIP-inception temp projects (Studio > PIP Manager > Browse manages those).
        .or("settings->>kind.is.null,settings->>kind.neq.pip-inception")
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
        // PIP-inception temp projects don't belong in the Office —
        // they're surfaced under Studio > PIP Manager > Browse instead.
        // The realtime channel doesn't support JSONB-key filters, so
        // filter client-side on each event.
        const isPipInception = (p: Project | undefined): boolean => {
          const settings = (p?.settings ?? {}) as { kind?: string };
          return settings.kind === "pip-inception";
        };
        if (payload.eventType === "INSERT") {
          const p = payload.new as Project;
          if (isPipInception(p)) return;
          projectIdsRef.current.add(p.id);
          setProjects((prev) => [p, ...prev]);
        } else if (payload.eventType === "UPDATE") {
          const p = payload.new as Project;
          if (isPipInception(p)) {
            // It might have been visible before settings.kind was set —
            // drop it now.
            setProjects((prev) => prev.filter((x) => x.id !== p.id));
            projectIdsRef.current.delete(p.id);
            return;
          }
          setProjects((prev) =>
            prev.map((x) => x.id === p.id ? p : x)
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

// CompletedProjectCard removed — projects no longer have a "completed"
// status (migration 118). Only sprints complete; projects sit at `ready`
// when idle and `cancelled` when archived. Operators archive projects via
// the Archive button on idle/paused cards (now in QueueRow).


/** Running/paused project card: QueueRow header + collapsible ProjectCanvas */


/* ─── PendingSaveCard ───────────────────────────────── */



/* ─── SprintHistoryPanel (uses shared SprintRow from ProjectCard) ─── */


/* SprintHistoryRow removed — now uses shared SprintRow from @/components/ProjectCard */

/* ─── Queue primitives ──────────────────────────────── */



/* ─── Sprint-related types (used across Office cards + history panel) ─── */
interface SprintSummary { id: string; sprint_num: number; status: string; intent?: string | null; created_at: string; completed_at: string | null; briefing: string | null; sprint_completed_saved?: boolean | null; config?: { mode?: string; [key: string]: unknown } | null }
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


