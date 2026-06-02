"use client";

/** The Office tab body. Hosts the regular / autonomous partition tabs,
 *  three QueueSection groups (running / paused / queued), Start Sprint +
 *  Review modals, and the AddToQueueModal + QueueSection helpers. */
import React, { useEffect, useState, useRef } from "react";
import dynamic from "next/dynamic";
import { Bot, Clock, Download, FolderOpen, LayoutDashboard, Loader2, Plus, X, Zap } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import type {
  Project, AgentRun, DBProject, SprintRunOverrides, SprintIntent,
} from "@/lib/types";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import ReviewSprintModal from "@/components/ReviewSprintModal";
import RunningProjectCard from "@/components/RunningProjectCard";
import PendingSaveCard from "@/components/PendingSaveCard";
import QueueRow from "@/components/QueueRow";

/** Lazy-loaded; kept off the initial `/` bundle. */
const StartSprintModal = dynamic(
  () => import("@/components/StartSprintModal"),
  { ssr: false },
);

/**
 * Office "in flight" union — duplicates the constants in app/page.tsx
 * by design. Project-side statuses union with sprint-side statuses
 * because pending_save / paused / waiting live on the sprint row, not
 * the project (migration 160).
 */
const QUEUE_PROJECT_STATUSES = new Set(["queued", "running"]);
const QUEUE_SPRINT_STATUSES  = new Set(["paused", "waiting", "pending_save"]);

type ActionState = { loading: boolean; msg?: { type: "error" | "cli"; text: string } };

interface SprintInfo {
  sprint_num: number;
  status: string;
  created_at: string;
  trigger_run_id: string | null;
  briefing: string | null;
  intent: SprintIntent | null;
  steps: { step: number; agent: string; gate: string | null }[] | null;
}

interface LatestSprintFlags {
  sprint_num: number;
  needs_human: boolean;
  verdict: "success" | "no-output" | "partial" | "failed" | null;
  reason: string | null;
  needs_human_reason: string | null;
  suggested_action: string | null;
  pending_push: { branch: string | null; tag?: string } | null;
  auto_composed: { source_sprint_id: string } | null;
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

export default QueueView;
