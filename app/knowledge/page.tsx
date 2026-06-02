"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import IntegrationsShell from "../../components/IntegrationsShell";
import { useAuth } from "../../lib/auth-context";
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Plus,
  Trash2,
  Search,
  RefreshCw,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  X,
  Brain,
  FileText,
  Globe,
  GitBranch,
  Hash,
  Eye,
  Settings,
  Clock,
  Zap,
  ToggleLeft,
  ToggleRight,
  Eraser,
  Layers,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KnowledgeSource {
  id: string;
  name: string;
  type: "url" | "document" | "github" | "slack";
  status: "pending" | "indexing" | "indexed" | "error" | "paused";
  chunk_count: number;
  token_count?: number;
  last_indexed_at: string | null;
  config: Record<string, unknown>;
  error_message?: string | null;
  created_at?: string;
}

interface KnowledgeInstance {
  id: string;
  name: string;
  description: string | null;
  source_count: number;
  chunk_count: number;
  sources?: KnowledgeSource[];
}

type SourceType = "url" | "document" | "github" | "slack";

interface SearchResult {
  content: string;
  source_name: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status: string) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    pending:  { bg: "rgba(245,159,0,0.12)", color: "var(--peach)",  label: "Pending" },
    indexing: { bg: "rgba(20,99,255,0.12)", color: "var(--blue)",   label: "Indexing" },
    indexed:  { bg: "rgba(64,160,43,0.12)", color: "var(--green)",  label: "Indexed" },
    error:    { bg: "rgba(228,75,95,0.12)", color: "var(--red)",    label: "Error" },
    paused:   { bg: "rgba(107,122,158,0.12)", color: "var(--overlay1)", label: "Disabled" },
  };
  const s = map[status] ?? map.pending;
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99,
      background: s.bg, color: s.color, textTransform: "uppercase",
      letterSpacing: "0.04em",
    }}>
      {s.label}
    </span>
  );
}

