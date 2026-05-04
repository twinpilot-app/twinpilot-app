"use client";

/**
 * /studio/drafts — read-only mirror of /studio for the active Wizard
 * dry-run session. Same sidebar, same tab nav, same card visuals — only
 * the data source differs (active studio_sessions.plan instead of the
 * live tables) and the per-card actions are reduced to Discard. Confirm
 * All flushes via /api/studio/sessions/:id/confirm and lands the
 * operator back at /studio with the new rows visible.
 */

import React, { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2, Bot, GitBranch, FolderKanban, ArrowLeft,
  CheckCircle2, XCircle, Trash2, ChevronDown, ChevronRight, Layers, History, Clock, ListTodo,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import AppSidebar from "@/components/AppSidebar";
import type {
  StudioPlan, StagedAgent, StagedPipeline, StagedProject, StagedBacklogItem, StagedOperation,
} from "@/lib/studio-plan-types";

// Mirror of SQUAD_COLORS in /studio so the colored squad bar matches.
const SQUAD_COLORS: Record<string, string> = {
  discovery: "#10b981", "product-design": "#6366f1", engineering: "#f59e0b",
  "platform-devops": "#0ea5e9", "release-engineering": "#0ea5e9",
  "data-engineering": "#f97316", "ai-ml-engineering": "#a855f7",
  marketing: "#f43f5e", operations: "#8b5cf6", governance: "#ef4444",
  strategy: "#06b6d4", "command-center": "#d946ef",
};

type Tab = "agents" | "pipelines" | "projects" | "backlog";

interface SessionResponse {
  session: {
    id:    string;
    plan:  StudioPlan;
    created_at: string;
    updated_at: string;
  } | null;
  pendingCount: number;
}

interface SessionSummary {
  id:           string;
  status:       "draft" | "confirmed" | "discarded";
  created_at:   string;
  updated_at:   string;
  confirmed_at: string | null;
  counts: {
    agents:     number;
    pipelines:  number;
    projects:   number;
    operations: number;
  };
  committed?: {
    agents:    Record<string, string>;
    pipelines: Record<string, string>;
    projects:  Record<string, string>;
  };
}

export default function StudioDraftsPage() {
  const router = useRouter();
  const { session: authSession, loading: authLoading, factoryId, factoryName } = useAuth();
  const [tab, setTab] = useState<Tab>("agents");
  const [loading, setLoading]   = useState(true);
  const [data,    setData]      = useState<SessionResponse | null>(null);
  const [history, setHistory]   = useState<SessionSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error,   setError]     = useState<string | null>(null);
  const [busy,    setBusy]      = useState<string | null>(null);
  const [globalBusy, setGlobalBusy] = useState<"confirm" | "discard" | null>(null);

  useEffect(() => {
    if (!authLoading && !authSession) router.replace("/login");
  }, [authLoading, authSession, router]);
  useEffect(() => {
    if (!authLoading && authSession && !factoryId) router.replace("/factory-settings");
  }, [authLoading, authSession, factoryId, router]);

  const reload = useCallback(async () => {
    if (!authSession || !factoryId) return;
    setLoading(true);
    setError(null);
    try {
      // Two calls in parallel: full plan for the active draft (so the body
      // can render cards) + session summaries for the history strip.
      const [activeRes, listRes] = await Promise.all([
        fetch(`/api/studio/session?factoryId=${encodeURIComponent(factoryId)}`, {
          headers: { Authorization: `Bearer ${authSession.access_token}` },
        }),
        fetch(`/api/studio/sessions?factoryId=${encodeURIComponent(factoryId)}&status=confirmed&limit=20`, {
          headers: { Authorization: `Bearer ${authSession.access_token}` },
        }),
      ]);
      if (!activeRes.ok) throw new Error(`Failed to load draft (${activeRes.status})`);
      setData(await activeRes.json() as SessionResponse);
      if (listRes.ok) {
        const body = await listRes.json() as { sessions: SessionSummary[] };
        setHistory(body.sessions ?? []);
      }
    } catch (e) { setError((e as Error).message); }
    finally       { setLoading(false); }
  }, [authSession, factoryId]);

  useEffect(() => { void reload(); }, [reload]);

  async function discardItem(type: "agent" | "pipeline" | "project" | "backlog" | "operation", id: string) {
    if (!data?.session || busy) return;
    setBusy(`${type}:${id}`);
    try {
      const res = await fetch(
        `/api/studio/sessions/${data.session.id}/items?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${authSession!.access_token}` } },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Discard failed (${res.status})`);
      }
      await reload();
    } catch (e) { setError((e as Error).message); }
    finally       { setBusy(null); }
  }

  async function confirmAll() {
    if (!data?.session || globalBusy) return;
    setGlobalBusy("confirm");
    try {
      const res = await fetch(`/api/studio/sessions/${data.session.id}/confirm`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${authSession!.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({}),
      });
      const body = await res.json() as { ok?: boolean; error?: string; partialRollback?: boolean };
      if (!res.ok || !body.ok) {
        const detail = body.error ?? `Confirm failed (${res.status})`;
        const suffix = body.partialRollback ? " — partial inserts rolled back" : "";
        throw new Error(`${detail}${suffix}`);
      }
      router.push("/studio");
    } catch (e) {
      setError((e as Error).message);
      setGlobalBusy(null);
    }
  }

  async function discardAll() {
    if (!data?.session || globalBusy) return;
    if (!confirm(`Discard all ${data.pendingCount} pending change${data.pendingCount === 1 ? "" : "s"}?`)) return;
    setGlobalBusy("discard");
    try {
      const res = await fetch(`/api/studio/sessions/${data.session.id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${authSession!.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Discard failed (${res.status})`);
      }
      setData({ session: null, pendingCount: 0 });
    } catch (e) { setError((e as Error).message); }
    finally       { setGlobalBusy(null); }
  }

  const plan = data?.session?.plan;
  const tabs: { id: Tab; label: string; icon: React.FC<{ size?: number }>; count: number }[] = [
    { id: "agents",    label: "Agents",    icon: Bot,           count: plan?.agents.length        ?? 0 },
    { id: "pipelines", label: "Pipelines", icon: GitBranch,     count: plan?.pipelines.length     ?? 0 },
    { id: "projects",  label: "Projects",  icon: FolderKanban,  count: plan?.projects.length      ?? 0 },
    { id: "backlog",   label: "Backlog",   icon: ListTodo,      count: plan?.backlogItems?.length ?? 0 },
  ];

  return (
    <div style={{ display: "flex", flex: 1, height: "100vh", overflow: "hidden", fontFamily: "var(--font-sans)", color: "var(--text)", background: "var(--base)" }}>
      <AppSidebar active="studio" />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Header — back, tabs, factory badge, Discard/Confirm */}
        <div style={{ height: 50, borderBottom: "1px solid var(--surface0)", background: "var(--mantle)", display: "flex", alignItems: "center", padding: "0 20px", gap: 4, flexShrink: 0 }}>
          <button
            onClick={() => router.push("/studio")}
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8,
              border: "none", background: "transparent", color: "var(--overlay0)",
              fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "var(--font-sans)",
            }}
          >
            <ArrowLeft size={14} /> Studio
          </button>
          <div style={{ width: 1, height: 22, background: "var(--surface0)", margin: "0 8px" }} />
          <Layers size={16} color="var(--overlay0)" style={{ marginRight: 4 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: "#a478ff", textTransform: "uppercase", letterSpacing: "0.06em", marginRight: 8 }}>
            Wizard Drafts
          </span>
          {data?.session && (
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              fontSize: 10, color: "var(--overlay0)", marginRight: 8,
              fontFamily: "var(--font-sans)",
            }}>
              <Clock size={10} /> resuming {relativeTime(data.session.updated_at)}
            </span>
          )}
          {tabs.map(({ id, label, icon: Icon, count }) => {
            const active = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)} style={{
                display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8,
                border: "none",
                background: active ? "var(--surface0)" : "transparent",
                color: active ? "var(--text)" : "var(--overlay0)",
                fontSize: 13, fontWeight: active ? 700 : 500, cursor: "pointer",
                fontFamily: "var(--font-sans)", transition: "all 0.15s",
              }}>
                <Icon size={14} /> {label}
                {count > 0 && <span style={{ fontSize: 10, color: active ? "#a478ff" : "var(--overlay1)", fontWeight: 700 }}>{count}</span>}
              </button>
            );
          })}
          <div style={{ flex: 1 }} />
          {history.length > 0 && (
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              title={historyOpen ? "Hide confirmation history" : "Show confirmation history"}
              style={{
                display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 7,
                border: "1px solid var(--surface1)",
                background: historyOpen ? "var(--surface0)" : "transparent",
                color: historyOpen ? "var(--text)" : "var(--overlay0)",
                fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-sans)",
                marginRight: 8,
              }}
            >
              <History size={11} /> History {history.length}
            </button>
          )}
          {factoryName && (
            <span style={{ fontSize: 11, color: "var(--overlay0)", marginRight: 12 }}>{factoryName}</span>
          )}
          {data?.session && (
            <>
              <button
                onClick={() => void discardAll()}
                disabled={!!globalBusy}
                style={{
                  display: "flex", alignItems: "center", gap: 5, padding: "5px 11px", borderRadius: 7,
                  border: "1px solid var(--surface1)", background: "transparent", color: "var(--red)",
                  fontSize: 11, fontWeight: 700, cursor: globalBusy ? "not-allowed" : "pointer",
                  fontFamily: "var(--font-sans)",
                }}
              >
                {globalBusy === "discard" ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <XCircle size={11} />}
                Discard All
              </button>
              <button
                onClick={() => void confirmAll()}
                disabled={!!globalBusy}
                style={{
                  display: "flex", alignItems: "center", gap: 5, padding: "6px 14px", borderRadius: 7,
                  border: "none", background: globalBusy ? "var(--surface1)" : "#a478ff", color: "#fff",
                  fontSize: 11, fontWeight: 700, cursor: globalBusy ? "not-allowed" : "pointer",
                  fontFamily: "var(--font-sans)", marginLeft: 6,
                }}
              >
                {globalBusy === "confirm" ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <CheckCircle2 size={11} />}
                Confirm All
              </button>
            </>
          )}
          <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {error && (
            <div style={{
              margin: "16px 24px", padding: "10px 14px", borderRadius: 8,
              background: "rgba(243,139,168,0.08)", border: "1px solid rgba(243,139,168,0.25)",
              color: "var(--red)", fontSize: 12,
            }}>
              {error}
            </div>
          )}

          {historyOpen && history.length > 0 && (
            <div style={{
              borderBottom: "1px solid var(--surface0)", background: "var(--mantle)",
              padding: "12px 24px",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <History size={12} color="var(--overlay0)" />
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Recent confirmations
                </span>
                <span style={{ fontSize: 10, color: "var(--overlay0)" }}>({history.length})</span>
              </div>
              <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
                {history.map((s) => <HistoryCard key={s.id} session={s} />)}
              </div>
            </div>
          )}
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60, color: "var(--overlay0)", fontSize: 13 }}>
              <Loader2 size={16} style={{ animation: "spin 1s linear infinite", marginRight: 8 }} /> Loading draft…
            </div>
          ) : !plan ? (
            <EmptyState />
          ) : (
            <div style={{ maxWidth: 920, margin: "0 auto", padding: "28px 24px" }}>
              {tab === "agents"    && <AgentsView    agents={plan.agents}                           operations={plan.operations} discardBusy={busy} onDiscard={discardItem} />}
              {tab === "pipelines" && <PipelinesView pipelines={plan.pipelines}                     discardBusy={busy} onDiscard={discardItem} />}
              {tab === "projects"  && <ProjectsView  projects={plan.projects}                       operations={plan.operations} discardBusy={busy} onDiscard={discardItem} />}
              {tab === "backlog"   && <BacklogView   items={plan.backlogItems ?? []} projects={plan.projects} discardBusy={busy} onDiscard={discardItem} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Empty state ───────────────────────────────────────────────────────────── */

function EmptyState() {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: 80, color: "var(--overlay0)", textAlign: "center",
    }}>
      <Bot size={36} color="var(--surface1)" style={{ marginBottom: 12 }} />
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--subtext0)", marginBottom: 6 }}>
        No pending changes
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, maxWidth: 360 }}>
        Open the Wizard from the Studio (the wand button at the bottom-right) and ask it to create agents, pipelines, or projects. They'll appear here for review before anything is written.
      </div>
    </div>
  );
}

/* ── Agents view — grouped by squad, mirrors /studio AgentCard look ────────── */

function AgentsView({
  agents, operations: _operations, discardBusy, onDiscard,
}: {
  agents: StagedAgent[];
  operations: StagedOperation[];
  discardBusy: string | null;
  onDiscard: (type: "agent", id: string) => void;
}) {
  if (agents.length === 0) return <SectionEmpty label="No agents staged" />;

  // Group by squad string. Empty squad → "ungrouped".
  const groups = new Map<string, StagedAgent[]>();
  for (const a of agents) {
    const key = (a.squad ?? "").trim() || "_ungrouped";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      {sorted.map(([squad, list]) => {
        const ungrouped = squad === "_ungrouped";
        const color = ungrouped ? "var(--overlay0)" : (SQUAD_COLORS[squad] ?? "var(--overlay1)");
        return (
          <div key={squad} style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ width: 3, height: 14, borderRadius: 2, background: color }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--subtext1)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {ungrouped ? "Ungrouped" : squad}
              </span>
              <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{list.length}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
              {list.map((a) => (
                <DraftAgentCard
                  key={a.id}
                  agent={a}
                  color={color}
                  busy={discardBusy === `agent:${a.id}`}
                  onDiscard={() => onDiscard("agent", a.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

function DraftAgentCard({
  agent, color, busy, onDiscard,
}: { agent: StagedAgent; color: string; busy: boolean; onDiscard: () => void }) {
  return (
    <div style={{
      background: "rgba(164,120,255,0.05)",
      border: "1px solid rgba(164,120,255,0.25)",
      borderRadius: 10, padding: "12px 14px",
      opacity: busy ? 0.5 : 1, transition: "opacity 0.15s",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flex: 1, minWidth: 0 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8, flexShrink: 0,
            background: `${color}18`, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: agent.icon ? 16 : 14,
          }}>
            {agent.icon ?? <Bot size={14} color={color} strokeWidth={1.5} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
              {agent.name}
            </div>
            <code style={{ fontSize: 10, color: "var(--overlay0)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", maxWidth: 140 }}>
              {agent.slug}
            </code>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          <span style={{
            fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
            background: "rgba(164,120,255,0.18)", color: "#a478ff",
            textTransform: "uppercase", letterSpacing: "0.05em",
          }}>
            Staged
          </span>
          <button
            onClick={onDiscard}
            disabled={busy}
            title="Discard this agent"
            style={{ background: "transparent", border: "none", cursor: busy ? "not-allowed" : "pointer", color: "var(--red)", padding: 2 }}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      {agent.persona && (
        <div style={{
          marginTop: 8, fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4,
          maxHeight: 60, overflow: "hidden",
          display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
        }}>
          {agent.persona}
        </div>
      )}
      {(agent.level || (agent.tools && agent.tools.length > 0) || (agent.tags && agent.tags.length > 0)) && (
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4, fontSize: 9, color: "var(--overlay1)" }}>
          {agent.level && <span style={{ padding: "1px 5px", borderRadius: 4, background: "var(--surface0)" }}>{agent.level}</span>}
          {agent.tools && agent.tools.length > 0 && (
            <span style={{ padding: "1px 5px", borderRadius: 4, background: "var(--surface0)" }}>
              {agent.tools.length} tools
            </span>
          )}
          {agent.tags?.slice(0, 4).map((t, i) => (
            <span key={i} style={{ padding: "1px 5px", borderRadius: 4, background: "var(--surface0)" }}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Pipelines view ────────────────────────────────────────────────────────── */

function PipelinesView({
  pipelines, discardBusy, onDiscard,
}: {
  pipelines: StagedPipeline[];
  discardBusy: string | null;
  onDiscard: (type: "pipeline", id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  if (pipelines.length === 0) return <SectionEmpty label="No pipelines staged" />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {pipelines.map((p) => {
        const open = expanded.has(p.id);
        const busy = discardBusy === `pipeline:${p.id}`;
        return (
          <div key={p.id} style={{
            background: "rgba(164,120,255,0.05)",
            border: "1px solid rgba(164,120,255,0.25)",
            borderRadius: 10, padding: "12px 14px",
            opacity: busy ? 0.5 : 1,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                onClick={() => toggle(p.id)}
                style={{ display: "flex", alignItems: "center", padding: 0, border: "none", background: "transparent", cursor: "pointer", color: "var(--overlay0)" }}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <GitBranch size={14} color="var(--blue)" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{p.name}</div>
                <div style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>
                  {p.slug} · {p.steps.length} step{p.steps.length === 1 ? "" : "s"}
                </div>
              </div>
              <span style={{
                fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                background: "rgba(164,120,255,0.18)", color: "#a478ff",
                textTransform: "uppercase", letterSpacing: "0.05em",
              }}>
                Staged
              </span>
              <button onClick={() => onDiscard("pipeline", p.id)} disabled={busy} title="Discard"
                style={{ background: "transparent", border: "none", cursor: busy ? "not-allowed" : "pointer", color: "var(--red)", padding: 2 }}>
                <Trash2 size={11} />
              </button>
            </div>
            {p.description && !open && (
              <div style={{ marginTop: 6, marginLeft: 28, fontSize: 11, color: "var(--subtext0)" }}>{p.description}</div>
            )}
            {open && (
              <div style={{ marginTop: 10, marginLeft: 28 }}>
                {p.description && <div style={{ marginBottom: 8, fontSize: 11, color: "var(--subtext0)" }}>{p.description}</div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {p.steps.map((s) => (
                    <div key={s.step} style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "5px 8px", borderRadius: 6,
                      background: "var(--surface0)", border: "1px solid var(--surface1)",
                    }}>
                      <span style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)", width: 24 }}>
                        #{s.step}
                      </span>
                      <code style={{ fontSize: 11, color: "var(--text)", flex: 1 }}>{s.agent}</code>
                      {s.phaseName && <span style={{ fontSize: 10, color: "var(--overlay1)" }}>{s.phaseName}</span>}
                      {s.gate === "human" && (
                        <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, background: "rgba(245,159,0,0.12)", color: "var(--peach)", fontWeight: 700 }}>
                          GATE
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Projects view ─────────────────────────────────────────────────────────── */

function ProjectsView({
  projects, operations, discardBusy, onDiscard,
}: {
  projects: StagedProject[];
  operations: StagedOperation[];
  discardBusy: string | null;
  onDiscard: (type: "project" | "operation", id: string) => void;
}) {
  if (projects.length === 0 && operations.length === 0) return <SectionEmpty label="No projects staged" />;
  return (
    <>
      {projects.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10, marginBottom: 20 }}>
          {projects.map((p) => {
            const busy = discardBusy === `project:${p.id}`;
            return (
              <div key={p.id} style={{
                background: "rgba(164,120,255,0.05)",
                border: "1px solid rgba(164,120,255,0.25)",
                borderRadius: 10, padding: "12px 14px",
                opacity: busy ? 0.5 : 1,
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
                    <FolderKanban size={14} color="var(--green)" />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.name}
                      </div>
                      <code style={{ fontSize: 10, color: "var(--overlay0)" }}>{p.slug}</code>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{
                      fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                      background: "rgba(164,120,255,0.18)", color: "#a478ff",
                      textTransform: "uppercase", letterSpacing: "0.05em",
                    }}>
                      Staged
                    </span>
                    <button onClick={() => onDiscard("project", p.id)} disabled={busy} title="Discard"
                      style={{ background: "transparent", border: "none", cursor: busy ? "not-allowed" : "pointer", color: "var(--red)", padding: 2 }}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
                {p.brief && (
                  <div style={{
                    fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5,
                    maxHeight: 60, overflow: "hidden",
                    display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
                  }}>
                    {p.brief}
                  </div>
                )}
                {p.pipelineId && (
                  <div style={{ marginTop: 6, fontSize: 10, color: "var(--overlay1)", fontFamily: "var(--font-mono)" }}>
                    pipeline: {shortRef(p.pipelineId)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {operations.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 3, height: 14, borderRadius: 2, background: "var(--peach)" }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--subtext1)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Operations
            </span>
            <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{operations.length}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {operations.map((op, i) => {
              const busy = discardBusy === `operation:${String(i)}`;
              return (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 12px", borderRadius: 8,
                  background: "var(--surface0)", border: "1px solid var(--surface1)",
                  opacity: busy ? 0.5 : 1,
                }}>
                  <code style={{ fontSize: 11, color: "var(--text)", fontWeight: 700 }}>{op.kind}</code>
                  <span style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)", flex: 1 }}>
                    project: {shortRef(op.projectId)} ← pipeline: {shortRef(op.pipelineId)}
                  </span>
                  <button onClick={() => onDiscard("operation", String(i))} disabled={busy}
                    style={{ background: "transparent", border: "none", cursor: busy ? "not-allowed" : "pointer", color: "var(--red)", padding: 2 }}>
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

/* ── Backlog view ──────────────────────────────────────────────────────────── */

function BacklogView({
  items, projects, discardBusy, onDiscard,
}: {
  items: StagedBacklogItem[];
  projects: StagedProject[];
  discardBusy: string | null;
  onDiscard: (type: "backlog", id: string) => void;
}) {
  if (items.length === 0) return <SectionEmpty label="No backlog items staged" />;

  // Group by project so the operator sees which project each batch
  // belongs to. projectId may be a real UUID (existing project) or a
  // staged id (project also in this plan).
  const projectLookup = new Map<string, string>(projects.map((p) => [p.id, p.name]));
  const groups = new Map<string, StagedBacklogItem[]>();
  for (const it of items) {
    const key = it.projectId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(it);
  }

  return (
    <>
      {[...groups.entries()].map(([projectId, list]) => {
        const projectName = projectLookup.get(projectId)
          ?? (projectId.startsWith("staged:") ? `(staged project) ${shortRef(projectId)}` : `(existing project) ${shortRef(projectId)}`);
        return (
          <div key={projectId} style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <div style={{ width: 3, height: 14, borderRadius: 2, background: "#a478ff" }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--subtext1)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {projectName}
              </span>
              <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{list.length} item{list.length === 1 ? "" : "s"}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {list.map((it) => {
                const busy = discardBusy === `backlog:${it.id}`;
                return (
                  <div key={it.id} style={{
                    display: "flex", alignItems: "flex-start", gap: 10,
                    padding: "8px 10px", borderRadius: 8,
                    background: "rgba(164,120,255,0.05)",
                    border: "1px solid rgba(164,120,255,0.25)",
                    opacity: busy ? 0.5 : 1,
                  }}>
                    <ListTodo size={12} color="#a478ff" style={{ marginTop: 2, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.4 }}>
                        {it.title}
                      </div>
                      {it.description && (
                        <div style={{
                          fontSize: 11, color: "var(--subtext0)", marginTop: 2, lineHeight: 1.4,
                          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                        }}>
                          {it.description}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                      <span style={{
                        fontSize: 8, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
                        background: "rgba(164,120,255,0.18)", color: "#a478ff",
                        textTransform: "uppercase", letterSpacing: "0.05em",
                      }}>
                        Staged
                      </span>
                      <button
                        onClick={() => onDiscard("backlog", it.id)}
                        disabled={busy}
                        title="Discard this backlog item"
                        style={{ background: "transparent", border: "none", cursor: busy ? "not-allowed" : "pointer", color: "var(--red)", padding: 2 }}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
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

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function SectionEmpty({ label }: { label: string }) {
  return (
    <div style={{ padding: "20px 0", fontSize: 12, color: "var(--overlay0)", textAlign: "center" }}>
      {label}
    </div>
  );
}

function shortRef(ref: string): string {
  if (!ref) return "—";
  if (ref.startsWith("staged:")) {
    const idx = ref.lastIndexOf("-");
    return idx > 7 ? `${ref.slice(0, idx + 1)}${ref.slice(idx + 1, idx + 7)}…` : ref;
  }
  return ref.length > 12 ? `${ref.slice(0, 8)}…${ref.slice(-4)}` : ref;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)        return "just now";
  if (ms < 3_600_000)     return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000)    return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 604_800_000)   return `${Math.floor(ms / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function HistoryCard({ session }: { session: SessionSummary }) {
  const total = session.counts.agents + session.counts.pipelines + session.counts.projects + session.counts.operations;
  return (
    <div style={{
      flex: "0 0 auto", minWidth: 200, maxWidth: 260,
      padding: "8px 10px", borderRadius: 8,
      background: "rgba(28,191,107,0.04)",
      border: "1px solid rgba(28,191,107,0.20)",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
          background: "rgba(28,191,107,0.15)", color: "var(--green)",
          textTransform: "uppercase", letterSpacing: "0.05em",
        }}>
          Confirmed
        </span>
        <span style={{ fontSize: 10, color: "var(--overlay0)" }}>
          {relativeTime(session.confirmed_at ?? session.updated_at)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.4 }}>
        {total} item{total === 1 ? "" : "s"} created
      </div>
      <div style={{ display: "flex", gap: 8, fontSize: 10, color: "var(--overlay1)", flexWrap: "wrap" }}>
        {session.counts.agents    > 0 && <span><Bot size={9} style={{ verticalAlign: -1 }} /> {session.counts.agents}</span>}
        {session.counts.pipelines > 0 && <span><GitBranch size={9} style={{ verticalAlign: -1 }} /> {session.counts.pipelines}</span>}
        {session.counts.projects  > 0 && <span><FolderKanban size={9} style={{ verticalAlign: -1 }} /> {session.counts.projects}</span>}
      </div>
    </div>
  );
}
