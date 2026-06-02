"use client";

/** Collapsible list of past sprints for one project. The active sprint
 *  is filtered out — the host renders it separately. Shared by
 *  RunningProjectCard and PendingSaveCard. */
import React, { useEffect, useState } from "react";
import { GitBranch, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import type { AgentRun } from "@/lib/types";
import { SprintRow, type Sprint as SharedSprint } from "@/components/ProjectCard";

interface SprintSummary {
  id: string;
  sprint_num: number;
  status: string;
  intent?: string | null;
  created_at: string;
  completed_at: string | null;
  briefing: string | null;
  sprint_completed_saved?: boolean | null;
  config?: { mode?: string; [key: string]: unknown } | null;
}

interface SprintInfoMin {
  sprint_num: number;
}

export default function SprintHistoryPanel({
  projectId, session, runsMap, currentSprintInfo, sprintCount,
}: {
  projectId: string;
  session: Session;
  runsMap: Map<string, AgentRun[]>;
  currentSprintInfo?: SprintInfoMin;
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

  // runsMap is taken as a prop for parity with the original signature even
  // though this panel doesn't read it directly today — future evolutions
  // may surface per-sprint cost/turn rollups here without changing the
  // host wiring.
  void runsMap;

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
                intent: s.intent ?? null,
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
