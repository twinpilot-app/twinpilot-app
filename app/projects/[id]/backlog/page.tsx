"use client";

/**
 * /projects/[id]/backlog — kanban view of the project's activity list.
 *
 * Four columns (Todo / Doing / Done / Cancelled). Drag a card across
 * columns to change status; the order_index is appended to the new
 * column with a +100 gap. Within a column, the up/down buttons swap
 * adjacent items (also lazy-renumbered server-side via PATCH).
 *
 * No external DnD library — uses HTML5 native drag-and-drop. The
 * interaction is intentionally minimal: drag = move to column, arrows
 * = reorder, click pencil = edit modal, click trash = delete with
 * confirm. Anything richer can come later.
 */

import React, { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import {
  Loader2, ArrowLeft, Plus, Pencil, Trash2, X, ChevronUp, ChevronDown, ListTodo, Sparkles,
  Pause, Play, Bot, FastForward,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import AppSidebar from "@/components/AppSidebar";
import type { BacklogItem, BacklogStatus } from "@/lib/types";

const COLUMNS: { id: BacklogStatus; label: string; color: string; bg: string; border: string }[] = [
  { id: "todo",      label: "To do",     color: "var(--blue)",   bg: "rgba(20,99,255,0.05)",   border: "rgba(20,99,255,0.20)" },
  { id: "doing",     label: "Doing",     color: "var(--peach)",  bg: "rgba(245,159,0,0.05)",   border: "rgba(245,159,0,0.20)" },
  { id: "done",      label: "Done",      color: "var(--green)",  bg: "rgba(28,191,107,0.05)",  border: "rgba(28,191,107,0.20)" },
  { id: "cancelled", label: "Cancelled", color: "var(--overlay1)", bg: "var(--surface0)",     border: "var(--surface1)" },
];

interface ProjectInfo {
  id:        string;
  name:      string;
  slug:      string;
  execution_mode?: "manual" | "kanban_manual" | "kanban_auto";
  settings?: {
    auto_drain_pause_requested?: boolean;
    [k: string]: unknown;
  } | null;
}

export default function ProjectBacklogPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const { session: authSession, loading: authLoading } = useAuth();
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [items,   setItems]   = useState<BacklogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [editing, setEditing] = useState<BacklogItem | null>(null);
  const [newColumn, setNewColumn] = useState<BacklogStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [togglingPause, setTogglingPause] = useState(false);
  const [runningNext, setRunningNext] = useState(false);
  const [runNextResult, setRunNextResult] = useState<string | null>(null);

  const autoDrainOn = project?.execution_mode === "kanban_auto";
  const autoDrainPaused = project?.settings?.auto_drain_pause_requested === true;

  /**
   * Toggle the auto_drain_pause_requested flag — same wiring as the
   * project card on /, just surfaced where the operator manages items.
   * PATCH replaces settings, so we round-trip the entire object.
   */
  async function toggleAutoDrainPause() {
    if (!authSession || !projectId || !project) return;
    setTogglingPause(true);
    setError(null);
    try {
      const currentSettings = (project.settings ?? {}) as Record<string, unknown>;
      const nextSettings = { ...currentSettings, auto_drain_pause_requested: !autoDrainPaused };
      const res = await fetch(`/api/projects/${projectId}`, {
        method:  "PATCH",
        headers: { Authorization: `Bearer ${authSession.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ settings: nextSettings }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Toggle failed (${res.status})`);
      }
      // Optimistic update — avoids a full reload just for the badge flip.
      setProject({ ...project, settings: nextSettings as ProjectInfo["settings"] });
    } catch (e) { setError((e as Error).message); }
    finally       { setTogglingPause(false); }
  }

  /**
   * Manually advance the auto-drain queue by one tick for THIS project.
   * Hits the per-project endpoint that wraps the same attemptDrainOne
   * the cron uses. Useful right now while the Vercel cron is paused
   * (Hobby plan limit).
   */
  async function runNextItem() {
    if (!authSession || !projectId) return;
    setRunningNext(true);
    setError(null);
    setRunNextResult(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/auto-drain/run-next`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${authSession.access_token}` },
      });
      const body = await res.json() as {
        status?: string; reason?: string; sprintNum?: number; error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `Run failed (${res.status})`);
      if (body.status === "dispatched") {
        setRunNextResult(`Dispatched sprint #${body.sprintNum}.`);
      } else {
        setRunNextResult(`Skipped: ${body.reason ?? body.status}`);
      }
      await reload();
    } catch (e) { setError((e as Error).message); }
    finally       { setRunningNext(false); }
  }

  /** Call /api/projects/:id/backlog/generate-from-prd, append the result to the kanban. */
  async function generateFromPrd() {
    if (!authSession || !projectId) return;
    if (!confirm("Generate backlog items from this project's PRD? Existing items are kept; new ones are appended in the Todo column.")) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/backlog/generate-from-prd`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${authSession.access_token}` },
      });
      const body = await res.json() as { generated?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `Generation failed (${res.status})`);
      await reload();
      if (typeof body.generated === "number") {
        // Soft-confirmation: reuse the error banner styling but with success tint via setError-like channel?
        // Simpler: just rely on the count rendered in the header — operator sees it grew.
      }
    } catch (e) { setError((e as Error).message); }
    finally       { setGenerating(false); }
  }

  useEffect(() => {
    if (!authLoading && !authSession) router.replace("/login");
  }, [authLoading, authSession, router]);

  const reload = useCallback(async () => {
    if (!authSession || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [projRes, itemsRes] = await Promise.all([
        supabase.from("projects").select("id, name, slug, settings").eq("id", projectId).maybeSingle(),
        fetch(`/api/projects/${projectId}/backlog`, {
          headers: { Authorization: `Bearer ${authSession.access_token}` },
        }),
      ]);
      if (projRes.data) setProject(projRes.data as ProjectInfo);
      if (!itemsRes.ok) throw new Error(`Failed to load backlog (${itemsRes.status})`);
      const body = await itemsRes.json() as { items: BacklogItem[] };
      setItems(body.items ?? []);
    } catch (e) { setError((e as Error).message); }
    finally       { setLoading(false); }
  }, [authSession, projectId]);

  useEffect(() => { void reload(); }, [reload]);

  // ── Tag filter ────────────────────────────────────────────────────
  // Operator picks tags from the chip bar to scope the kanban. Empty
  // selection = no filter (show everything). The special "untagged"
  // pseudo-tag selects items with no metadata.tags. Multi-select uses
  // OR logic — items with ANY selected tag (or untagged when picked)
  // pass through.
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  // Compute unique tags + their counts across the project's items.
  // Sorted by count desc so the most-used tag is leftmost.
  const tagCounts = (() => {
    const m = new Map<string, number>();
    let untaggedCount = 0;
    for (const it of items) {
      const tags = (it.metadata?.tags ?? []) as string[];
      if (tags.length === 0) { untaggedCount++; continue; }
      for (const t of tags) m.set(t, (m.get(t) ?? 0) + 1);
    }
    const sorted = Array.from(m.entries()).sort(([, a], [, b]) => b - a);
    return { tags: sorted, untagged: untaggedCount };
  })();

  // Filter predicate. When selectedTags is empty, pass everything.
  // When non-empty: an item passes if it has any selected tag, OR if
  // "untagged" is selected and the item has no tags.
  function passesTagFilter(it: BacklogItem): boolean {
    if (selectedTags.size === 0) return true;
    const tags = (it.metadata?.tags ?? []) as string[];
    if (tags.length === 0) return selectedTags.has("__untagged__");
    return tags.some((t) => selectedTags.has(t));
  }

  function toggleTag(tag: string): void {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }

  // Group items by column, preserving order_index sort the API already
  // returned. Tag filter applied here so column counts reflect the
  // visible subset.
  const byColumn = new Map<BacklogStatus, BacklogItem[]>();
  for (const col of COLUMNS) byColumn.set(col.id, []);
  for (const it of items) {
    if (!passesTagFilter(it)) continue;
    byColumn.get(it.status)?.push(it);
  }

  async function patchItem(id: string, patch: Partial<Pick<BacklogItem, "title" | "description" | "status" | "order_index">>) {
    setBusy(id);
    try {
      const res = await fetch(`/api/projects/${projectId}/backlog/${id}`, {
        method:  "PATCH",
        headers: { Authorization: `Bearer ${authSession!.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Update failed (${res.status})`);
      }
      await reload();
    } catch (e) { setError((e as Error).message); }
    finally       { setBusy(null); }
  }

  async function deleteItem(id: string) {
    if (!confirm("Delete this item? This cannot be undone.")) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/projects/${projectId}/backlog/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authSession!.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Delete failed (${res.status})`);
      }
      await reload();
    } catch (e) { setError((e as Error).message); }
    finally       { setBusy(null); }
  }

  async function createItem(title: string, description: string, status: BacklogStatus) {
    try {
      const res = await fetch(`/api/projects/${projectId}/backlog`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${authSession!.access_token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ title, description: description || null, status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Create failed (${res.status})`);
      }
      setNewColumn(null);
      await reload();
    } catch (e) { setError((e as Error).message); }
  }

  // Move item to column at end. Used by both DnD and arrow buttons.
  async function moveToColumn(id: string, status: BacklogStatus) {
    const col = byColumn.get(status) ?? [];
    const max = col.reduce((m, it) => Math.max(m, it.order_index), 0);
    await patchItem(id, { status, order_index: max + 100 });
  }

  // Reorder within column by swapping order_index with neighbour.
  async function moveByDelta(id: string, delta: -1 | 1) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    const col = (byColumn.get(it.status) ?? []).slice().sort((a, b) => a.order_index - b.order_index);
    const idx = col.findIndex((x) => x.id === id);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= col.length) return;
    const target = col[targetIdx]!;
    // Swap order_index — two PATCHes. Simple and racey; for V1 fine.
    await patchItem(it.id,     { order_index: target.order_index });
    await patchItem(target.id, { order_index: it.order_index });
  }

  return (
    <div style={{ display: "flex", flex: 1, height: "100vh", overflow: "hidden", fontFamily: "var(--font-sans)", color: "var(--text)", background: "var(--base)" }}>
      <AppSidebar active="projects" />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{
          height: 50, borderBottom: "1px solid var(--surface0)", background: "var(--mantle)",
          display: "flex", alignItems: "center", padding: "0 20px", gap: 12, flexShrink: 0,
        }}>
          <button
            onClick={() => router.push(`/projects`)}
            title="Back to Projects"
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8,
              border: "none", background: "transparent", color: "var(--overlay0)",
              fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "var(--font-sans)",
            }}
          >
            <ArrowLeft size={14} /> Projects
          </button>
          <div style={{ width: 1, height: 22, background: "var(--surface0)" }} />
          <ListTodo size={16} color="var(--overlay0)" />
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
            {project ? `${project.name} — Backlog` : "Backlog"}
          </span>
          <div style={{ flex: 1 }} />
          {autoDrainOn && (
            <>
              <span
                title={autoDrainPaused
                  ? "Autonomous (paused) — toggle below to resume"
                  : "Autonomous — scheduler advances the queue automatically"}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  fontSize: 9, padding: "2px 6px", borderRadius: 4, fontWeight: 700,
                  background: autoDrainPaused ? "rgba(245,159,0,0.12)" : "rgba(20,99,255,0.12)",
                  color:      autoDrainPaused ? "var(--yellow, #df8e1d)"   : "var(--blue, #1463ff)",
                  flexShrink: 0,
                }}
              >
                <Bot size={9} /> {autoDrainPaused ? "autonomous · paused" : "autonomous"}
              </span>
              <button
                onClick={() => void toggleAutoDrainPause()}
                disabled={togglingPause}
                title={autoDrainPaused
                  ? "Resume auto-drain — scheduler will advance on the next tick"
                  : "Pause auto-drain — current sprint finishes naturally, no new dispatches until you resume"}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "5px 10px", borderRadius: 6,
                  border: "1px solid var(--surface1)", background: "transparent",
                  color: togglingPause ? "var(--overlay0)"
                    : autoDrainPaused ? "var(--blue, #1463ff)" : "var(--peach, #f59f00)",
                  fontSize: 11, fontWeight: 600, cursor: togglingPause ? "wait" : "pointer",
                  fontFamily: "var(--font-sans)",
                }}
              >
                {togglingPause ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} />
                  : autoDrainPaused ? <Play size={11} /> : <Pause size={11} />}
                {autoDrainPaused ? "Resume" : "Pause"}
              </button>
              <button
                onClick={() => void runNextItem()}
                disabled={runningNext || autoDrainPaused}
                title={autoDrainPaused
                  ? "Resume auto-drain first to run the next item"
                  : "Manually dispatch the next backlog item now (one tick of the scheduler)"}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "5px 10px", borderRadius: 6,
                  border: "1px solid var(--surface1)",
                  background: runningNext || autoDrainPaused ? "transparent" : "rgba(20,99,255,0.08)",
                  color: runningNext || autoDrainPaused ? "var(--overlay0)" : "var(--blue, #1463ff)",
                  fontSize: 11, fontWeight: 600, cursor: runningNext ? "wait" : autoDrainPaused ? "not-allowed" : "pointer",
                  fontFamily: "var(--font-sans)",
                }}
              >
                {runningNext ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <FastForward size={11} />}
                {runningNext ? "Running…" : "Run next"}
              </button>
            </>
          )}
          <button
            onClick={() => void generateFromPrd()}
            disabled={generating}
            title="Generate backlog items from this project's PRD via LLM"
            style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "5px 10px", borderRadius: 6,
              border: "1px solid var(--surface1)", background: "transparent",
              color: generating ? "var(--overlay0)" : "var(--mauve, #cba6f7)",
              fontSize: 11, fontWeight: 600, cursor: generating ? "wait" : "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            {generating ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : <Sparkles size={11} />}
            {generating ? "Generating…" : "Generate from PRD"}
          </button>
          <span style={{ fontSize: 11, color: "var(--overlay0)" }}>
            {items.length} item{items.length === 1 ? "" : "s"}
          </span>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
          {error && (
            <div style={{
              marginBottom: 12, padding: "10px 14px", borderRadius: 8,
              background: "rgba(243,139,168,0.08)", border: "1px solid rgba(243,139,168,0.25)",
              color: "var(--red)", fontSize: 12,
            }}>
              {error}
            </div>
          )}
          {runNextResult && (
            <div style={{
              marginBottom: 12, padding: "10px 14px", borderRadius: 8,
              background: runNextResult.startsWith("Dispatched") ? "rgba(28,191,107,0.08)" : "rgba(245,159,0,0.08)",
              border:     runNextResult.startsWith("Dispatched") ? "1px solid rgba(28,191,107,0.25)" : "1px solid rgba(245,159,0,0.25)",
              color:      runNextResult.startsWith("Dispatched") ? "var(--green)" : "var(--yellow, #df8e1d)",
              fontSize: 12,
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
              <span>{runNextResult}</span>
              <button onClick={() => setRunNextResult(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: 0 }}>
                <X size={14} />
              </button>
            </div>
          )}

          {/* Tag filter bar — chips per unique tag in the project, plus
              an "untagged" pseudo-tag. Click to toggle. Multi-select uses
              OR logic. Empty selection = no filter. */}
          {!loading && (tagCounts.tags.length > 0 || tagCounts.untagged > 0) && (
            <div style={{
              display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6,
              padding: "8px 14px", borderBottom: "1px solid var(--surface0)",
              background: "var(--mantle)",
            }}>
              <span style={{ fontSize: 10, color: "var(--overlay0)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginRight: 4 }}>
                Filter by tag
              </span>
              {tagCounts.tags.map(([tag, count]) => {
                const active = selectedTags.has(tag);
                return (
                  <button key={tag} onClick={() => toggleTag(tag)} style={{
                    fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 99,
                    background: active ? "rgba(20,99,255,0.18)" : "var(--surface0)",
                    color: active ? "var(--blue, #1463ff)" : "var(--subtext0)",
                    border: active ? "1px solid rgba(20,99,255,0.4)" : "1px solid var(--surface1)",
                    cursor: "pointer", fontFamily: "monospace",
                  }}>
                    #{tag} <span style={{ opacity: 0.7 }}>{count}</span>
                  </button>
                );
              })}
              {tagCounts.untagged > 0 && (() => {
                const active = selectedTags.has("__untagged__");
                return (
                  <button onClick={() => toggleTag("__untagged__")} style={{
                    fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 99,
                    background: active ? "rgba(245,159,0,0.18)" : "var(--surface0)",
                    color: active ? "var(--peach, #df8e1d)" : "var(--subtext0)",
                    border: active ? "1px solid rgba(245,159,0,0.4)" : "1px solid var(--surface1)",
                    cursor: "pointer", fontStyle: "italic",
                  }}>
                    untagged <span style={{ opacity: 0.7 }}>{tagCounts.untagged}</span>
                  </button>
                );
              })()}
              {selectedTags.size > 0 && (
                <button onClick={() => setSelectedTags(new Set())} style={{
                  fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 99,
                  background: "transparent", color: "var(--overlay0)",
                  border: "1px solid var(--surface1)", cursor: "pointer",
                  marginLeft: 4,
                }}>
                  clear
                </button>
              )}
            </div>
          )}

          {loading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60, color: "var(--overlay0)", fontSize: 13 }}>
              <Loader2 size={16} style={{ animation: "spin 1s linear infinite", marginRight: 8 }} /> Loading backlog…
            </div>
          ) : (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(220px, 1fr))",
              gap: 12,
              minHeight: "calc(100vh - 130px)",
            }}>
              {COLUMNS.map((col) => {
                const list = byColumn.get(col.id) ?? [];
                return (
                  <div
                    key={col.id}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      const id = e.dataTransfer.getData("text/plain");
                      if (!id) return;
                      const it = items.find((x) => x.id === id);
                      if (it && it.status !== col.id) void moveToColumn(id, col.id);
                    }}
                    style={{
                      background: col.bg,
                      border: `1px solid ${col.border}`,
                      borderRadius: 10,
                      display: "flex", flexDirection: "column",
                      minWidth: 0,
                    }}
                  >
                    <div style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "10px 12px", borderBottom: `1px solid ${col.border}`,
                    }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, color: col.color,
                        textTransform: "uppercase", letterSpacing: "0.06em",
                      }}>
                        {col.label}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{list.length}</span>
                      <div style={{ flex: 1 }} />
                      <button
                        onClick={() => setNewColumn(col.id)}
                        title={`Add to ${col.label}`}
                        style={{
                          display: "flex", alignItems: "center", gap: 3, padding: "3px 7px", borderRadius: 5,
                          border: "1px solid var(--surface1)", background: "transparent", color: col.color,
                          fontSize: 10, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)",
                        }}
                      >
                        <Plus size={10} /> New
                      </button>
                    </div>

                    <div style={{ flex: 1, padding: 8, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
                      {list.length === 0 && (
                        <div style={{
                          fontSize: 11, color: "var(--overlay0)", textAlign: "center",
                          padding: "16px 8px", fontStyle: "italic",
                        }}>
                          Drop here or click + New
                        </div>
                      )}
                      {list.map((it, idx) => {
                        const isFirst = idx === 0;
                        const isLast  = idx === list.length - 1;
                        const itemBusy = busy === it.id;
                        return (
                          <div
                            key={it.id}
                            draggable
                            onDragStart={(e) => { e.dataTransfer.setData("text/plain", it.id); e.dataTransfer.effectAllowed = "move"; }}
                            style={{
                              padding: "8px 10px", borderRadius: 7,
                              background: "var(--mantle)",
                              border: "1px solid var(--surface1)",
                              cursor: "grab",
                              opacity: itemBusy ? 0.5 : 1,
                              display: "flex", flexDirection: "column", gap: 4,
                            }}
                          >
                            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.4 }}>
                              {it.title}
                            </div>
                            {it.description && (
                              <div style={{
                                fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4,
                                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                              }}>
                                {it.description}
                              </div>
                            )}
                            <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                              {it.source !== "manual" && (() => {
                                // Visual: per-source color + label. Agent badge also
                                // shows sprint #N · agent-slug so the kanban exposes
                                // the full chain back to the originator. When source_url
                                // is present (GH issue, Jira ticket, …) the badge becomes
                                // a clickable link — drag-drop is preserved by stopping
                                // propagation on the click handler.
                                const visual =
                                  it.source === "wizard-gen" ? { bg: "rgba(164,120,255,0.15)", fg: "#a478ff",            label: "Wizard",  title: "Created by the Studio Wizard during onboarding" }
                                : it.source === "agent"      ? { bg: "rgba(20,99,255,0.15)",   fg: "var(--blue, #1463ff)", label: it.created_by_sprint_num != null && it.created_by_agent
                                                                                                                                  ? `Sprint #${it.created_by_sprint_num} · ${it.created_by_agent}`
                                                                                                                                  : it.created_by_agent ?? "Agent",
                                                                                                                          title: it.created_by_sprint_num != null && it.created_by_agent
                                                                                                                                  ? `Emitted by ${it.created_by_agent} during sprint #${it.created_by_sprint_num}`
                                                                                                                                  : "Created by an agent during a sprint" }
                                : it.source === "trigger"    ? { bg: "rgba(245,159,0,0.15)",   fg: "var(--yellow, #df8e1d)", label: "Trigger", title: "Created via webhook / external automation" }
                                                             : { bg: "rgba(28,191,107,0.15)",  fg: "var(--green)",         label: it.source, title: it.source };
                                const baseStyle = {
                                  fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                                  background: visual.bg, color: visual.fg,
                                  textTransform: "uppercase" as const, letterSpacing: "0.04em",
                                };
                                if (it.source_url) {
                                  return (
                                    <a
                                      href={it.source_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title={`${visual.title} — open ${it.source_url}`}
                                      onClick={(e) => e.stopPropagation()}
                                      style={{ ...baseStyle, textDecoration: "none", cursor: "pointer" }}
                                    >
                                      {visual.label} ↗
                                    </a>
                                  );
                                }
                                return (
                                  <span title={visual.title} style={baseStyle}>
                                    {visual.label}
                                  </span>
                                );
                              })()}
                              {/* Tags — operator/agent-applied labels grouping
                                  related items. metadata.tags is a free-form
                                  string array (slug-case convention). */}
                              {Array.isArray(it.metadata?.tags) && (it.metadata.tags as string[]).slice(0, 3).map((tag) => (
                                <span key={tag} title={`tag: ${tag}`} style={{
                                  fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                                  background: "var(--surface0)", color: "var(--subtext0)",
                                  fontFamily: "monospace",
                                }}>
                                  #{tag}
                                </span>
                              ))}
                              {/* Sprint history — how many sprints touched this
                                  item. Tooltip lists each one with verdict.
                                  Maintained automatically by the postgres
                                  trigger track_backlog_item_sprint_history. */}
                              {(() => {
                                const history = (it.metadata?.sprint_history as Array<{ sprint_num: number; outcome: string }> | undefined) ?? [];
                                if (history.length === 0) return null;
                                const tooltip = history
                                  .map((h) => `Sprint #${h.sprint_num}: ${h.outcome}`)
                                  .join("\n");
                                return (
                                  <span title={tooltip} style={{
                                    fontSize: 8, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                                    background: "rgba(166,227,161,0.12)", color: "var(--green, #40a02b)",
                                    cursor: "help",
                                  }}>
                                    🔁 {history.length}
                                  </span>
                                );
                              })()}
                              <div style={{ flex: 1 }} />
                              <button onClick={() => void moveByDelta(it.id, -1)} disabled={isFirst || itemBusy} title="Move up"
                                style={{ background: "transparent", border: "none", cursor: isFirst ? "default" : "pointer", padding: 2, color: isFirst ? "var(--overlay0)" : "var(--subtext0)", opacity: isFirst ? 0.4 : 1 }}>
                                <ChevronUp size={11} />
                              </button>
                              <button onClick={() => void moveByDelta(it.id, 1)} disabled={isLast || itemBusy} title="Move down"
                                style={{ background: "transparent", border: "none", cursor: isLast ? "default" : "pointer", padding: 2, color: isLast ? "var(--overlay0)" : "var(--subtext0)", opacity: isLast ? 0.4 : 1 }}>
                                <ChevronDown size={11} />
                              </button>
                              <button onClick={() => setEditing(it)} disabled={itemBusy} title="Edit"
                                style={{ background: "transparent", border: "none", cursor: "pointer", padding: 2, color: "var(--subtext0)" }}>
                                <Pencil size={11} />
                              </button>
                              <button onClick={() => void deleteItem(it.id)} disabled={itemBusy} title="Delete"
                                style={{ background: "transparent", border: "none", cursor: "pointer", padding: 2, color: "var(--red)" }}>
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
            </div>
          )}
        </div>
      </div>

      {editing && (
        <ItemModal
          item={editing}
          mode="edit"
          onClose={() => setEditing(null)}
          onSave={async (title, description) => {
            await patchItem(editing.id, { title, description: description || null });
            setEditing(null);
          }}
        />
      )}

      {newColumn && (
        <ItemModal
          item={null}
          mode="create"
          status={newColumn}
          onClose={() => setNewColumn(null)}
          onSave={async (title, description) => {
            await createItem(title, description, newColumn);
          }}
        />
      )}

      <style>{`@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ItemModal({
  item, mode, status, onClose, onSave,
}: {
  item: BacklogItem | null;
  mode: "edit" | "create";
  status?: BacklogStatus;
  onClose: () => void;
  onSave: (title: string, description: string) => void | Promise<void>;
}) {
  const [title, setTitle]             = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [saving, setSaving]           = useState(false);

  async function save() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onSave(title.trim(), description.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "var(--mantle)", border: "1px solid var(--surface1)",
        borderRadius: 12, width: "min(520px, 92vw)", padding: 20,
        boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        fontFamily: "var(--font-sans)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {mode === "edit" ? "Edit backlog item" : `New item — ${status}`}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)" }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11, color: "var(--subtext0)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Title
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            placeholder="Short, action-oriented title"
            style={{
              width: "100%", marginTop: 6, padding: "8px 10px", borderRadius: 7,
              background: "var(--surface0)", border: "1px solid var(--surface1)",
              color: "var(--text)", fontSize: 13, outline: "none", fontFamily: "var(--font-sans)",
            }}
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: "var(--subtext0)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Description <span style={{ fontWeight: 400, color: "var(--overlay0)" }}>(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="1-3 sentences elaborating on the activity"
            style={{
              width: "100%", marginTop: 6, padding: "8px 10px", borderRadius: 7,
              background: "var(--surface0)", border: "1px solid var(--surface1)",
              color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-sans)",
              resize: "vertical", lineHeight: 1.5,
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={saving} style={{
            padding: "7px 14px", borderRadius: 7, border: "1px solid var(--surface1)",
            background: "transparent", color: "var(--subtext0)",
            fontSize: 12, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)",
          }}>
            Cancel
          </button>
          <button onClick={() => void save()} disabled={saving || !title.trim()} style={{
            padding: "7px 16px", borderRadius: 7, border: "none",
            background: title.trim() ? "#1463ff" : "var(--surface1)",
            color: title.trim() ? "#fff" : "var(--overlay0)",
            fontSize: 12, fontWeight: 700, cursor: (saving || !title.trim()) ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)",
            display: "flex", alignItems: "center", gap: 5,
          }}>
            {saving ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : null}
            {mode === "edit" ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
