"use client";

/**
 * Shared modal chrome for the "Curated Index" import flow used by
 * Skills, Commands, and (eventually) Hooks. Each section drops in a
 * children render-prop that builds the items list — everything around
 * it (header, curated repo picker, URL row, footer) is unified so the
 * three modals read as one family.
 *
 * Design choices:
 *
 *   · The curated dropdown is loaded once on mount, filtered by `kind`
 *     against /api/curated-repos. When empty the row hides itself so
 *     fresh installs without seeded curated_repos look clean.
 *   · The URL row stays editable even after the dropdown picks a value,
 *     so the operator can tweak the path or paste an unrelated URL.
 *   · `onLoad` is invoked when the operator clicks Load with a non-empty
 *     URL. The host is responsible for the actual fetch + state — the
 *     shell only owns dropdown/URL state and the Load button.
 *   · The footer renders the action button (Install / Add / etc.) when
 *     `actionLabel` + `onAction` are provided, otherwise just Close.
 *
 * To keep the shell agnostic about where state lives, the host owns
 * `loading`, `installing`, and `error` and passes them in. This lets
 * Skills keep its per-item install status etc. without the shell having
 * to know about it.
 */
import React, { useEffect, useState } from "react";
import { X, Download, Loader2, AlertCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  studioInputStyle,
  studioBtnPrimary,
  studioBtnGhost,
} from "@/components/StudioSectionChrome";

export interface CuratedRepoOpt {
  id:             string;
  slug:           string;
  name:           string;
  description:    string;
  repo_owner:     string;
  repo_name:      string;
  default_branch: string | null;
  paths:          Record<string, string>;
}

export interface CuratedIndexModalShellProps {
  /** Modal title shown in the header. */
  title:         string;
  /** Optional one-line subtitle under the title. */
  subtitle?:     string;
  /** Optional icon rendered next to the title. */
  icon?:         React.ReactNode;
  /** "kind" filter for /api/curated-repos — picks which repos appear in the dropdown. */
  curatedKind:   string;
  /** Key in repo.paths to read when filling the URL (e.g. "skills", "commands", "hooks"). */
  pathKey:       string;
  /** Initial URL to populate the input with. */
  initialUrl?:   string;
  /** Hard-coded URL suggestions shown only when the curated dropdown is empty. */
  fallbackSuggestions?: string[];
  /** Called when the operator clicks Load. Host fetches the index and updates its own state. */
  onLoad:        (url: string) => Promise<void> | void;
  /** Called when the operator clicks the action button. Optional; omit to hide the action. */
  onAction?:     () => Promise<void> | void;
  /** Label for the action button (e.g. "Install", "Add to factory"). */
  actionLabel?:  string;
  /** Whether to disable the action button (e.g. nothing selected). */
  actionDisabled?: boolean;
  /** Whether the action is currently running — drives the spinner / disabled state. */
  installing?:   boolean;
  /** Whether the load button is currently spinning. */
  loading?:      boolean;
  /** Error banner shown above the action button. */
  error?:        string | null;
  /** Modal close. */
  onClose:       () => void;
  /** Children render the items list for the host. */
  children:      React.ReactNode;
}

export function CuratedIndexModalShell({
  title,
  subtitle,
  icon,
  curatedKind,
  pathKey,
  initialUrl,
  fallbackSuggestions = [],
  onLoad,
  onAction,
  actionLabel,
  actionDisabled,
  installing,
  loading,
  error,
  onClose,
  children,
}: CuratedIndexModalShellProps) {
  const [url, setUrl]                   = useState(initialUrl ?? "");
  const [curated, setCurated]           = useState<CuratedRepoOpt[]>([]);
  const [pickedRepoId, setPickedRepoId] = useState("");

  useEffect(() => {
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await fetch(`/api/curated-repos?kind=${encodeURIComponent(curatedKind)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) return;
      const body = await res.json() as { repos?: CuratedRepoOpt[] };
      setCurated(body.repos ?? []);
    })();
  }, [curatedKind]);

  function pickCurated(id: string) {
    setPickedRepoId(id);
    if (!id) return;
    const repo = curated.find((r) => r.id === id);
    if (!repo) return;
    const branch = repo.default_branch ?? "main";
    const path = (repo.paths[pathKey] ?? "").replace(/^\/+|\/+$/g, "");
    // Empty path is the "scan repo root" signal — drop the
    // /tree/{branch}/{path} suffix so the preview API gets a bare-repo
    // URL it can detect via its root-as-collection fallback.
    setUrl(
      path
        ? `https://github.com/${repo.repo_owner}/${repo.repo_name}/tree/${branch}/${path}`
        : `https://github.com/${repo.repo_owner}/${repo.repo_name}`,
    );
  }

  const headerHasIcon = icon !== undefined;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface0)", borderRadius: 14, width: "min(820px, 95vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", boxShadow: "0 24px 64px rgba(0,0,0,0.5)" }}>
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--surface0)", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
              {headerHasIcon && icon}
              {title}
            </div>
            {subtitle && (
              <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 3, lineHeight: 1.4 }}>{subtitle}</div>
            )}
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "var(--overlay0)", cursor: "pointer", padding: 4, flexShrink: 0 }}><X size={18} /></button>
        </div>

        {/* Body */}
        <div style={{ padding: "16px 18px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
          {/* Curated dropdown */}
          {curated.length > 0 && (
            <div>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
                Pick from curated repos
              </label>
              <select
                value={pickedRepoId}
                onChange={(e) => pickCurated(e.target.value)}
                style={studioInputStyle}
                disabled={loading || installing}
              >
                <option value="">— pick a repo (or paste a URL below) —</option>
                {curated.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} · {r.repo_owner}/{r.repo_name}</option>
                ))}
              </select>
              <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
                Platform-curated by your admin. Fills the URL below; you can still paste any other GitHub URL.
              </div>
            </div>
          )}

          {/* URL row */}
          <div>
            <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>
              GitHub URL
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/{owner}/{repo}"
                style={{ ...studioInputStyle, fontFamily: "var(--font-mono)", fontSize: 12 }}
                disabled={loading || installing}
              />
              <button
                onClick={() => void onLoad(url.trim())}
                disabled={loading || !url.trim() || installing}
                style={{ ...studioBtnPrimary, padding: "8px 14px", fontSize: 12, opacity: loading || !url.trim() || installing ? 0.6 : 1 }}
              >
                {loading ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={12} />}
                Load
              </button>
            </div>
            {curated.length === 0 && fallbackSuggestions.length > 0 && (
              <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span>Try:</span>
                {fallbackSuggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => setUrl(s)}
                    disabled={loading || installing}
                    style={{ background: "transparent", border: "none", color: "var(--blue)", cursor: "pointer", padding: 0, fontSize: 10, fontFamily: "var(--font-mono)" }}
                  >
                    {s.replace("https://github.com/", "")}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Host-rendered items list (and any host-specific toolbar) */}
          {children}

          {error && (
            <div style={{ padding: "8px 10px", borderRadius: 6, background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)", color: "var(--red)", fontSize: 11, display: "flex", alignItems: "center", gap: 5 }}>
              <AlertCircle size={12} /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--surface0)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ ...studioBtnGhost, padding: "7px 14px", fontSize: 12 }}>
            Close
          </button>
          {actionLabel && onAction && (
            <button
              onClick={() => void onAction()}
              disabled={actionDisabled || installing}
              style={{ ...studioBtnPrimary, padding: "7px 14px", fontSize: 12, opacity: (actionDisabled || installing) ? 0.6 : 1 }}
            >
              {installing ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Download size={12} />}
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
