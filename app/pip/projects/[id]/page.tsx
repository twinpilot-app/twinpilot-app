"use client";

/**
 * /pip/projects/[id] — PIP Inception Run dashboard.
 *
 * Dedicated view for a single inception sprint. Renders the
 * pip-reverse-engineering pipeline as a horizontal canvas of phases
 * with one card per agent step, each surfacing its agent_run status,
 * timing, and errors. Top header carries the action buttons (Apply /
 * Download pip.json / Discard) — operators do everything from here
 * without bouncing back to PIP Manager > Browse.
 *
 * Auto-refreshes every 5s while the sprint is still queued/running/
 * waiting; settles when the sprint terminates.
 *
 * Linked from PIP Manager > Browse > Open. Generic /projects/[id]
 * remains the dashboard for "real" projects; inception scratchpads
 * route here instead.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle, ArrowRight, CheckCircle2, ChevronLeft, Clock,
  Download, ExternalLink, Loader2, RefreshCw, Send, Trash2, XCircle,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import PageShell from "@/components/PageShell";

const PIPELINE_PHASES: Array<{
  phase:     number;
  name:      string;
  agents:    string[];
}> = [
  { phase: 1, name: "Inception scan",   agents: ["pip-scout"] },
  { phase: 2, name: "Discovery",        agents: ["pip-product-manager", "pip-architect"] },
  { phase: 3, name: "Components",       agents: ["pip-components-builder"] },
  { phase: 4, name: "Compose & review", agents: ["pip-composer"] },
];

type AgentRunStatus = "pending" | "running" | "done" | "failed" | "waiting" | "cancelled" | null;

interface ProjectRow {
  id:          string;
  slug:        string;
  name:        string;
  status:      string;
  factory_id:  string;
  settings:    Record<string, unknown> | null;
  created_at:  string;
  last_error:  string | null;
}

interface SprintRow {
  id:           string;
  sprint_num:   number;
  status:       string;
  briefing:     string | null;
  outcome:      Record<string, unknown> | null;
  started_at:   string | null;
  completed_at: string | null;
  steps:        Array<{ step: number; agent: string; gate: string | null; phase?: number; phaseName?: string }> | null;
}

interface AgentRunRow {
  id:          string;
  agent:       string;
  status:      AgentRunStatus;
  started_at:  string | null;
  finished_at: string | null;
  error:       string | null;
  step:        number | null;
  phase:       number | null;
  llm_model:   string | null;
  tokens_in:   number | null;
  tokens_out:  number | null;
  cost_usd:    number | null;
  output_ref:  string | null;
}

interface Snapshot {
  project: ProjectRow;
  sprint:  SprintRow | null;
  runs:    AgentRunRow[];
}

function statusColors(status: AgentRunStatus | string | null): { bg: string; fg: string; border: string } {
  const colors: Record<string, { bg: string; fg: string; border: string }> = {
    running:   { bg: "rgba(20,99,255,0.10)",   fg: "var(--blue)",  border: "rgba(20,99,255,0.35)"  },
    queued:    { bg: "rgba(245,194,107,0.10)", fg: "var(--peach)", border: "rgba(245,194,107,0.30)" },
    pending:   { bg: "var(--surface0)",        fg: "var(--overlay0)", border: "var(--surface1)"     },
    done:      { bg: "rgba(126,190,114,0.10)", fg: "var(--green)", border: "rgba(126,190,114,0.30)" },
    completed: { bg: "rgba(126,190,114,0.10)", fg: "var(--green)", border: "rgba(126,190,114,0.30)" },
    failed:    { bg: "rgba(228,75,95,0.10)",   fg: "var(--red)",   border: "rgba(228,75,95,0.35)"   },
    waiting:   { bg: "rgba(245,194,107,0.10)", fg: "var(--peach)", border: "rgba(245,194,107,0.45)" },
    cancelled: { bg: "var(--surface0)",        fg: "var(--overlay0)", border: "var(--surface1)"     },
  };
  return colors[status ?? "pending"] ?? { bg: "var(--surface0)", fg: "var(--subtext0)", border: "var(--surface1)" };
}

function StatusIcon({ status }: { status: AgentRunStatus | string | null }) {
  if (status === "running")  return <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />;
  if (status === "done"   || status === "completed") return <CheckCircle2 size={12} />;
  if (status === "failed")   return <XCircle size={12} />;
  if (status === "waiting")  return <Clock size={12} />;
  if (status === "cancelled") return <XCircle size={12} />;
  return <Clock size={12} />;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (isNaN(t)) return "—";
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60)   return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)   return `${min}m ago`;
  const hr  = Math.floor(min / 60);
  if (hr < 24)    return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default function PipInceptionRunPage() {
  const params  = useParams<{ id: string }>();
  const router  = useRouter();
  const id      = params.id;

  const [snap, setSnap]       = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState<string | null>(null);
  const [busy, setBusy]       = useState<"apply" | "discard" | null>(null);
  const [tick, setTick]       = useState(0);
  // Right-side drawer — opens on agent card click, mirrors the
  // ProjectCanvas Office surface UX. Stores the agent slug; the run
  // record is looked up from runsBySlug at render time.
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    const { data: project, error: projErr } = await supabase
      .from("projects")
      .select("id, slug, name, status, factory_id, settings, created_at, last_error")
      .eq("id", id)
      .maybeSingle();
    if (projErr) { setErr(projErr.message); setLoading(false); return; }
    if (!project) { setErr("Project not found"); setLoading(false); return; }
    const settings = (project.settings ?? {}) as Record<string, unknown>;
    if (settings.kind !== "pip-inception") {
      // Not a PIP inception — bounce to the regular project dashboard.
      router.replace(`/projects/${id}`);
      return;
    }

    const { data: sprint } = await supabase
      .from("sprints")
      .select("id, sprint_num, status, briefing, outcome, started_at, completed_at, steps")
      .eq("project_id", id)
      .order("sprint_num", { ascending: false })
      .limit(1)
      .maybeSingle();

    let runs: AgentRunRow[] = [];
    if (sprint?.id) {
      const { data: runRows } = await supabase
        .from("agent_runs")
        .select("id, agent, status, started_at, finished_at, error, step, phase, llm_model, tokens_in, tokens_out, cost_usd, output_ref")
        .eq("sprint_id", sprint.id)
        .order("step", { ascending: true });
      runs = (runRows ?? []) as AgentRunRow[];
    }

    setSnap({
      project: project as ProjectRow,
      sprint:  (sprint as SprintRow | null) ?? null,
      runs,
    });
    setLoading(false);
  }, [id, router]);

  useEffect(() => { void load(); }, [load, tick]);

  // Auto-refresh while the sprint isn't terminal.
  useEffect(() => {
    if (!snap) return;
    const sprintStatus = snap.sprint?.status;
    if (sprintStatus && ["queued", "running", "waiting"].includes(sprintStatus)) {
      const t = setInterval(() => setTick((n) => n + 1), 5000);
      return () => clearInterval(t);
    }
    return undefined;
  }, [snap]);

  const hasPipJson = !!(snap?.sprint?.outcome && (snap.sprint.outcome as Record<string, unknown>).pip_json);
  const sprintStatus = snap?.sprint?.status ?? null;
  const isTerminal   = sprintStatus === "completed" || sprintStatus === "failed";
  const isRunning    = sprintStatus === "running" || sprintStatus === "queued";
  const isAtGate     = sprintStatus === "waiting";

  async function applyInception() {
    if (!snap) return;
    if (!hasPipJson) { alert("No pip.json stashed yet."); return; }
    if (!confirm(`Apply inception "${snap.project.name}"? Creates the real project + components and discards the temp inception.`)) return;
    setBusy("apply");
    setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch("/api/factory/pip/inception/apply", {
        method:  "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ inceptionProjectId: snap.project.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { projectId?: string; warnings?: string[]; error?: string };
      if (!res.ok || !body.projectId) throw new Error(body.error ?? `Apply failed (${res.status})`);
      const warn = (body.warnings ?? []).filter(Boolean);
      if (warn.length > 0) alert(`Applied with warnings:\n\n${warn.map((w) => `• ${w}`).join("\n")}`);
      router.push(`/projects/${body.projectId}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function discardInception() {
    if (!snap) return;
    if (isRunning) { alert("Can't discard while the sprint is running."); return; }
    if (!confirm(`Discard inception "${snap.project.name}"? Deletes the temp project + sprints from the DB.`)) return;
    setBusy("discard");
    setErr(null);
    const { error: e } = await supabase.from("projects").delete().eq("id", snap.project.id);
    setBusy(null);
    if (e) { setErr(e.message); return; }
    router.push("/?tab=studio");
  }

  async function downloadPipJson() {
    if (!snap || !hasPipJson) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not signed in");
      const res = await fetch(
        `/api/factory/pip/inception/pip-json?inceptionId=${encodeURIComponent(snap.project.id)}`,
        { headers: { Authorization: `Bearer ${session.access_token}` } },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${snap.project.slug}.pip.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // Index agent_runs by slug — last run wins. The pipeline runs each
  // agent at most once per sprint; if a step is retried, we want the
  // latest. agent_runs.step is set when present so we double-check
  // before relying on the last entry.
  const runsBySlug = new Map<string, AgentRunRow>();
  for (const r of snap?.runs ?? []) {
    runsBySlug.set(r.agent, r);
  }

  const pipMeta = (snap?.project.settings?.pip_inception ?? {}) as Record<string, unknown>;
  const targetRepoUrl  = (pipMeta.target_repo_url as string | undefined) ?? null;
  const inputMode      = (pipMeta.input_mode      as string | undefined) ?? null;
  const refsCount      = Array.isArray(pipMeta.refs) ? (pipMeta.refs as unknown[]).length : 0;

  return (
    <PageShell active="studio" maxWidth={1280}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--overlay0)", marginBottom: 12 }}>
        <Link href="/?tab=studio" style={{ color: "var(--overlay1)", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
          <ChevronLeft size={11} /> Studio
        </Link>
        <span>·</span>
        <span style={{ color: "var(--text)" }}>PIP Inception</span>
      </div>

      {loading || !snap ? (
        <div style={{ color: "var(--overlay0)", fontSize: 12 }}>Loading inception…</div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <h1 style={{ color: "var(--text)", fontSize: 22, fontWeight: 700, margin: 0, marginBottom: 6, fontFamily: "var(--font-heading)" }}>
                {snap.project.name}
              </h1>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--overlay0)" }}>
                {snap.project.slug}
              </code>
              <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", fontSize: 11, color: "var(--subtext0)" }}>
                {sprintStatus && (
                  <span style={{
                    padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                    background: statusColors(sprintStatus).bg, color: statusColors(sprintStatus).fg,
                    fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.05em",
                  }}>
                    {sprintStatus}
                  </span>
                )}
                {inputMode && <span>source: <code style={{ fontFamily: "var(--font-mono)" }}>{inputMode}</code></span>}
                {targetRepoUrl && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <ExternalLink size={11} />
                    <a href={targetRepoUrl} target="_blank" rel="noreferrer" style={{ color: "var(--blue)", textDecoration: "none" }}>
                      {targetRepoUrl.replace(/^https:\/\/(www\.)?github\.com\//, "")}
                    </a>
                  </span>
                )}
                {refsCount > 0 && <span>+ {refsCount} ref{refsCount === 1 ? "" : "s"}</span>}
                <span>started {formatRelative(snap.sprint?.started_at ?? snap.project.created_at)}</span>
                {snap.sprint?.completed_at && <span>finished {formatRelative(snap.sprint.completed_at)}</span>}
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
              <button
                onClick={() => setTick((n) => n + 1)}
                style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "1px solid var(--surface1)", background: "var(--surface0)", color: "var(--subtext0)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
              >
                <RefreshCw size={11} /> Refresh
              </button>
              {hasPipJson && (
                <>
                  <button
                    onClick={() => void applyInception()}
                    disabled={busy !== null}
                    title="Apply the PIP — create the real project + components in this factory, discard this temp inception"
                    style={{
                      padding: "6px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6,
                      border: "none", background: "var(--blue)", color: "#fff",
                      cursor: busy === "apply" ? "wait" : "pointer", opacity: busy === "apply" ? 0.6 : 1,
                      display: "flex", alignItems: "center", gap: 4,
                    }}
                  >
                    {busy === "apply" ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <Send size={11} />}
                    {busy === "apply" ? "Applying…" : "Apply"}
                  </button>
                  <button
                    onClick={() => void downloadPipJson()}
                    title="Open pip.json (operator can review and import via PIP > Import)"
                    style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, border: "1px solid var(--surface1)", background: "var(--surface0)", color: "var(--text)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
                  >
                    <Download size={11} /> pip.json
                  </button>
                </>
              )}
              <button
                onClick={() => void discardInception()}
                disabled={busy !== null || isRunning}
                title={isRunning ? "Sprint is running — wait or cancel first" : "Delete the temp project + sprints"}
                style={{
                  padding: "6px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6,
                  border: "1px solid rgba(228,75,95,0.30)", background: "transparent",
                  color: "var(--red)",
                  cursor: busy === "discard" ? "wait" : (isRunning ? "not-allowed" : "pointer"),
                  opacity: busy === "discard" || isRunning ? 0.6 : 1,
                  display: "flex", alignItems: "center", gap: 4,
                }}
              >
                {busy === "discard" ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={11} />}
                Discard
              </button>
            </div>
          </div>

          {err && (
            <div style={{ padding: "10px 14px", borderRadius: 6, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.35)", color: "var(--red)", fontSize: 12, marginBottom: 16, display: "flex", alignItems: "center", gap: 6 }}>
              <AlertCircle size={12} /> {err}
            </div>
          )}

          {snap.project.last_error && !err && (
            <div style={{ padding: "10px 14px", borderRadius: 6, background: "rgba(245,194,107,0.06)", border: "1px solid rgba(245,194,107,0.35)", color: "var(--peach)", fontSize: 12, marginBottom: 16, display: "flex", alignItems: "flex-start", gap: 6 }}>
              <AlertCircle size={12} style={{ marginTop: 2, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>Last error</div>
                <div style={{ color: "var(--subtext0)", whiteSpace: "pre-wrap" }}>{snap.project.last_error}</div>
              </div>
            </div>
          )}

          {isAtGate && hasPipJson && (
            <div style={{ padding: "10px 14px", borderRadius: 6, background: "rgba(245,194,107,0.08)", border: "1px solid rgba(245,194,107,0.40)", color: "var(--peach)", fontSize: 12, marginBottom: 16 }}>
              <strong>Sprint paused at human gate.</strong> Review pip.json and click <strong>Apply</strong> to materialise the real project, or <strong>Discard</strong> to drop this inception.
            </div>
          )}
          {isTerminal && hasPipJson && sprintStatus === "completed" && (
            <div style={{ padding: "10px 14px", borderRadius: 6, background: "rgba(126,190,114,0.06)", border: "1px solid rgba(126,190,114,0.30)", color: "var(--green)", fontSize: 12, marginBottom: 16 }}>
              <strong>Sprint completed.</strong> pip.json is ready — click <strong>Apply</strong> when you want it materialised.
            </div>
          )}

          {/* Cost rollup — sums per-run metrics from agent_runs. The
              generic Twin Dashboard at /projects/[id] surfaces this in
              the cost panel; we surface it inline here so an inception
              has parity for the metric that matters most (LLM spend on
              the RE pipeline). */}
          {(() => {
            const totals = (snap.runs ?? []).reduce(
              (acc, r) => {
                acc.usd        += r.cost_usd  ?? 0;
                acc.tokens_in  += r.tokens_in  ?? 0;
                acc.tokens_out += r.tokens_out ?? 0;
                if (r.status && ["done", "failed", "cancelled"].includes(r.status)) acc.runs_terminated++;
                if (r.status === "running") acc.runs_active++;
                return acc;
              },
              { usd: 0, tokens_in: 0, tokens_out: 0, runs_active: 0, runs_terminated: 0 },
            );
            if (totals.tokens_in === 0 && totals.tokens_out === 0 && totals.usd === 0) return null;
            return (
              <div style={{
                display: "flex", gap: 14, flexWrap: "wrap",
                padding: "10px 14px", marginBottom: 16,
                borderRadius: 8, background: "var(--surface0)", border: "1px solid var(--surface1)",
              }}>
                <Stat label="LLM cost"   value={`$${totals.usd.toFixed(4)}`} hint={totals.runs_terminated > 0 ? `${totals.runs_terminated} runs terminated${totals.runs_active > 0 ? ` · ${totals.runs_active} active` : ""}` : `${totals.runs_active} active`} />
                <Stat label="Tokens in"  value={totals.tokens_in.toLocaleString()} />
                <Stat label="Tokens out" value={totals.tokens_out.toLocaleString()} />
                {snap.runs.some((r) => r.llm_model) && (
                  <Stat
                    label="Models"
                    value={Array.from(new Set(snap.runs.map((r) => r.llm_model).filter((m): m is string => !!m))).join(", ")}
                    hint={undefined}
                  />
                )}
              </div>
            );
          })()}

          {/* Pipeline canvas — phases as columns, agents as cards. */}
          <div style={{
            display: "flex", gap: 12, overflowX: "auto", paddingBottom: 12,
            borderTop: "1px solid var(--surface1)", borderBottom: "1px solid var(--surface1)",
            paddingTop: 16, marginTop: 4,
          }}>
            {PIPELINE_PHASES.map((phase, idx) => (
              <React.Fragment key={phase.phase}>
                <div style={{ flex: "1 1 200px", minWidth: 200, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", paddingBottom: 4, borderBottom: "1px dashed var(--surface1)" }}>
                    Phase {phase.phase} · {phase.name}
                  </div>
                  {phase.agents.map((slug) => {
                    const run    = runsBySlug.get(slug);
                    const status = (run?.status ?? "pending") as AgentRunStatus | "pending";
                    const c      = statusColors(status);
                    const isPipComposer = slug === "pip-composer";
                    const isSelected    = selectedAgent === slug;
                    return (
                      <button
                        key={slug}
                        onClick={() => setSelectedAgent(slug)}
                        title={`Open ${slug} run details`}
                        style={{
                          padding: "10px 12px", borderRadius: 8,
                          background: c.bg, border: `1px solid ${isSelected ? "var(--blue)" : c.border}`,
                          boxShadow: isSelected ? "0 0 0 2px rgba(20,99,255,0.20)" : "none",
                          display: "flex", flexDirection: "column", gap: 4,
                          textAlign: "left", cursor: "pointer", fontFamily: "inherit",
                          transition: "border-color 0.15s, box-shadow 0.15s",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ color: c.fg, display: "flex", alignItems: "center" }}>
                            <StatusIcon status={status} />
                          </span>
                          <code style={{ fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text)" }}>
                            {slug}
                          </code>
                        </div>
                        <div style={{ fontSize: 9, color: c.fg, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          {status}
                          {isPipComposer && <span style={{ marginLeft: 6, color: "var(--overlay0)" }}>· human gate</span>}
                        </div>
                        {run?.started_at && (
                          <div style={{ fontSize: 9, color: "var(--overlay0)" }}>
                            started {formatRelative(run.started_at)}
                            {run.finished_at && ` · finished ${formatRelative(run.finished_at)}`}
                          </div>
                        )}
                        {(run?.cost_usd != null || run?.tokens_in != null) && (
                          <div style={{ fontSize: 9, color: "var(--overlay0)" }}>
                            {run.cost_usd != null && run.cost_usd > 0 && <>${run.cost_usd.toFixed(4)} </>}
                            {run.tokens_in != null && run.tokens_out != null && (
                              <>· {run.tokens_in.toLocaleString()} in / {run.tokens_out.toLocaleString()} out</>
                            )}
                          </div>
                        )}
                        {run?.error && (
                          <div style={{ fontSize: 10, color: "var(--red)", whiteSpace: "pre-wrap", marginTop: 4 }}>
                            {run.error.slice(0, 240)}
                            {run.error.length > 240 ? "…" : ""}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
                {idx < PIPELINE_PHASES.length - 1 && (
                  <div style={{ display: "flex", alignItems: "center", color: "var(--overlay0)", flexShrink: 0 }}>
                    <ArrowRight size={14} />
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>

          {/* Briefing block — read-only echo of what the sprint started with. */}
          {snap.sprint?.briefing && (
            <details style={{ marginTop: 24, padding: "12px 14px", borderRadius: 8, background: "var(--surface0)", border: "1px solid var(--surface1)" }}>
              <summary style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", cursor: "pointer" }}>
                Sprint briefing (anchoring)
              </summary>
              <pre style={{ marginTop: 10, fontSize: 11, color: "var(--subtext0)", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", lineHeight: 1.5 }}>
                {snap.sprint.briefing}
              </pre>
            </details>
          )}

          {/* Right-side agent run drawer — opens on card click. */}
          {selectedAgent && (
            <PipAgentDrawer
              agent={selectedAgent}
              run={runsBySlug.get(selectedAgent) ?? null}
              projectId={snap.project.id}
              onClose={() => setSelectedAgent(null)}
            />
          )}
        </>
      )}
    </PageShell>
  );
}

/* ───────────────────── Helpers ───────────────────── */

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
        {value}
      </span>
      {hint && (
        <span style={{ fontSize: 9, color: "var(--overlay0)" }}>{hint}</span>
      )}
    </div>
  );
}

/**
 * Slim right-side drawer mirroring ProjectCanvas's AgentDrawer pattern,
 * scoped to PIP's needs: status, model, tokens, cost, started/finished,
 * duration, error, output_ref. No Run-Once / approval controls — PIP is
 * one-shot and the gate is handled by the page header's Apply button.
 */
function PipAgentDrawer({
  agent,
  run,
  projectId: _projectId,  // reserved for future "view artifact" links
  onClose,
}: {
  agent:     string;
  run:       AgentRunRow | null;
  projectId: string;
  onClose:   () => void;
}) {
  void _projectId;

  // Close on Esc — same affordance as ProjectCanvas's drawer.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const status   = run?.status ?? "pending";
  const c        = statusColors(status);
  const duration = run?.started_at && run.finished_at
    ? Math.max(0, (Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000)
    : null;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 40,
          background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)",
        }}
      />
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 41,
        width: "min(460px, 92vw)",
        background: "var(--mantle)",
        borderLeft: "1px solid var(--surface1)",
        display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 32px rgba(0,0,0,0.4)",
        animation: "slideInRight 0.2s ease",
        overflowY: "auto",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 20px",
          borderBottom: "1px solid var(--surface1)",
          flexShrink: 0,
        }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: c.fg, flexShrink: 0 }} />
          <code style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", flex: 1, fontFamily: "var(--font-mono)" }}>
            {agent}
          </code>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
            background: c.bg, color: c.fg, textTransform: "uppercase", letterSpacing: "0.05em",
            fontFamily: "var(--font-mono)",
          }}>
            {status}
          </span>
          <button
            onClick={onClose}
            style={{
              marginLeft: 4, fontSize: 18, lineHeight: 1,
              color: "var(--overlay0)", background: "none", border: "none",
              cursor: "pointer", padding: "2px 6px", borderRadius: 4,
            }}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          {!run ? (
            <div style={{ fontSize: 12, color: "var(--overlay0)" }}>
              No agent_run row yet — this step hasn&apos;t started.
            </div>
          ) : (
            <>
              <section>
                <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                  Timing
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 11 }}>
                  <span style={{ color: "var(--overlay0)" }}>Started</span>
                  <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                    {run.started_at ? `${formatRelative(run.started_at)} (${new Date(run.started_at).toLocaleString()})` : "—"}
                  </span>
                  <span style={{ color: "var(--overlay0)" }}>Finished</span>
                  <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                    {run.finished_at ? `${formatRelative(run.finished_at)} (${new Date(run.finished_at).toLocaleString()})` : "—"}
                  </span>
                  <span style={{ color: "var(--overlay0)" }}>Duration</span>
                  <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                    {duration != null ? (duration < 60 ? `${duration.toFixed(1)}s` : `${(duration / 60).toFixed(1)}m`) : "—"}
                  </span>
                </div>
              </section>

              <section>
                <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                  LLM
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 11 }}>
                  <span style={{ color: "var(--overlay0)" }}>Model</span>
                  <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>{run.llm_model ?? "—"}</span>
                  <span style={{ color: "var(--overlay0)" }}>Tokens in</span>
                  <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>{run.tokens_in?.toLocaleString() ?? "—"}</span>
                  <span style={{ color: "var(--overlay0)" }}>Tokens out</span>
                  <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>{run.tokens_out?.toLocaleString() ?? "—"}</span>
                  <span style={{ color: "var(--overlay0)" }}>Cost</span>
                  <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                    {run.cost_usd != null ? `$${run.cost_usd.toFixed(4)}` : "—"}
                  </span>
                </div>
              </section>

              {run.output_ref && (
                <section>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                    Output
                  </div>
                  <div style={{ fontSize: 11, color: "var(--subtext0)", fontFamily: "var(--font-mono)", wordBreak: "break-all", padding: "8px 10px", background: "var(--surface0)", border: "1px solid var(--surface1)", borderRadius: 6 }}>
                    {run.output_ref}
                  </div>
                </section>
              )}

              {run.error && (
                <section>
                  <div style={{ fontSize: 9, fontWeight: 700, color: "var(--red)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                    Error
                  </div>
                  <pre style={{ fontSize: 11, color: "var(--red)", whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "8px 10px", background: "rgba(228,75,95,0.06)", border: "1px solid rgba(228,75,95,0.30)", borderRadius: 6, fontFamily: "var(--font-mono)", lineHeight: 1.4, margin: 0 }}>
                    {run.error}
                  </pre>
                </section>
              )}

              <section>
                <div style={{ fontSize: 9, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                  Step
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 11 }}>
                  <span style={{ color: "var(--overlay0)" }}>Step number</span>
                  <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>{run.step ?? "—"}</span>
                  <span style={{ color: "var(--overlay0)" }}>Phase</span>
                  <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>{run.phase ?? "—"}</span>
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
      `}</style>
    </>
  );
}
