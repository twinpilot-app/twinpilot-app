"use client";

/** Second row of /projects/[id] panels: PRD authoring summary, Memory
 *  entries (approve / reject / archive), Budget configuration (monthly
 *  + daily caps, scope, action). */
import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardList, DollarSign, Settings, Sparkles } from "lucide-react";
import { brand } from "@/lib/brand";
import type { DashboardData } from "@/app/projects/[id]/page";

interface MemoryEntry {
  id:               string;
  type:             "decision" | "convention" | "gotcha" | "dependency" | string;
  title:            string;
  content:          string;
  status:           "proposed" | "approved" | "rejected" | "archived" | string;
  agent_slug:       string;
  sprint_id:        string | null;
  created_at:       string;
  approved_at:      string | null;
  rejection_reason: string | null;
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1)    return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

const panelStyle: React.CSSProperties = {
  background: "var(--mantle)",
  border: "1px solid var(--surface0)",
  borderRadius: 10,
  padding: 16,
  fontFamily: "var(--font-sans)",
};

const detailLabel: React.CSSProperties = {
  fontSize: 9, color: "var(--overlay0)",
  textTransform: "uppercase", letterSpacing: "0.06em",
  marginBottom: 2,
};

const iconButtonStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "6px 12px", borderRadius: 8,
  border: "1px solid var(--surface1)",
  background: "transparent",
  color: "var(--subtext0)",
  fontSize: 11, fontWeight: 600,
  cursor: "pointer", textDecoration: "none",
  fontFamily: "var(--font-sans)",
};

const primaryLinkStyle: React.CSSProperties = {
  ...iconButtonStyle,
  background: "var(--blue)",
  color: "#fff",
  border: "none",
};