function sourceTypeIcon(type: SourceType) {
  switch (type) {
    case "url":      return <Globe size={13} style={{ color: "var(--blue)" }} />;
    case "document": return <FileText size={13} style={{ color: "var(--mauve)" }} />;
    case "github":   return <GitBranch size={13} style={{ color: "var(--text)" }} />;
    case "slack":    return <Hash size={13} style={{ color: "var(--peach)" }} />;
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function KnowledgePage() {
  const router = useRouter();
  const { session, tenantId, loading: authLoading } = useAuth();

  // Auth guard
  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  // ── State ───────────────────────────────────────────────────────────────────

  const [instances, setInstances] = useState<KnowledgeInstance[]>([]);
  const [loadingInstances, setLoadingInstances] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedSources, setExpandedSources] = useState<KnowledgeSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);

  // Add source form
  const [showAddSource, setShowAddSource] = useState(false);
  const [srcType, setSrcType] = useState<SourceType>("url");
  const [srcName, setSrcName] = useState("");
  const [srcUrl, setSrcUrl] = useState("");
  const [srcRepo, setSrcRepo] = useState("");
  const [srcBranch, setSrcBranch] = useState("main");
  const [srcPaths, setSrcPaths] = useState("");
  const [srcChannelId, setSrcChannelId] = useState("");
  const [srcDaysBack, setSrcDaysBack] = useState("30");
  const [srcSlackToken, setSrcSlackToken] = useState("");
  const [addingSource, setAddingSource] = useState(false);
  const [indexEnvState, setIndexEnvRaw] = useState<"prod" | "dev">("prod");
  const setIndexEnv = (v: "prod" | "dev") => { setIndexEnvRaw(v); try { localStorage.setItem("tirsa_kb_indexEnv", v); } catch {} };
  const indexEnv = indexEnvState;
  // Load persisted preference
  React.useEffect(() => { try { const v = localStorage.getItem("tirsa_kb_indexEnv"); if (v === "dev" || v === "prod") setIndexEnvRaw(v); } catch {} }, []);

  // Limits (user-configurable defaults)
  const [showLimits, setShowLimits] = useState(false);
  const [limits, setLimits] = useState({
    maxSourceContentMB: 5,
    maxChunksPerSource: 5000,
    maxTokensPerSourceK: 500,
    maxChunksPerInstance: 20000,
    maxGithubFiles: 500,
    maxSlackMessages: 1000,
  });

  // Pre-analysis
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<{
    estimatedChars: number;
    estimatedChunks: number;
    estimatedTokens: number;
    estimatedCostUsd: number;
    warnings: string[];
    blocked: boolean;
  } | null>(null);

  // Source detail / edit
  const [detailSourceId, setDetailSourceId] = useState<string | null>(null);
  const [detailChunks, setDetailChunks] = useState<{ id: string; content: string; metadata: Record<string, unknown>; token_count: number; excluded?: boolean }[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editSourceId, setEditSourceId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editRepo, setEditRepo] = useState("");
  const [editBranch, setEditBranch] = useState("main");
  const [editPaths, setEditPaths] = useState("");
  const [editChannelId, setEditChannelId] = useState("");
  const [editDaysBack, setEditDaysBack] = useState("30");
  const [editSlackToken, setEditSlackToken] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Error / feedback
  const [error, setError] = useState<string | null>(null);

  // ── Fetchers ────────────────────────────────────────────────────────────────

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
    return h;
  }, [session]);

  const loadInstances = useCallback(async () => {
    if (!tenantId) return;
    setLoadingInstances(true);
    try {
      const res = await fetch(`/api/knowledge?tenantId=${tenantId}`, { headers: authHeaders() });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error("[knowledge] load failed:", res.status, errBody);
        throw new Error(`Failed to load instances (${res.status})`);
      }
      const data = await res.json();
      console.log("[knowledge] loaded:", data);
      setInstances(data.instances ?? data ?? []);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoadingInstances(false);
    }
  }, [tenantId, authHeaders]);

  const loadSources = useCallback(async (instanceId: string, silent = false) => {
    if (!tenantId) return;
    if (!silent) setLoadingSources(true);
    try {
      const res = await fetch(`/api/knowledge/${instanceId}?tenantId=${tenantId}`, { headers: authHeaders() });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error("[knowledge] load sources failed:", res.status, errBody);
        throw new Error(`Failed to load sources (${res.status})`);
      }
      const data = await res.json();
      const newSources = data.instance?.sources ?? data.sources ?? [];
      // Only update state if data actually changed — prevents flicker during polling
      setExpandedSources((prev) => {
        const prevJson = JSON.stringify(prev);
        const newJson = JSON.stringify(newSources);
        return prevJson === newJson ? prev : newSources;
      });
    } catch (e: unknown) {
      if (!silent) setError((e as Error).message);
    } finally {
      if (!silent) setLoadingSources(false);
    }
  }, [tenantId, authHeaders]);

  // Load once when tenantId is available (not on every session refresh)
  const loadedRef = React.useRef(false);
  useEffect(() => {
    if (!tenantId || !session || loadedRef.current) return;
    loadedRef.current = true;
    loadInstances();
  }, [tenantId, session, loadInstances]);

  // Poll sources when any is indexing
  useEffect(() => {
    const anyIndexing = expandedSources.some((s) => s.status === "indexing");
    if (!anyIndexing || !expandedId) return;
    const interval = setInterval(() => { loadSources(expandedId, true); }, 5000);
    return () => clearInterval(interval);
  }, [expandedSources, expandedId, loadSources]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!tenantId || !newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ tenantId, name: newName.trim(), description: newDesc.trim() || null }),
      });
      if (!res.ok) throw new Error("Failed to create instance");
      setNewName(""); setNewDesc(""); setShowCreate(false);
      await loadInstances();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this knowledge instance and all its sources?")) return;
    setError(null);
    try {
      const res = await fetch(`/api/knowledge/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to delete instance");
      if (expandedId === id) { setExpandedId(null); setExpandedSources([]); }
      await loadInstances();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedSources([]);
      setShowAddSource(false);
      setSearchResults([]);
      setSearchQuery("");
      return;
    }
    setExpandedId(id);
    setShowAddSource(false);
    setSearchResults([]);
    setSearchQuery("");
    await loadSources(id);
  };

  const buildSourceConfig = (): { config: Record<string, unknown>; displayName: string } => {
    const name = srcName.trim() || undefined;
    switch (srcType) {
      case "url":
        return { config: { url: srcUrl.trim(), name }, displayName: srcName.trim() || srcUrl.trim() };
      case "document":
        return { config: { name: name ?? "Document" }, displayName: srcName.trim() || "Document" };
      case "github":
        return { config: { repo: srcRepo.trim(), branch: srcBranch.trim(), paths: srcPaths.trim() || undefined, name }, displayName: srcName.trim() || srcRepo.trim() };
      case "slack":
        return { config: { channel_id: srcChannelId.trim(), days_back: parseInt(srcDaysBack) || 30, slack_token: srcSlackToken.trim() || undefined, name }, displayName: srcName.trim() || srcChannelId.trim() };
      default:
        return { config: {}, displayName: srcName.trim() };
    }
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setAnalysis(null);
    setError(null);
    try {
      const { config } = buildSourceConfig();
      const warnings: string[] = [];
      let estimatedChars = 0;
      let blocked = false;

      // Estimate based on source type
      if (srcType === "url") {
        const url = (config.url as string) ?? "";
        if (!url) { setAnalyzing(false); return; }
        // Fetch HEAD to estimate size
        try {
          const headRes = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
          const contentLength = parseInt(headRes.headers.get("content-length") ?? "0");
          const contentType = headRes.headers.get("content-type") ?? "";
          if (contentLength > 0) estimatedChars = contentLength;
          else estimatedChars = 100_000; // default estimate for dynamic pages
          if (contentLength > limits.maxSourceContentMB * 1_000_000) {
            warnings.push(`Content size (${(contentLength / 1_000_000).toFixed(1)}MB) exceeds limit (${limits.maxSourceContentMB}MB)`);
            blocked = true;
          }
          if (!contentType.includes("text") && !contentType.includes("html") && !contentType.includes("json") && !contentType.includes("markdown")) {
            warnings.push(`Content type "${contentType}" may not be indexable (best for text/html/markdown)`);
          }
        } catch {
          estimatedChars = 100_000;
          warnings.push("Could not fetch URL for analysis — will attempt during indexation");
        }
      } else if (srcType === "github") {
        const repo = (config.repo as string) ?? "";
        if (!repo) { setAnalyzing(false); return; }
        const paths = (config.paths as string) ?? "";
        if (!paths) {
          warnings.push("No path filter set — will index entire repository. Consider filtering to specific directories (e.g., 'docs/, README.md')");
          estimatedChars = 2_000_000;
        } else {
          estimatedChars = 500_000; // conservative estimate for filtered paths
        }
        if (estimatedChars > limits.maxSourceContentMB * 1_000_000) {
          warnings.push(`Estimated content may exceed ${limits.maxSourceContentMB}MB limit`);
        }
      } else if (srcType === "slack") {
        const daysBack = parseInt(srcDaysBack) || 30;
        const estMessages = Math.min(daysBack * 50, limits.maxSlackMessages); // ~50 messages/day estimate
        estimatedChars = estMessages * 200; // ~200 chars per message
        if (daysBack > 90) {
          warnings.push(`Fetching ${daysBack} days of Slack history — consider reducing for faster indexation`);
        }
      }

      const estimatedTokens = Math.ceil(estimatedChars / 4);
      const estimatedChunks = Math.ceil(estimatedTokens / 500);
      const estimatedCostUsd = estimatedTokens * 0.00002 / 1000;

      if (estimatedChunks > limits.maxChunksPerSource) {
        warnings.push(`Estimated ${estimatedChunks.toLocaleString()} chunks exceeds limit (${limits.maxChunksPerSource.toLocaleString()})`);
        blocked = true;
      }
      if (estimatedTokens > limits.maxTokensPerSourceK * 1000) {
        warnings.push(`Estimated ${(estimatedTokens / 1000).toFixed(0)}K tokens exceeds limit (${limits.maxTokensPerSourceK}K)`);
        blocked = true;
      }

      if (warnings.length === 0) {
        warnings.push("Source looks good — within all configured limits");
      }

      setAnalysis({ estimatedChars, estimatedChunks, estimatedTokens, estimatedCostUsd, warnings, blocked });
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleViewChunks = async (sourceId: string) => {
    if (detailSourceId === sourceId) { setDetailSourceId(null); return; }
    setDetailSourceId(sourceId);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/knowledge/${expandedId}/sources/${sourceId}/chunks`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        console.log("[knowledge] chunks loaded:", data);
        setDetailChunks(data.chunks ?? []);
      } else {
        console.error("[knowledge] chunks failed:", res.status);
      }
    } catch { /* ignore */ }
    finally { setDetailLoading(false); }
  };

  const handleEditSource = async (sourceId: string, sourceType: string) => {
    if (!expandedId || !editName.trim()) return;
    setEditSaving(true);
    try {
      let config: Record<string, unknown> = {};
      switch (sourceType) {
        case "url": config = { url: editUrl.trim() }; break;
        case "github": config = { repo: editRepo.trim(), branch: editBranch.trim(), paths: editPaths.trim() || undefined }; break;
        case "slack": config = { channel_id: editChannelId.trim(), days_back: parseInt(editDaysBack) || 30, slack_token: editSlackToken.trim() || undefined }; break;
      }
      const res = await fetch(`/api/knowledge/${expandedId}/sources/${sourceId}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ name: editName.trim(), config }),
      });
      if (res.ok) {
        setEditSourceId(null);
        await loadSources(expandedId);
      }
    } catch { setError("Failed to save source"); }
    finally { setEditSaving(false); }
  };

  const handleAddSource = async () => {
    if (!expandedId || !tenantId) return;
    setAddingSource(true);
    setError(null);
    try {
      const { config, displayName } = buildSourceConfig();
      const res = await fetch(`/api/knowledge/${expandedId}/sources`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ tenantId, type: srcType, name: displayName, config, autoIndex: true, indexEnv, limits }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(errBody.error ?? `Failed to add source (${res.status})`);
      }
      const result = await res.json() as { source: unknown; indexStatus?: string; indexError?: string; triggerRunUrl?: string };
      if (result.indexStatus === "dispatch_failed" || result.indexStatus === "no_trigger_key") {
        setError(`Source added but indexing failed: ${result.indexError ?? "Unknown error"}`);
      } else if (result.indexStatus === "dispatched") {
        console.log("[knowledge] Index dispatched", result.triggerRunUrl);
      }
      setSrcName(""); setSrcUrl(""); setSrcRepo(""); setSrcBranch("main");
      setSrcPaths(""); setSrcChannelId(""); setSrcDaysBack("30"); setSrcSlackToken("");
      setShowAddSource(false);
      await loadSources(expandedId);
      await loadInstances();
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setAddingSource(false);
    }
  };

  const handleRemoveSource = async (sourceId: string) => {
    if (!expandedId) return;
    setError(null);
    try {
      const res = await fetch(`/api/knowledge/${expandedId}/sources/${sourceId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to remove source");
      await loadSources(expandedId);
      await loadInstances();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleReindex = async (sourceId: string) => {
    if (!expandedId) return;
    setError(null);
    try {
      const res = await fetch(`/api/knowledge/${expandedId}/sources/${sourceId}/reindex`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ indexEnv }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(errBody.error ?? `Re-index failed (${res.status})`);
      }
      await loadSources(expandedId);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleToggleSource = async (sourceId: string, currentStatus: string) => {
    if (!expandedId) return;
    setError(null);
    try {
      // Toggle between paused (disabled) and indexed/pending (enabled)
      const newStatus = currentStatus === "paused" ? "indexed" : "paused";
      await fetch(`/api/knowledge/${expandedId}/sources/${sourceId}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ status: newStatus }),
      });
      await loadSources(expandedId);
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  };

  const handleSearch = async () => {
    if (!expandedId || !searchQuery.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/knowledge/${expandedId}/search`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ tenantId, query: searchQuery.trim(), top_k: 5 }),
      });
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      setSearchResults(data.results ?? []);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (authLoading || !session) return null;

  return (
    <IntegrationsShell
      active="knowledge"
      title="Knowledge Base"
      description="Reusable knowledge packs for AI agents. Create instances, add sources, and link to projects."
      maxWidth={680}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

            {/* ── Limits settings (collapsible) ────────────────── */}
            <button type="button" onClick={() => setShowLimits((o) => !o)}
              style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", fontSize: 11, padding: "4px 0", marginBottom: 12, fontFamily: "var(--font-sans)" }}>
              <Settings size={11} />
              <span>Indexation Limits</span>
              <ChevronDown size={10} style={{ transform: showLimits ? "none" : "rotate(-90deg)", transition: "0.15s" }} />
            </button>
            {showLimits && (
              <div style={{ background: "var(--mantle)", border: "1px solid var(--surface1)", borderRadius: 8, padding: "12px 14px", marginBottom: 16, fontSize: 11 }}>
                <p style={{ color: "var(--overlay1)", marginBottom: 10, lineHeight: 1.6 }}>
                  These limits protect your Supabase and OpenAI usage. Adjust based on your plan limits. Embedding cost is ~$0.02 per 1M tokens.
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {([
                    { key: "maxSourceContentMB", label: "Max source content (MB)", step: 1 },
                    { key: "maxChunksPerSource", label: "Max chunks per source", step: 500 },
                    { key: "maxTokensPerSourceK", label: "Max tokens per source (K)", step: 100 },
                    { key: "maxChunksPerInstance", label: "Max chunks per instance", step: 5000 },
                    { key: "maxGithubFiles", label: "Max GitHub files", step: 100 },
                    { key: "maxSlackMessages", label: "Max Slack messages", step: 500 },
                  ] as const).map(({ key, label, step }) => (
                    <div key={key}>
                      <label style={{ display: "block", fontSize: 10, color: "var(--subtext0)", marginBottom: 3 }}>{label}</label>
                      <input type="number" value={limits[key]} step={step} min={0}
                        onChange={(e) => setLimits((p) => ({ ...p, [key]: parseInt(e.target.value) || 0 }))}
                        style={{ width: "100%", padding: "4px 8px", borderRadius: 5, border: "1px solid var(--surface1)", background: "var(--surface0)", color: "var(--text)", fontSize: 11, outline: "none", boxSizing: "border-box" }} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Error banner ───────────────────────────────────── */}
            {error && (
              <div style={{
                display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
                background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.2)",
                borderRadius: 8, marginBottom: 16, fontSize: 13, color: "var(--red)",
              }}>
                <AlertCircle size={14} />
                <span style={{ flex: 1 }}>{error}</span>
                <button onClick={() => setError(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)", padding: 0 }}>
                  <X size={14} />
                </button>
              </div>
            )}

            {/* ── Create button / form ───────────────────────────── */}
            <div style={{ marginBottom: 24 }}>
              {!showCreate ? (
                <button
                  onClick={() => setShowCreate(true)}
                  style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "10px 18px", borderRadius: 8,
                    background: "var(--blue)", color: "#fff", border: "none",
                    cursor: "pointer", fontSize: 13, fontWeight: 600,
                  }}
                >
                  <Plus size={14} /> New Instance
                </button>
              ) : (
                <div style={{
                  background: "var(--mantle)", border: "1px solid var(--surface1)",
                  borderRadius: 12, padding: 20,
                }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>New Knowledge Instance</span>
                    <button onClick={() => setShowCreate(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay1)", padding: 0 }}>
                      <X size={16} />
                    </button>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 12, color: "var(--subtext0)", display: "block", marginBottom: 4 }}>Name</label>
                    <input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="e.g. Product Documentation"
                      style={{
                        width: "100%", padding: "8px 12px", borderRadius: 6,
                        background: "var(--surface0)", border: "1px solid var(--surface1)",
                        color: "var(--text)", fontSize: 13, outline: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontSize: 12, color: "var(--subtext0)", display: "block", marginBottom: 4 }}>Description (optional)</label>
                    <textarea
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      placeholder="What this knowledge pack contains..."
                      rows={2}
                      style={{
                        width: "100%", padding: "8px 12px", borderRadius: 6,
                        background: "var(--surface0)", border: "1px solid var(--surface1)",
                        color: "var(--text)", fontSize: 13, outline: "none",
                        resize: "vertical", fontFamily: "inherit",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <button
                    onClick={handleCreate}
                    disabled={creating || !newName.trim()}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "8px 16px", borderRadius: 6,
                      background: !newName.trim() ? "var(--surface1)" : "var(--blue)",
                      color: "#fff", border: "none", cursor: !newName.trim() ? "default" : "pointer",
                      fontSize: 13, fontWeight: 600, opacity: creating ? 0.7 : 1,
                    }}
                  >
                    {creating && <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />}
                    Create
                  </button>
                </div>
              )}
            </div>

            {/* ── Instance list ───────────────────────────────────── */}
            {loadingInstances ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--overlay1)", fontSize: 13, padding: "20px 0" }}>
                <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Loading instances...
              </div>
            ) : instances.length === 0 ? (
              <div style={{
                textAlign: "center", padding: "48px 20px",
                color: "var(--overlay1)", fontSize: 14,
              }}>
                No knowledge instances yet. Create one to get started.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {instances.map((inst) => {
                  const isExpanded = expandedId === inst.id;
                  return (
                    <div key={inst.id} style={{
                      background: "var(--mantle)", border: "1px solid var(--surface1)",
                      borderRadius: 12, overflow: "hidden",
                    }}>
                      {/* Instance header */}
                      <div
                        style={{
                          display: "flex", alignItems: "center", gap: 12,
                          padding: "14px 16px", cursor: "pointer",
                        }}
                        onClick={() => handleExpand(inst.id)}
                      >
                        {isExpanded
                          ? <ChevronDown size={14} style={{ color: "var(--overlay1)", flexShrink: 0 }} />
                          : <ChevronRight size={14} style={{ color: "var(--overlay1)", flexShrink: 0 }} />
                        }
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                            {inst.name}
                          </div>
                          {inst.description && (
                            <div style={{ fontSize: 12, color: "var(--subtext0)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {inst.description}
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                          <span style={{ fontSize: 11, color: "var(--overlay1)" }}>
                            {inst.source_count} source{inst.source_count !== 1 ? "s" : ""}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--overlay1)" }}>
                            {inst.chunk_count} chunk{inst.chunk_count !== 1 ? "s" : ""}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(inst.id); }}
                            title="Delete instance"
                            style={{
                              background: "none", border: "none", cursor: "pointer",
                              color: "var(--overlay0)", padding: 4,
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {/* Expanded panel */}
                      {isExpanded && (
                        <div style={{
                          borderTop: "1px solid var(--surface0)", padding: "16px",
                        }}>
                          {/* Sources list */}
                          {loadingSources ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--overlay1)", fontSize: 13, padding: "8px 0" }}>
                              <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Loading sources...
                            </div>
                          ) : expandedSources.length === 0 ? (
                            <div style={{ fontSize: 13, color: "var(--overlay1)", padding: "8px 0", marginBottom: 12 }}>
                              No sources yet. Add a URL, document, or repository.
                            </div>
                          ) : (
                            <div style={{ marginBottom: 16 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                                Sources
                              </div>
                              {expandedSources.map((src) => {
                                const srcCfg = (src.config ?? {}) as Record<string, unknown>;
                                const configUrl = srcCfg.url as string | undefined;
                                const configRepo = srcCfg.repo as string | undefined;
                                const configChannel = srcCfg.channel_id as string | undefined;
                                const detail = configUrl ?? configRepo ?? configChannel ?? "";
                                const isIndexing = src.status === "indexing";
                                const isError = src.status === "error";
                                // Detect stale indexing (stuck > 10 minutes)
                                const updatedAt = src.last_indexed_at ? new Date(src.last_indexed_at).getTime() : 0;
                                const createdAt = src.created_at ? new Date(src.created_at).getTime() : 0;
                                const lastActivity = Math.max(updatedAt, createdAt);
                                const isStale = isIndexing && lastActivity > 0 && (Date.now() - lastActivity > 10 * 60 * 1000);

                                return (
                                  <div key={src.id} style={{
                                    borderRadius: 8, overflow: "hidden",
                                    background: "var(--surface0)", marginBottom: 6,
                                    border: src.status === "error" ? "1px solid rgba(228,75,95,0.3)" : "1px solid var(--surface1)",
                                  }}>
                                    {/* Header row */}
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
                                      {sourceTypeIcon(src.type)}
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {src.name}
                                          </span>
                                          {statusBadge(src.status)}
                                          {isIndexing && !isStale && <Loader2 size={11} style={{ color: "var(--blue)", animation: "spin 1s linear infinite" }} />}
                                          {isStale && <span style={{ fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 99, background: "rgba(245,159,0,0.12)", color: "var(--peach)" }}>Stale</span>}
                                        </div>
                                        {detail && (
                                          <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono, monospace)" }}>
                                            {detail}
                                          </div>
                                        )}
                                      </div>

                                      {/* Action buttons */}
                                      <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
                                        {src.status === "indexed" && (
                                          <button onClick={() => handleViewChunks(src.id)}
                                            title={detailSourceId === src.id ? "Hide chunks" : `View ${src.chunk_count} chunks`}
                                            style={{ background: "none", border: "none", cursor: "pointer", color: detailSourceId === src.id ? "var(--blue)" : "var(--overlay1)", padding: 4, display: "flex" }}>
                                            <Layers size={13} />
                                          </button>
                                        )}
                                        <button onClick={() => {
                                          if (editSourceId === src.id) { setEditSourceId(null); return; }
                                          setEditSourceId(src.id); setDetailSourceId(null);
                                          setEditName(src.name);
                                          const ec = (src.config ?? {}) as Record<string, unknown>;
                                          setEditUrl(String(ec.url ?? ""));
                                          setEditRepo(String(ec.repo ?? ""));
                                          setEditBranch(String(ec.branch ?? "main"));
                                          setEditPaths(String(ec.paths ?? ""));
                                          setEditChannelId(String(ec.channel_id ?? ""));
                                          setEditSlackToken(String(ec.slack_token ?? ""));
                                          setEditDaysBack(String(ec.days_back ?? "30"));
                                          setIndexEnv(indexEnv);
                                        }}
                                          title="Source settings"
                                          style={{ background: "none", border: "none", cursor: "pointer", color: editSourceId === src.id ? "var(--blue)" : "var(--overlay1)", padding: 4, display: "flex" }}>
                                          <Settings size={13} />
                                        </button>
                                        {src.status !== "paused" && (src.status !== "indexing" || isStale) && (
                                          <button onClick={() => handleReindex(src.id)} title={`Re-index (${indexEnv === "dev" ? "Local" : "Cloud"})`}
                                            style={{ background: "none", border: "none", cursor: "pointer", color: indexEnv === "dev" ? "var(--green)" : "var(--blue)", padding: 4, display: "flex" }}>
                                            <RefreshCw size={13} />
                                          </button>
                                        )}
                                        {isIndexing && (
                                          <button onClick={async () => {
                                            if (!expandedId) return;
                                            await fetch(`/api/knowledge/${expandedId}/sources/${src.id}`, {
                                              method: "PATCH", headers: authHeaders(),
                                              body: JSON.stringify({ status: src.chunk_count > 0 ? "indexed" : "pending", clearError: true }),
                                            });
                                            await loadSources(expandedId);
                                          }}
                                            title="Cancel indexation (reset status)"
                                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--red)", padding: 4, display: "flex" }}>
                                            <X size={13} />
                                          </button>
                                        )}
                                        <button onClick={() => handleToggleSource(src.id, src.status)}
                                          title={src.status === "paused" ? "Enable source (include in searches)" : "Disable source (exclude from searches)"}
                                          style={{ background: "none", border: "none", cursor: "pointer", color: src.status === "paused" ? "var(--overlay0)" : "var(--green)", padding: 4, display: "flex" }}>
                                          {src.status === "paused" ? <ToggleLeft size={13} /> : <ToggleRight size={13} />}
                                        </button>
                                        {(isIndexing || isError || isStale) && (() => {
                                          // Extract run URL from error_message if present: [run:https://...]
                                          const runMatch = src.error_message?.match(/\[run:(https:\/\/[^\]]+)\]/);
                                          const runUrl = runMatch?.[1] ?? "https://cloud.trigger.dev";
                                          return (
                                            <a href={runUrl} target="_blank" rel="noreferrer"
                                              title={isStale ? "Indexation may be stuck — view run" : isError ? "View failed run" : "View indexation run"}
                                              style={{ display: "flex", padding: 4, color: isStale ? "var(--peach)" : isError ? "var(--red)" : "var(--blue)" }}>
                                              <ExternalLink size={13} />
                                            </a>
                                          );
                                        })()}
                                        {src.chunk_count > 0 && (
                                          <button onClick={async () => {
                                            if (!expandedId || !confirm(`Clear all ${src.chunk_count} chunks from "${src.name}"? The source config is kept.`)) return;
                                            try {
                                              await fetch(`/api/knowledge/${expandedId}/sources/${src.id}/chunks`, {
                                                method: "DELETE",
                                                headers: authHeaders(),
                                              });
                                              await loadSources(expandedId);
                                              if (detailSourceId === src.id) setDetailChunks([]);
                                            } catch { setError("Failed to clear chunks"); }
                                          }}
                                            title="Clear all chunks (keep source config)"
                                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--peach)", padding: 4, display: "flex" }}>
                                            <Eraser size={13} />
                                          </button>
                                        )}
                                        <button onClick={() => handleRemoveSource(src.id)} title="Remove source and all chunks"
                                          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4, display: "flex" }}>
                                          <Trash2 size={13} />
                                        </button>
                                      </div>
                                    </div>

                                    {/* Stats row */}
                                    <div style={{
                                      display: "flex", alignItems: "center", gap: 12, padding: "4px 10px 8px",
                                      fontSize: 10, color: "var(--overlay1)",
                                    }}>
                                      <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                        <FileText size={9} /> {src.chunk_count} chunks
                                      </span>
                                      {src.token_count ? (
                                        <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                          <Zap size={9} /> {(src.token_count / 1000).toFixed(1)}K tokens
                                        </span>
                                      ) : null}
                                      {src.last_indexed_at && (
                                        <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                          <Clock size={9} /> {new Date(src.last_indexed_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                        </span>
                                      )}
                                      {src.type === "url" && configUrl && (
                                        <a href={configUrl} target="_blank" rel="noreferrer"
                                          style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--blue)", textDecoration: "none" }}>
                                          <ExternalLink size={9} /> Open
                                        </a>
                                      )}
                                      {src.type === "github" && configRepo && (
                                        <a href={`https://github.com/${configRepo}`} target="_blank" rel="noreferrer"
                                          style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--blue)", textDecoration: "none" }}>
                                          <ExternalLink size={9} /> Repo
                                        </a>
                                      )}
                                    </div>

                                    {/* Stale warning */}
                                    {isStale && !src.error_message && (
                                      <div style={{
                                        padding: "6px 10px", fontSize: 11, color: "var(--peach)",
                                        background: "rgba(245,159,0,0.06)", borderTop: "1px solid rgba(245,159,0,0.15)",
                                        lineHeight: 1.5, display: "flex", alignItems: "center", gap: 6,
                                      }}>
                                        <AlertCircle size={10} style={{ flexShrink: 0 }} />
                                        Indexation appears stuck (no progress for 10+ min). Check Trigger.dev or try re-indexing.
                                      </div>
                                    )}

                                    {/* Progress / Error message */}
                                    {src.error_message && (
                                      <div style={{
                                        padding: "6px 10px", fontSize: 11,
                                        color: (src.error_message.startsWith("[progress]") || src.error_message.startsWith("[run:")) ? "var(--blue)" : "var(--red)",
                                        background: (src.error_message.startsWith("[progress]") || src.error_message.startsWith("[run:")) ? "rgba(20,99,255,0.06)" : "rgba(228,75,95,0.06)",
                                        borderTop: `1px solid ${(src.error_message.startsWith("[progress]") || src.error_message.startsWith("[run:")) ? "rgba(20,99,255,0.15)" : "rgba(228,75,95,0.15)"}`,
                                        lineHeight: 1.5,
                                        display: "flex", alignItems: "center", gap: 6,
                                      }}>
                                        {(src.error_message.startsWith("[progress]") || src.error_message.startsWith("[run:")) && <Loader2 size={10} style={{ animation: "spin 1s linear infinite", flexShrink: 0 }} />}
                                        {src.error_message.replace(/\[progress\] ?/, "").replace(/\[run:[^\]]*\] ?/, "")}
                                      </div>
                                    )}
                                    {/* Source settings panel — full editable form */}
                                    {editSourceId === src.id && (
                                      <div style={{ padding: "10px 12px", borderTop: "1px solid var(--surface1)", fontSize: 11 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                          <span style={{ color: "var(--subtext0)", width: 70, flexShrink: 0 }}>Type</span>
                                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                            {sourceTypeIcon(src.type)}
                                            <span style={{ color: "var(--text)", fontWeight: 600 }}>{src.type === "github" ? "GitHub" : src.type.charAt(0).toUpperCase() + src.type.slice(1)}</span>
                                          </div>
                                        </div>
                                        <div style={{ marginBottom: 8 }}>
                                          <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Name</label>
                                          <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Source name"
                                            style={{ width: "100%", padding: "5px 8px", borderRadius: 5, border: "1px solid var(--surface1)", background: "var(--mantle)", color: "var(--text)", fontSize: 11, outline: "none", boxSizing: "border-box" as const }} />
                                        </div>
                                        {src.type === "url" && (
                                          <div style={{ marginBottom: 8 }}>
                                            <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>URL</label>
                                            <input value={editUrl} onChange={(e) => setEditUrl(e.target.value)} placeholder="https://docs.example.com"
                                              style={{ width: "100%", padding: "5px 8px", borderRadius: 5, border: "1px solid var(--surface1)", background: "var(--mantle)", color: "var(--text)", fontSize: 11, outline: "none", boxSizing: "border-box" as const }} />
                                          </div>
                                        )}
                                        {src.type === "github" && (<>
                                          <div style={{ marginBottom: 8 }}>
                                            <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Repository (owner/repo)</label>
                                            <input value={editRepo} onChange={(e) => setEditRepo(e.target.value)} placeholder="owner/repo"
                                              style={{ width: "100%", padding: "5px 8px", borderRadius: 5, border: "1px solid var(--surface1)", background: "var(--mantle)", color: "var(--text)", fontSize: 11, outline: "none", boxSizing: "border-box" as const }} />
                                          </div>
                                          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                                            <div style={{ flex: 1 }}>
                                              <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Branch</label>
                                              <input value={editBranch} onChange={(e) => setEditBranch(e.target.value)} placeholder="main"
                                                style={{ width: "100%", padding: "5px 8px", borderRadius: 5, border: "1px solid var(--surface1)", background: "var(--mantle)", color: "var(--text)", fontSize: 11, outline: "none", boxSizing: "border-box" as const }} />
                                            </div>
                                            <div style={{ flex: 2 }}>
                                              <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Paths (comma-separated)</label>
                                              <input value={editPaths} onChange={(e) => setEditPaths(e.target.value)} placeholder="docs/, README.md"
                                                style={{ width: "100%", padding: "5px 8px", borderRadius: 5, border: "1px solid var(--surface1)", background: "var(--mantle)", color: "var(--text)", fontSize: 11, outline: "none", boxSizing: "border-box" as const }} />
                                            </div>
                                          </div>
                                        </>)}
                                        {src.type === "slack" && (<>
                                          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                                            <div style={{ flex: 2 }}>
                                              <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Channel ID</label>
                                              <input value={editChannelId} onChange={(e) => setEditChannelId(e.target.value)} placeholder="C123456"
                                                style={{ width: "100%", padding: "5px 8px", borderRadius: 5, border: "1px solid var(--surface1)", background: "var(--mantle)", color: "var(--text)", fontSize: 11, outline: "none", boxSizing: "border-box" as const }} />
                                            </div>
                                            <div style={{ flex: 1 }}>
                                              <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Days back</label>
                                              <input type="number" value={editDaysBack} onChange={(e) => setEditDaysBack(e.target.value)} placeholder="30"
                                                style={{ width: "100%", padding: "5px 8px", borderRadius: 5, border: "1px solid var(--surface1)", background: "var(--mantle)", color: "var(--text)", fontSize: 11, outline: "none", boxSizing: "border-box" as const }} />
                                            </div>
                                          </div>
                                          <div style={{ marginBottom: 8 }}>
                                            <label style={{ fontSize: 10, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Bot Token</label>
                                            <input type="password" value={editSlackToken} onChange={(e) => setEditSlackToken(e.target.value)} placeholder="xoxb-..."
                                              autoComplete="off"
                                              style={{ width: "100%", padding: "5px 8px", borderRadius: 5, border: "1px solid var(--surface1)", background: "var(--mantle)", color: "var(--text)", fontSize: 11, outline: "none", boxSizing: "border-box" as const, fontFamily: "var(--font-mono, monospace)" }} />
                                          </div>
                                        </>)}
                                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                          <span style={{ fontSize: 10, color: "var(--subtext0)" }}>Index on:</span>
                                          <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--surface1)" }}>
                                            {(["prod", "dev"] as const).map((env) => (
                                              <button key={env} type="button" onClick={() => setIndexEnv(env)}
                                                style={{ padding: "3px 10px", fontSize: 10, fontWeight: indexEnv === env ? 700 : 400,
                                                  background: indexEnv === env ? (env === "prod" ? "rgba(20,99,255,0.15)" : "rgba(166,227,161,0.15)") : "transparent",
                                                  color: indexEnv === env ? (env === "prod" ? "var(--blue)" : "var(--green)") : "var(--overlay0)",
                                                  border: "none", cursor: "pointer", borderLeft: env === "dev" ? "1px solid var(--surface1)" : "none" }}>
                                                {env === "prod" ? "Cloud" : "Local"}
                                              </button>
                                            ))}
                                          </div>
                                        </div>
                                        <div style={{ display: "flex", gap: 16, marginBottom: 10, color: "var(--overlay0)", fontSize: 10 }}>
                                          <span>Status: {src.status}</span>
                                          <span>Chunks: {src.chunk_count}</span>
                                          {src.token_count ? <span>Tokens: {(src.token_count / 1000).toFixed(1)}K</span> : null}
                                          {src.last_indexed_at && <span>Indexed: {new Date(src.last_indexed_at).toLocaleString()}</span>}
                                        </div>
                                        {src.chunk_count > 0 && (
                                          <div style={{ padding: "6px 8px", borderRadius: 5, background: "rgba(245,159,0,0.06)", border: "1px solid rgba(245,159,0,0.15)", color: "var(--peach)", fontSize: 10, marginBottom: 10, lineHeight: 1.5 }}>
                                            Changing source config requires re-indexing. Clear chunks first for a clean re-index.
                                          </div>
                                        )}
                                        <div style={{ display: "flex", gap: 6 }}>
                                          <button onClick={() => handleEditSource(src.id, src.type)} disabled={editSaving}
                                            style={{ padding: "5px 14px", borderRadius: 5, border: "none", background: "var(--blue)", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", opacity: editSaving ? 0.7 : 1 }}>
                                            {editSaving ? "Saving..." : "Save"}
                                          </button>
                                          <button onClick={() => setEditSourceId(null)}
                                            style={{ padding: "5px 10px", borderRadius: 5, border: "1px solid var(--surface1)", background: "none", color: "var(--overlay0)", fontSize: 11, cursor: "pointer" }}>Cancel</button>
                                        </div>
                                      </div>
                                    )}

                                    {/* Chunks detail panel */}
                                    {detailSourceId === src.id && (
                                      <div style={{ borderTop: "1px solid var(--surface1)" }}>
                                        {detailLoading ? (
                                          <div style={{ padding: 12, display: "flex", alignItems: "center", gap: 6, color: "var(--overlay0)", fontSize: 11 }}>
                                            <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> Loading chunks…
                                          </div>
                                        ) : detailChunks.length === 0 ? (
                                          <div style={{ padding: 12, fontSize: 11, color: "var(--overlay0)" }}>No chunks indexed.</div>
                                        ) : (
                                          <>
                                            {/* Header */}
                                            <div style={{ padding: "8px 10px", background: "var(--crust)", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, color: "var(--overlay0)" }}>
                                              <span>{detailChunks.length} chunks · {detailChunks.reduce((s, c) => s + (c.token_count ?? 0), 0).toLocaleString()} tokens</span>
                                              <span>~${(detailChunks.reduce((s, c) => s + (c.token_count ?? 0), 0) * 0.00002 / 1000).toFixed(4)} embedding cost</span>
                                            </div>
                                            {/* Chunk list */}
                                            <div style={{ maxHeight: 350, overflowY: "auto" }}>
                                              {detailChunks.map((chunk, idx) => {
                                                const meta = (chunk.metadata ?? {}) as Record<string, unknown>;
                                                const path = meta.path ? String(meta.path) : null;
                                                const section = meta.section ? String(meta.section) : null;
                                                const source_name = meta.source ? String(meta.source) : null;
                                                return (
                                                  <details key={chunk.id} style={{
                                                    borderBottom: "1px solid var(--surface0)",
                                                    opacity: chunk.excluded ? 0.4 : 1,
                                                  }}>
                                                    <summary style={{
                                                      display: "flex", gap: 8, padding: "6px 10px", fontSize: 11,
                                                      cursor: "pointer", userSelect: "none", alignItems: "center",
                                                      listStyle: "none",
                                                    }}>
                                                      <ChevronRight size={10} style={{ color: "var(--overlay0)", flexShrink: 0 }} />
                                                      <span style={{ width: 24, color: "var(--overlay0)", flexShrink: 0, textAlign: "right", fontSize: 10 }}>{idx + 1}</span>
                                                      <span style={{ flex: 1, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                        {chunk.content.slice(0, 100).replace(/\n/g, " ")}{chunk.content.length > 100 ? "…" : ""}
                                                      </span>
                                                      <span style={{ flexShrink: 0, fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono, monospace)" }}>{chunk.token_count} tok</span>
                                                      {chunk.excluded && <span style={{ fontSize: 9, padding: "0 4px", borderRadius: 3, background: "rgba(228,75,95,0.12)", color: "var(--red)" }}>excluded</span>}
                                                    </summary>
                                                    <div style={{ padding: "8px 10px 12px 44px" }}>
                                                      {/* Metadata */}
                                                      {(path || section || source_name) && (
                                                        <div style={{ display: "flex", gap: 10, marginBottom: 6, fontSize: 10, color: "var(--overlay0)" }}>
                                                          {path && <span>📁 {path}</span>}
                                                          {section && <span>§ {section}</span>}
                                                          {source_name && <span>🔗 {source_name}</span>}
                                                        </div>
                                                      )}
                                                      {/* Full content */}
                                                      <pre style={{
                                                        fontSize: 11, color: "var(--subtext0)", lineHeight: 1.6,
                                                        whiteSpace: "pre-wrap", wordBreak: "break-word",
                                                        background: "var(--crust)", padding: "8px 10px", borderRadius: 6,
                                                        border: "1px solid var(--surface0)", maxHeight: 200, overflowY: "auto",
                                                        margin: 0,
                                                      }}>
                                                        {chunk.content}
                                                      </pre>
                                                    </div>
                                                  </details>
                                                );
                                              })}
                                            </div>
                                          </>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Add source */}
                          {!showAddSource ? (
                            <button
                              onClick={() => setShowAddSource(true)}
                              style={{
                                display: "flex", alignItems: "center", gap: 6,
                                padding: "7px 14px", borderRadius: 6,
                                background: "var(--surface0)", border: "1px solid var(--surface1)",
                                color: "var(--text)", cursor: "pointer",
                                fontSize: 12, fontWeight: 500,
                              }}
                            >
                              <Plus size={12} /> Add Source
                            </button>
                          ) : (
                            <div style={{
                              background: "var(--surface0)", borderRadius: 8,
                              padding: 16, marginBottom: 16,
                            }}>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Add Source</span>
                                <button onClick={() => setShowAddSource(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay1)", padding: 0 }}>
                                  <X size={14} />
                                </button>
                              </div>

                              {/* Type selector */}
                              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                                {(["url", "document", "github", "slack"] as const).map((t) => (
                                  <button
                                    key={t}
                                    onClick={() => setSrcType(t)}
                                    style={{
                                      display: "flex", alignItems: "center", gap: 5,
                                      padding: "5px 10px", borderRadius: 6,
                                      background: srcType === t ? "var(--blue)" : "var(--mantle)",
                                      color: srcType === t ? "#fff" : "var(--subtext0)",
                                      border: "1px solid " + (srcType === t ? "var(--blue)" : "var(--surface1)"),
                                      cursor: "pointer", fontSize: 11, fontWeight: 600,
                                      textTransform: "capitalize",
                                    }}
                                  >
                                    {sourceTypeIcon(t)}
                                    {t === "github" ? "GitHub" : t.charAt(0).toUpperCase() + t.slice(1)}
                                  </button>
                                ))}
                              </div>

                              {/* Name input (all types) */}
                              <div style={{ marginBottom: 8 }}>
                                <label style={{ fontSize: 11, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Name</label>
                                <input
                                  value={srcName}
                                  onChange={(e) => setSrcName(e.target.value)}
                                  placeholder="Source name"
                                  style={{
                                    width: "100%", padding: "6px 10px", borderRadius: 5,
                                    background: "var(--mantle)", border: "1px solid var(--surface1)",
                                    color: "var(--text)", fontSize: 12, outline: "none",
                                    boxSizing: "border-box",
                                  }}
                                />
                              </div>

                              {/* Type-specific fields */}
                              {srcType === "url" && (
                                <div style={{ marginBottom: 8 }}>
                                  <label style={{ fontSize: 11, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>URL</label>
                                  <input
                                    value={srcUrl}
                                    onChange={(e) => setSrcUrl(e.target.value)}
                                    placeholder="https://docs.example.com/guide"
                                    style={{
                                      width: "100%", padding: "6px 10px", borderRadius: 5,
                                      background: "var(--mantle)", border: "1px solid var(--surface1)",
                                      color: "var(--text)", fontSize: 12, outline: "none",
                                      boxSizing: "border-box",
                                    }}
                                  />
                                </div>
                              )}

                              {srcType === "document" && (
                                <div style={{ marginBottom: 8, padding: "10px 12px", borderRadius: 6, background: "var(--mantle)", border: "1px dashed var(--surface1)", fontSize: 12, color: "var(--overlay1)" }}>
                                  Document upload coming soon. For now, use URL sources.
                                </div>
                              )}

                              {srcType === "github" && (
                                <>
                                  <div style={{ marginBottom: 8 }}>
                                    <label style={{ fontSize: 11, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Repository (owner/repo)</label>
                                    <input
                                      value={srcRepo}
                                      onChange={(e) => setSrcRepo(e.target.value)}
                                      placeholder="acme/docs"
                                      style={{
                                        width: "100%", padding: "6px 10px", borderRadius: 5,
                                        background: "var(--mantle)", border: "1px solid var(--surface1)",
                                        color: "var(--text)", fontSize: 12, outline: "none",
                                        boxSizing: "border-box",
                                      }}
                                    />
                                  </div>
                                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                                    <div style={{ flex: 1 }}>
                                      <label style={{ fontSize: 11, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Branch</label>
                                      <input
                                        value={srcBranch}
                                        onChange={(e) => setSrcBranch(e.target.value)}
                                        placeholder="main"
                                        style={{
                                          width: "100%", padding: "6px 10px", borderRadius: 5,
                                          background: "var(--mantle)", border: "1px solid var(--surface1)",
                                          color: "var(--text)", fontSize: 12, outline: "none",
                                          boxSizing: "border-box",
                                        }}
                                      />
                                    </div>
                                    <div style={{ flex: 2 }}>
                                      <label style={{ fontSize: 11, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Paths (comma-separated, optional)</label>
                                      <input
                                        value={srcPaths}
                                        onChange={(e) => setSrcPaths(e.target.value)}
                                        placeholder="docs/, README.md"
                                        style={{
                                          width: "100%", padding: "6px 10px", borderRadius: 5,
                                          background: "var(--mantle)", border: "1px solid var(--surface1)",
                                          color: "var(--text)", fontSize: 12, outline: "none",
                                          boxSizing: "border-box",
                                        }}
                                      />
                                    </div>
                                  </div>
                                </>
                              )}

                              {srcType === "slack" && (<>
                                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                                  <div style={{ flex: 2 }}>
                                    <label style={{ fontSize: 11, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Channel ID</label>
                                    <input
                                      value={srcChannelId}
                                      onChange={(e) => setSrcChannelId(e.target.value)}
                                      placeholder="C0123456789"
                                      style={{
                                        width: "100%", padding: "6px 10px", borderRadius: 5,
                                        background: "var(--mantle)", border: "1px solid var(--surface1)",
                                        color: "var(--text)", fontSize: 12, outline: "none",
                                        boxSizing: "border-box",
                                      }}
                                    />
                                  </div>
                                  <div style={{ flex: 1 }}>
                                    <label style={{ fontSize: 11, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Days back</label>
                                    <input
                                      value={srcDaysBack}
                                      onChange={(e) => setSrcDaysBack(e.target.value)}
                                      placeholder="30"
                                      type="number"
                                      style={{
                                        width: "100%", padding: "6px 10px", borderRadius: 5,
                                        background: "var(--mantle)", border: "1px solid var(--surface1)",
                                        color: "var(--text)", fontSize: 12, outline: "none",
                                        boxSizing: "border-box",
                                      }}
                                    />
                                  </div>
                                </div>
                                <div style={{ marginBottom: 8 }}>
                                  <label style={{ fontSize: 11, color: "var(--subtext0)", display: "block", marginBottom: 3 }}>Bot Token</label>
                                  <input
                                    value={srcSlackToken}
                                    onChange={(e) => setSrcSlackToken(e.target.value)}
                                    placeholder="xoxb-..."
                                    type="password"
                                    autoComplete="off"
                                    style={{
                                      width: "100%", padding: "6px 10px", borderRadius: 5,
                                      background: "var(--mantle)", border: "1px solid var(--surface1)",
                                      color: "var(--text)", fontSize: 12, outline: "none",
                                      boxSizing: "border-box", fontFamily: "var(--font-mono, monospace)",
                                    }}
                                  />
                                  <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 3 }}>
                                    Create at api.slack.com/apps → OAuth & Permissions. Scopes: channels:history, groups:history
                                  </div>
                                </div>
                              </>)}

                              {/* Index environment toggle */}
                              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                                <span style={{ fontSize: 11, color: "var(--subtext0)" }}>Index on:</span>
                                <div style={{ display: "flex", borderRadius: 5, overflow: "hidden", border: "1px solid var(--surface1)" }}>
                                  {(["prod", "dev"] as const).map((env) => (
                                    <button key={env} type="button" onClick={() => setIndexEnv(env)}
                                      style={{
                                        padding: "3px 10px", fontSize: 10, fontWeight: indexEnv === env ? 700 : 400,
                                        background: indexEnv === env ? (env === "prod" ? "rgba(20,99,255,0.15)" : "rgba(166,227,161,0.15)") : "transparent",
                                        color: indexEnv === env ? (env === "prod" ? "var(--blue)" : "var(--green)") : "var(--overlay0)",
                                        border: "none", cursor: "pointer", fontFamily: "var(--font-sans)",
                                        borderLeft: env === "dev" ? "1px solid var(--surface1)" : "none",
                                      }}>
                                      {env === "prod" ? "Cloud" : "Local"}
                                    </button>
                                  ))}
                                </div>
                                <span style={{ fontSize: 10, color: "var(--overlay0)" }}>
                                  {indexEnv === "prod" ? "Runs on Trigger.dev cloud" : "Runs on your machine (trigger dev)"}
                                </span>
                              </div>

                              {/* Analysis results */}
                              {analysis && (
                                <div style={{
                                  padding: "10px 12px", borderRadius: 6, marginBottom: 10,
                                  background: analysis.blocked ? "rgba(228,75,95,0.06)" : "rgba(28,191,107,0.06)",
                                  border: `1px solid ${analysis.blocked ? "rgba(228,75,95,0.2)" : "rgba(28,191,107,0.2)"}`,
                                  fontSize: 11, lineHeight: 1.6,
                                }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontWeight: 700, color: analysis.blocked ? "var(--red)" : "var(--green)" }}>
                                    {analysis.blocked ? <AlertCircle size={12} /> : <CheckCircle2 size={12} />}
                                    Pre-analysis {analysis.blocked ? "— blocked" : "— OK"}
                                  </div>
                                  <div style={{ display: "flex", gap: 16, marginBottom: 6, color: "var(--subtext0)" }}>
                                    <span>~{analysis.estimatedChunks.toLocaleString()} chunks</span>
                                    <span>~{(analysis.estimatedTokens / 1000).toFixed(0)}K tokens</span>
                                    <span>~${analysis.estimatedCostUsd.toFixed(4)} embedding cost</span>
                                  </div>
                                  {analysis.warnings.map((w, i) => (
                                    <div key={i} style={{ color: analysis.blocked ? "var(--red)" : "var(--overlay1)", display: "flex", alignItems: "flex-start", gap: 4 }}>
                                      <span style={{ flexShrink: 0 }}>{analysis.blocked && w.includes("exceeds") ? "✗" : "•"}</span>
                                      {w}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Action buttons */}
                              <div style={{ display: "flex", gap: 8 }}>
                                <button
                                  onClick={handleAnalyze}
                                  disabled={analyzing}
                                  style={{
                                    display: "flex", alignItems: "center", gap: 6,
                                    padding: "7px 14px", borderRadius: 6,
                                    background: "var(--surface1)", color: "var(--text)", border: "none",
                                    cursor: "pointer", fontSize: 12, fontWeight: 600,
                                    opacity: analyzing ? 0.7 : 1,
                                  }}
                                >
                                  {analyzing ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Search size={12} />}
                                  Analyze
                                </button>
                                <button
                                  onClick={handleAddSource}
                                  disabled={addingSource || (analysis?.blocked ?? false)}
                                  style={{
                                    display: "flex", alignItems: "center", gap: 6,
                                    padding: "7px 14px", borderRadius: 6,
                                    background: (analysis?.blocked) ? "var(--surface1)" : "var(--blue)",
                                    color: (analysis?.blocked) ? "var(--overlay0)" : "#fff",
                                    border: "none",
                                    cursor: (addingSource || analysis?.blocked) ? "not-allowed" : "pointer",
                                    fontSize: 12, fontWeight: 600,
                                    opacity: addingSource ? 0.7 : 1,
                                  }}
                                >
                                  {addingSource && <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />}
                                  Add &amp; Index
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Search preview */}
                          <div style={{ marginTop: 16, borderTop: "1px solid var(--surface0)", paddingTop: 16 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                              Search Preview
                            </div>
                            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                              <input
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                                placeholder="Test a search query..."
                                style={{
                                  flex: 1, padding: "7px 10px", borderRadius: 6,
                                  background: "var(--surface0)", border: "1px solid var(--surface1)",
                                  color: "var(--text)", fontSize: 12, outline: "none",
                                }}
                              />
                              <button
                                onClick={handleSearch}
                                disabled={searching || !searchQuery.trim()}
                                style={{
                                  display: "flex", alignItems: "center", gap: 5,
                                  padding: "7px 12px", borderRadius: 6,
                                  background: "var(--surface1)", border: "none",
                                  color: "var(--text)", cursor: "pointer",
                                  fontSize: 12, fontWeight: 500,
                                  opacity: searching ? 0.7 : 1,
                                }}
                              >
                                {searching
                                  ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                                  : <Search size={12} />
                                }
                                Search
                              </button>
                            </div>

                            {searchResults.length > 0 && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {searchResults.map((r, i) => (
                                  <div key={i} style={{
                                    padding: "8px 10px", borderRadius: 6,
                                    background: "var(--surface0)", fontSize: 12,
                                  }}>
                                    <div style={{ color: "var(--text)", marginBottom: 4, lineHeight: 1.5 }}>
                                      {r.content.slice(0, 200)}{r.content.length > 200 ? "..." : ""}
                                    </div>
                                    <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--overlay1)" }}>
                                      <span>Source: {r.source_name}</span>
                                      <span>Score: {(r.similarity * 100).toFixed(1)}%</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
    </IntegrationsShell>
  );
}
