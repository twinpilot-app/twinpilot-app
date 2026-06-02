"use client";

import React, { useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import {
  Plus, FolderOpen, Search, RefreshCw,
} from "lucide-react";
import AppSidebar from "@/components/AppSidebar";
import { ProjectCard, StatusBadge, type Project, type Sprint } from "@/components/ProjectCard";
import type { Pipeline, ProjectSettings } from "@/components/ProjectSettingsModal";

/** Lazy-loaded behind the "Edit Project Settings" click. */
const ProjectSettingsModal = dynamic(() => import("@/components/ProjectSettingsModal"), { ssr: false });
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";

/** Lazy-loaded behind the "+ New Project" button. */
const NewProjectModal = dynamic(() => import("@/components/NewProjectModal"), { ssr: false });

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