function PrdPanel({ data }: { data: DashboardData }) {
  const prd = data.prd;
  const router = useRouter();

  const statusPalette: Record<string, { bg: string; fg: string; label: string }> = {
    draft:    { bg: "rgba(254,166,73,0.12)", fg: "var(--peach)", label: "Draft" },
    reviewed: { bg: "rgba(20,99,255,0.12)",  fg: "var(--blue)",  label: "Reviewed" },
    approved: { bg: "rgba(28,191,107,0.12)", fg: "var(--green)", label: "Approved" },
  };

  const isMissing = !prd.has_content;
  const palette = prd.status ? statusPalette[prd.status] : null;

  return (
    <div style={{
      background: "var(--mantle)", border: "1px solid var(--surface0)",
      borderRadius: 8, padding: "12px 16px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <ClipboardList size={14} color={isMissing ? "var(--overlay0)" : "var(--blue)"} />
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
          Product Requirements Document
        </div>
        {palette && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
            background: palette.bg, color: palette.fg,
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>{palette.label}</span>
        )}
        {isMissing && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
            background: "var(--surface0)", color: "var(--overlay0)",
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}>not authored</span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => router.push(`/projects?focus=${data.project.id}#prd`)}
          style={{
            padding: "4px 10px", borderRadius: 5,
            border: "1px solid var(--surface1)", background: "transparent",
            color: "var(--subtext0)", fontSize: 10, fontWeight: 600,
            cursor: "pointer", fontFamily: "var(--font-sans)",
          }}
          title="Edit PRD in Project Settings"
        >
          {isMissing ? "Author PRD" : "Edit"}
        </button>
      </div>

      {isMissing ? (
        <div style={{ fontSize: 12, color: "var(--overlay0)", lineHeight: 1.5 }}>
          No PRD authored yet. The <code>product-manager</code> agent composes a draft during Discovery
          from the briefing + scout findings. You can also write directly in Project Settings → PRD.
        </div>
      ) : (
        <>
          <div style={{
            padding: "10px 12px", borderRadius: 6,
            background: "var(--base)", border: "1px solid var(--surface0)",
            fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5,
            fontFamily: "var(--font-mono, monospace)",
            whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto",
          }}>
            {prd.excerpt}
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 12, marginTop: 8,
            fontSize: 10, color: "var(--overlay0)",
          }}>
            <span>{prd.length_chars.toLocaleString()} chars</span>
            {prd.authored_by_agent && (
              <span>· authored by <strong style={{ color: "var(--subtext0)" }}>{prd.authored_by_agent}</strong></span>
            )}
            {prd.authored_by_sprint !== null && (
              <span>· in sprint <strong style={{ color: "var(--subtext0)" }}>#{prd.authored_by_sprint}</strong></span>
            )}
            {prd.authored_at && (
              <span>· {new Date(prd.authored_at).toLocaleString()}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MemoryPanel({ data, authToken, onChanged }: {
  data: DashboardData;
  authToken: string;
  onChanged: () => void;
}) {
  const { memory } = data;
  const [tab, setTab] = useState<"proposed" | "approved">(memory.proposed_count > 0 ? "proposed" : "approved");
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadEntries = useCallback(async () => {
    if (!authToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${data.project.id}/memory?status=${tab}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `Load failed (${res.status})`);
      }
      const body = await res.json() as { entries: MemoryEntry[] };
      setEntries(body.entries ?? []);
    } catch (e) { setError((e as Error).message); }
    finally       { setLoading(false); }
  }, [authToken, data.project.id, tab]);

  useEffect(() => { void reloadEntries(); }, [reloadEntries]);

  async function transition(entryId: string, status: "approved" | "rejected" | "archived", reason?: string) {
    setBusyId(entryId);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${data.project.id}/memory/${entryId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...(reason ? { rejection_reason: reason } : {}) }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `Update failed (${res.status})`);
      }
      await reloadEntries();
      onChanged();  // refresh dashboard counts
    } catch (e) { setError((e as Error).message); }
    finally       { setBusyId(null); }
  }

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <Sparkles size={13} color="var(--overlay0)" />
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Project memory
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => setTab("proposed")}
            style={{
              ...iconButtonStyle,
              background: tab === "proposed" ? "var(--surface1)" : "transparent",
              color: tab === "proposed" ? "var(--text)" : "var(--overlay0)",
            }}
          >
            Proposed {memory.proposed_count > 0 && (
              <span style={{
                background: "var(--peach)", color: "#000",
                fontSize: 9, fontWeight: 700,
                padding: "1px 5px", borderRadius: 8, marginLeft: 4,
              }}>{memory.proposed_count}</span>
            )}
          </button>
          <button
            onClick={() => setTab("approved")}
            style={{
              ...iconButtonStyle,
              background: tab === "approved" ? "var(--surface1)" : "transparent",
              color: tab === "approved" ? "var(--text)" : "var(--overlay0)",
            }}
          >
            Approved {memory.approved_count > 0 && (
              <span style={{
                background: "var(--green)", color: "#000",
                fontSize: 9, fontWeight: 700,
                padding: "1px 5px", borderRadius: 8, marginLeft: 4,
              }}>{memory.approved_count}</span>
            )}
          </button>
        </div>
      </div>

      {tab === "proposed" && memory.proposed_count > 0 && (
        <div style={{
          marginBottom: 10, padding: "8px 10px", borderRadius: 6,
          background: "rgba(245,159,0,0.06)",
          fontSize: 11, color: "var(--peach)", lineHeight: 1.4,
        }}>
          Agents proposed {memory.proposed_count} entr{memory.proposed_count === 1 ? "y" : "ies"} for this project's memory. Approved entries land in the next sprint's <code>.tp/MEMORY.md</code>; rejected stays in audit only.
        </div>
      )}

      {error && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 8 }}>{error}</div>}

      {loading ? (
        <div style={{ padding: 16, color: "var(--overlay0)", fontSize: 12 }}>Loading…</div>
      ) : entries.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--overlay0)" }}>
          {tab === "proposed"
            ? "No entries waiting for review."
            : "No approved entries yet — agents must propose them via the record_decision MCP tool."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {entries.map((e) => (
            <MemoryEntryRow
              key={e.id}
              entry={e}
              busy={busyId === e.id}
              onApprove={() => void transition(e.id, "approved")}
              onReject={() => {
                const reason = prompt("Reason for rejection (optional, ≤500 chars):") ?? undefined;
                if (reason !== null) void transition(e.id, "rejected", reason);
              }}
              onArchive={() => {
                if (confirm("Archive this entry? It will no longer load into future sprints.")) {
                  void transition(e.id, "archived");
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryEntryRow({ entry, busy, onApprove, onReject, onArchive }: {
  entry: MemoryEntry;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onArchive: () => void;
}) {
  const palette: Record<string, { bg: string; fg: string }> = {
    decision:   { bg: "rgba(20,99,255,0.10)",  fg: "var(--blue)"  },
    convention: { bg: "rgba(28,191,107,0.10)", fg: "var(--green)" },
    gotcha:     { bg: "rgba(245,159,0,0.10)",  fg: "var(--peach)" },
    dependency: { bg: "rgba(203,166,247,0.10)", fg: "var(--mauve)" },
  };
  const p = palette[entry.type] ?? palette.decision;
  return (
    <div style={{
      padding: "10px 12px", borderRadius: 8,
      border: "1px solid var(--surface0)", background: "var(--mantle)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
          background: p.bg, color: p.fg,
          textTransform: "uppercase", letterSpacing: "0.04em",
        }}>{entry.type}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entry.title}
        </span>
        <span style={{ fontSize: 10, color: "var(--overlay0)" }}>
          {entry.agent_slug} · {timeAgo(entry.created_at)}
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.5, marginBottom: 8 }}>
        {entry.content}
      </div>
      {entry.status === "proposed" && (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button onClick={onReject} disabled={busy} style={{ ...iconButtonStyle, color: "var(--red)" }}>
            Reject
          </button>
          <button onClick={onApprove} disabled={busy}
            style={{ ...primaryLinkStyle, opacity: busy ? 0.6 : 1, cursor: busy ? "not-allowed" : "pointer", background: "var(--green)" }}>
            Approve
          </button>
        </div>
      )}
      {entry.status === "approved" && (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button onClick={onArchive} disabled={busy} style={{ ...iconButtonStyle, color: "var(--overlay0)" }}>
            Archive
          </button>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
 * BUDGET — opt-in soft brake (the actual hard limit lives at the provider)
 * ════════════════════════════════════════════════════════════════════ */
function BudgetPanel({ data, authToken, onChanged }: {
  data: DashboardData;
  authToken: string;
  onChanged: () => void;
}) {
  const { budget } = data;
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(budget.enabled);
  const [scope,   setScope]   = useState(budget.scope);
  const [action,  setAction]  = useState(budget.action);
  const [monthly, setMonthly] = useState(budget.monthly_cap !== null ? String(budget.monthly_cap) : "");
  const [daily,   setDaily]   = useState(budget.daily_cap   !== null ? String(budget.daily_cap)   : "");
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  function startEdit() {
    setEnabled(budget.enabled);
    setScope(budget.scope);
    setAction(budget.action);
    setMonthly(budget.monthly_cap !== null ? String(budget.monthly_cap) : "");
    setDaily  (budget.daily_cap   !== null ? String(budget.daily_cap)   : "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const m = monthly.trim();
      const d = daily.trim();
      const body = {
        budget: {
          enabled,
          scope,
          action,
          monthly_usd_cap: m === "" ? null : Number(m),
          daily_usd_cap:   d === "" ? null : Number(d),
        },
      };
      const res = await fetch(`/api/projects/${data.project.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? `Save failed (${res.status})`);
      }
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const statusColor = budget.status === "halt" ? "var(--red)" : budget.status === "warn" ? "var(--peach)" : "var(--green)";
  const monthPct = budget.monthly_cap ? Math.min(100, (budget.month_total_usd / budget.monthly_cap) * 100) : null;
  const dayPct   = budget.daily_cap   ? Math.min(100, (budget.day_total_usd   / budget.daily_cap)   * 100) : null;

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <DollarSign size={13} color="var(--overlay0)" />
        <span style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Budget brake
        </span>
        {budget.enabled && (
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4,
            background: budget.status === "ok" ? "rgba(28,191,107,0.10)" : budget.status === "warn" ? "rgba(245,159,0,0.10)" : "rgba(255,77,77,0.10)",
            color: statusColor, textTransform: "uppercase", letterSpacing: "0.04em",
          }}>
            {budget.status}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {!editing && (
          <button onClick={startEdit} style={iconButtonStyle}>
            <Settings size={11} /> {budget.enabled ? "Edit" : "Configure"}
          </button>
        )}
      </div>

      {!editing ? (
        budget.enabled ? (
          <>
            {budget.reason && (
              <div style={{
                marginBottom: 10, padding: "8px 10px", borderRadius: 6,
                background: budget.status === "halt" ? "rgba(255,77,77,0.08)" : "rgba(245,159,0,0.08)",
                color: statusColor, fontSize: 11, lineHeight: 1.4,
              }}>
                {budget.reason}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <BudgetMeter label="This month" used={budget.month_total_usd} cap={budget.monthly_cap} pct={monthPct} />
              <BudgetMeter label="Today"      used={budget.day_total_usd}   cap={budget.daily_cap}   pct={dayPct}   />
            </div>
            <div style={{ marginTop: 10, fontSize: 10, color: "var(--overlay0)" }}>
              Scope: <strong style={{ color: "var(--subtext0)" }}>{budget.scope === "api_only" ? "API runs only (real $)" : "all runs (incl. subscription estimates)"}</strong>
              {" · "}
              On cap: <strong style={{ color: "var(--subtext0)" }}>{budget.action === "halt" ? "halt auto-drain" : "warn only"}</strong>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--overlay0)", lineHeight: 1.5 }}>
            Off. When enabled, the dispatcher can soft-pause auto-drain when a USD cap is hit.
            {" "}
            <strong style={{ color: "var(--subtext0)" }}>This is a soft brake</strong> — set actual hard limits at your provider's console (Anthropic Console, OpenAI Usage).
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{
            padding: "8px 10px", borderRadius: 6,
            background: "rgba(245,159,0,0.06)", border: "1px solid rgba(245,159,0,0.15)",
            fontSize: 10, color: "var(--peach)", lineHeight: 1.5,
          }}>
            ⚠ This is a soft brake inside {brand.name}. Set <strong>actual hard limits</strong> at your provider's console
            (Anthropic, OpenAI, Google) — {brand.name} cannot guarantee spending stops at this cap.
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span style={{ fontWeight: 600 }}>Enable budget brake for this project</span>
          </label>

          <div>
            <div style={{ ...detailLabel, marginBottom: 4 }}>Scope</div>
            <select value={scope} onChange={(e) => setScope(e.target.value as "api_only" | "all")} disabled={!enabled} style={selectStyle}>
              <option value="api_only">API runs only — real $ to provider (recommended)</option>
              <option value="all">All runs — includes subscription estimates</option>
            </select>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <div style={{ ...detailLabel, marginBottom: 4 }}>Monthly cap (USD)</div>
              <input type="number" min={0} step={0.01} value={monthly} onChange={(e) => setMonthly(e.target.value)}
                placeholder="e.g. 50" disabled={!enabled} style={inputStyle} />
            </div>
            <div>
              <div style={{ ...detailLabel, marginBottom: 4 }}>Daily cap (USD)</div>
              <input type="number" min={0} step={0.01} value={daily} onChange={(e) => setDaily(e.target.value)}
                placeholder="e.g. 5" disabled={!enabled} style={inputStyle} />
            </div>
          </div>

          <div>
            <div style={{ ...detailLabel, marginBottom: 4 }}>On cap reached</div>
            <select value={action} onChange={(e) => setAction(e.target.value as "warn" | "halt")} disabled={!enabled} style={selectStyle}>
              <option value="warn">Warn — show banner, keep running</option>
              <option value="halt">Halt — pause auto-drain until next billing window</option>
            </select>
          </div>

          {error && <div style={{ fontSize: 11, color: "var(--red)" }}>{error}</div>}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setEditing(false)} disabled={saving} style={iconButtonStyle}>Cancel</button>
            <button onClick={() => void save()} disabled={saving}
              style={{ ...primaryLinkStyle, opacity: saving ? 0.6 : 1, cursor: saving ? "not-allowed" : "pointer" }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BudgetMeter({ label, used, cap, pct }: { label: string; used: number; cap: number | null; pct: number | null }) {
  const barColor = pct !== null && pct >= 100 ? "var(--red)" : pct !== null && pct >= 80 ? "var(--peach)" : "var(--blue)";
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
        <span style={{ fontSize: 11, color: "var(--subtext0)" }}>
          {fmtUsd(used)} {cap !== null && <span style={{ color: "var(--overlay0)" }}>/ {fmtUsd(cap)}</span>}
        </span>
      </div>
      <div style={{ height: 6, background: "var(--surface0)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          width: `${pct === null ? 0 : Math.max(2, pct)}%`,
          height: "100%", background: barColor, opacity: 0.8,
        }} />
      </div>
      {cap === null && <div style={{ fontSize: 9, color: "var(--overlay1)", marginTop: 3 }}>no cap set</div>}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: "100%", padding: "6px 8px", fontSize: 12,
  background: "var(--base)", color: "var(--text)",
  border: "1px solid var(--surface1)", borderRadius: 6,
  fontFamily: "var(--font-sans)",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "6px 8px", fontSize: 12,
  background: "var(--base)", color: "var(--text)",
  border: "1px solid var(--surface1)", borderRadius: 6,
  fontFamily: "var(--font-sans)",
};

export { PrdPanel, MemoryPanel, BudgetPanel };
