"use client";

/** Office card surfaced after a sprint finishes but still needs operator
 *  decision (save / discard / export the artefacts). Wraps
 *  ProjectCanvas for the agent pipeline view and SprintHistoryPanel for
 *  past sprints. */
import React, { useEffect, useState, useRef } from "react";
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  ExternalLink, GitBranch, RefreshCw, Trash2,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import type { Project, AgentRun, DBProject, SprintIntent } from "@/lib/types";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import ProjectCanvas from "@/components/ProjectCanvas";
import SprintHistoryPanel from "@/components/SprintHistoryPanel";

/** Minimal sprint info shape the card consumes from the host's realtime map. */
interface SprintInfo {
  sprint_num: number;
  status: string;
  created_at: string;
  trigger_run_id: string | null;
  briefing: string | null;
  intent: SprintIntent | null;
  steps: { step: number; agent: string; gate: string | null }[] | null;
}

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

export default PendingSaveCard;
