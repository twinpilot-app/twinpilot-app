"use client";

/** Cost-and-token analytics cluster on /projects/[id]: CostPanel
 *  (top-card rollup), AgentModelTable (sortable per-(agent, model)
 *  table), UsageByModel (donut + list) and AgentsBreakdown (per-agent
 *  collapsible cards). Smaller helpers (Th, shortModel, IntentSplitChip)
 *  are internal. */
import React, { useState } from "react";
import { Bot, Check, DollarSign, Info, ListTodo, Sparkles } from "lucide-react";
import type { DashboardData } from "@/app/projects/[id]/page";

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1)    return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}min`;
  return `${(m / 60).toFixed(1)}h`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

const detailLabel: React.CSSProperties = {
  fontSize: 9, color: "var(--overlay0)",
  textTransform: "uppercase", letterSpacing: "0.06em",
  marginBottom: 2,
};

const detailValue: React.CSSProperties = {
  fontSize: 12, color: "var(--subtext0)",
};

const panelStyle: React.CSSProperties = {
  background: "var(--mantle)",
  border: "1px solid var(--surface0)",
  borderRadius: 10,
  padding: 16,
  fontFamily: "var(--font-sans)",
};

const panelHeader: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6,
  fontSize: 10, fontWeight: 700,
  color: "var(--overlay0)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 12,
};

function RuntimeChip({ label, runs, usd }: { label: string; runs: number; usd: number }) {
  const [kind, ...rest] = label.split(":");
  const isCli = kind === "cli";
  const isInferred = label.endsWith(":~");
  const cleanLabel = rest.join(":").replace(/:~$/, "");
  const palette = isCli
    ? { bg: "rgba(245,159,0,0.10)", fg: "var(--peach)" }
    : kind === "api"
      ? { bg: "rgba(20,99,255,0.10)", fg: "var(--blue)" }
      : { bg: "var(--surface0)", fg: "var(--overlay0)" };
  return (
    <span
      title={`${runs} run${runs === 1 ? "" : "s"} · ${fmtUsd(usd)}${isInferred ? " · inferred" : ""}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 10, padding: "3px 7px", borderRadius: 4,
        background: palette.bg, color: palette.fg, fontWeight: 600,
      }}
    >
      <span style={{ fontWeight: 700, letterSpacing: "0.04em" }}>{(kind || "?").toUpperCase()}</span>
      <span style={{ opacity: 0.85 }}>{cleanLabel || (isCli ? "subscription" : "?")}</span>
      <span style={{ opacity: 0.6 }}>· {runs}</span>
      {isInferred && <span style={{ opacity: 0.5 }}>~</span>}
    </span>
  );
}

function KindBadge({ kind }: { kind: "cli" | "api" | "unknown" }) {
  const cfg = {
    cli:     { label: "CLI", bg: "rgba(245,159,0,0.10)", fg: "var(--peach)" },
    api:     { label: "API", bg: "rgba(20,99,255,0.10)", fg: "var(--blue)"  },
    unknown: { label: "?",   bg: "var(--surface0)",      fg: "var(--overlay0)" },
  }[kind];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontSize: 9, fontWeight: 700, letterSpacing: "0.06em",
      width: 32, padding: "2px 0", borderRadius: 4,
      background: cfg.bg, color: cfg.fg,
    }}>
      {cfg.label}
    </span>
  );
}

function CostPanel({ data }: { data: DashboardData }) {
  const { cost } = data;
  const max = Math.max(0.0001, ...cost.by_day.map((d) => d.usd));
  const totalTokens = cost.tokens_in_total + cost.tokens_out_total;
  const hasEstimated = cost.usd_estimated > 0;

  return (
    <div style={panelStyle}>
      <div style={panelHeader}>
        <DollarSign size={13} /> Cost
      </div>

      {/* Headline = real money. Estimated (subscription) shown next to it.
       * The split exists because claude-code Max + gemini-cli OAuth
       * report cost_usd as API-equivalent estimates, not actual spend.
       * Operator pays a flat subscription fee, not per-token. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 22, fontWeight: 700 }}>{fmtUsd(cost.usd_real)}</span>
        <span style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>
          real
        </span>
      </div>

      {hasEstimated && (
        <div
          title="Subscription-mode runs (claude-code Max, gemini-cli OAuth) — the actual bill is your monthly subscription, not this estimate. Useful for tracking quota, not money."
          style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--overlay0)" }}>
            + {fmtUsd(cost.usd_estimated)}
          </span>
          <span style={{ fontSize: 10, color: "var(--overlay1)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            est. (subscription)
          </span>
        </div>
      )}

      <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 6 }}>
        {fmtTokens(totalTokens)} tokens · last 14 days
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 32 }}>
        {cost.by_day.length === 0 && (
          <span style={{ fontSize: 11, color: "var(--overlay0)", alignSelf: "center" }}>no spend yet</span>
        )}
        {cost.by_day.map((d) => (
          <span
            key={d.day}
            title={`${d.day} · ${fmtUsd(d.usd)} · ${d.sprint_count} sprint${d.sprint_count === 1 ? "" : "s"}`}
            style={{
              flex: 1, minWidth: 4,
              height: `${Math.max(2, (d.usd / max) * 100)}%`,
              background: "var(--blue)", opacity: 0.7,
              borderRadius: 2,
            }}
          />
        ))}
      </div>

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--subtext0)" }}>
        <div>↑ {fmtTokens(cost.tokens_in_total)} in · ↓ {fmtTokens(cost.tokens_out_total)} out</div>
        {cost.by_sprint_recent[0] && cost.by_sprint_recent[0].usd > 0 && (
          <div>last sprint: {fmtUsd(cost.by_sprint_recent[0].usd)} ({cost.by_sprint_recent[0].agent_count} agents)</div>
        )}
      </div>
    </div>
  );
}

type AgentModelSortKey = "usd" | "usd_per_run" | "runs" | "sprints" | "agent";

function AgentModelTable({ rows, totalUsd }: {
  rows: DashboardData["cost"]["by_agent_model"];
  totalUsd: number;
}) {
  const [sortKey, setSortKey] = React.useState<AgentModelSortKey>("usd");
  const [sortDesc, setSortDesc] = React.useState(true);
  const [hideZero, setHideZero] = React.useState(true);

  const filtered = hideZero ? rows.filter((r) => r.usd > 0 || r.usd_per_run > 0) : rows;
  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "agent") cmp = a.agent.localeCompare(b.agent);
    else                     cmp = (a[sortKey] as number) - (b[sortKey] as number);
    return sortDesc ? -cmp : cmp;
  });

  function toggleSort(k: AgentModelSortKey) {
    if (sortKey === k) setSortDesc(!sortDesc);
    else { setSortKey(k); setSortDesc(true); }
  }

  function shortRuntime(r: DashboardData["cost"]["by_agent_model"][number]): string {
    if (r.kind === "cli") {
      const cli   = r.cli ?? "?";
      const model = r.model ?? "auto";
      return `${cli} · ${shortModel(model)}${r.inferred ? " (inf)" : ""}`;
    }
    if (r.kind === "api") return `api · ${shortModel(r.model ?? "?")}`;
    return "unknown";
  }

  return (
    <div style={{
      background: "var(--mantle)", border: "1px solid var(--surface0)",
      borderRadius: 8, overflow: "hidden",
    }}>
      <div style={{
        padding: "8px 12px", borderBottom: "1px solid var(--surface0)",
        display: "flex", alignItems: "center", gap: 12, fontSize: 11,
      }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: "var(--subtext0)" }}>
          <input
            type="checkbox"
            checked={hideZero}
            onChange={(e) => setHideZero(e.target.checked)}
          />
          Hide zero-cost rows
        </label>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--overlay0)" }}>Total: {fmtUsd(totalUsd)}</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "var(--surface0)" }}>
              <Th label="Agent"      active={sortKey === "agent"}        desc={sortDesc} onClick={() => toggleSort("agent")} />
              <Th label="Runtime"    active={false}                       desc={false}    onClick={undefined} />
              <Th label="Runs"       active={sortKey === "runs"}          desc={sortDesc} onClick={() => toggleSort("runs")}        align="right" />
              <Th label="Sprints"    active={sortKey === "sprints"}       desc={sortDesc} onClick={() => toggleSort("sprints")}     align="right" />
              <Th label="Tokens"     active={false}                       desc={false}    onClick={undefined}                       align="right" />
              <Th label="Total $"    active={sortKey === "usd"}           desc={sortDesc} onClick={() => toggleSort("usd")}         align="right" />
              <Th label="Avg $/run"  active={sortKey === "usd_per_run"}   desc={sortDesc} onClick={() => toggleSort("usd_per_run")} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={`${r.agent}::${r.runtime}`} style={{ borderTop: "1px solid var(--surface0)" }}>
                <td style={{ padding: "6px 10px", fontWeight: 600 }}>{r.agent}</td>
                <td style={{ padding: "6px 10px", color: "var(--subtext0)", fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>
                  {shortRuntime(r)}
                </td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--subtext0)" }}>{r.runs}</td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--subtext0)" }}>{r.sprints}</td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--overlay0)", fontSize: 11 }}>
                  ↑{fmtTokens(r.tokens_in)} ↓{fmtTokens(r.tokens_out)}
                </td>
                <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600, color: r.usd > 0 ? "var(--text)" : "var(--overlay0)" }}>
                  {r.usd > 0 ? fmtUsd(r.usd) : "—"}
                </td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: r.usd_per_run > 0 ? "var(--peach)" : "var(--overlay0)" }}>
                  {r.usd_per_run > 0 ? fmtUsd(r.usd_per_run) : "—"}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: "16px 10px", textAlign: "center", color: "var(--overlay0)", fontSize: 11 }}>
                  {hideZero ? "All rows have zero cost — uncheck to see CLI subscription runs." : "No data yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ label, active, desc, onClick, align }: {
  label:   string;
  active:  boolean;
  desc:    boolean;
  onClick: (() => void) | undefined;
  align?:  "right" | "left";
}) {
  return (
    <th
      onClick={onClick}
      style={{
        padding: "6px 10px",
        textAlign: align ?? "left",
        fontSize: 10, fontWeight: 700,
        color: active ? "var(--blue)" : "var(--overlay0)",
        textTransform: "uppercase", letterSpacing: "0.06em",
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
      }}
    >
      {label}{active ? (desc ? " ↓" : " ↑") : ""}
    </th>
  );
}

function shortModel(m: string): string {
  // Strip the verbose "claude-" prefix and trailing date stamps so the
  // table column stays narrow. opus-4-7 / sonnet-4-6 / haiku-4-5 read
  // cleaner than the full canonical IDs.
  return m
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
}

function UsageByModel({ models, totalUsd }: {
  models: DashboardData["cost"]["by_model"];
  totalUsd: number;
}) {
  const cliCount = models.filter((m) => m.kind === "cli").length;
  const apiCount = models.filter((m) => m.kind === "api").length;
  // For bar scaling: max single-entry usd, with a floor so 0-cost CLI runs
  // still render a sliver rather than nothing.
  const maxUsd = Math.max(0.0001, ...models.map((m) => m.usd));

  return (
    <div style={{ ...panelStyle, padding: 0 }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        borderBottom: "1px solid var(--surface0)",
      }}>
        <div style={{ padding: "10px 14px", borderRight: "1px solid var(--surface0)" }}>
          <div style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            CLIs used
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
            {cliCount} {cliCount === 1 ? "CLI" : "CLIs"}
          </div>
        </div>
        <div style={{ padding: "10px 14px" }}>
          <div style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            API models
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
            {apiCount} {apiCount === 1 ? "model" : "models"}
          </div>
        </div>
      </div>

      <div>
        {models.map((m) => {
          const pctTotal = totalUsd > 0 ? Math.round((m.usd / totalUsd) * 100) : 0;
          const barPct = (m.usd / maxUsd) * 100;
          return (
            <div
              key={m.key}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto auto auto",
                alignItems: "center", gap: 12,
                padding: "10px 14px",
                borderBottom: "1px solid var(--surface0)",
                fontSize: 12,
              }}
            >
              <KindBadge kind={m.kind} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.kind === "cli"
                    ? <>
                        {m.cli}
                        {m.model
                          ? <span style={{ color: "var(--overlay0)", fontWeight: 400 }}> · {m.model}</span>
                          : <span style={{ color: "var(--overlay0)", fontWeight: 400 }}> · subscription</span>}
                        {m.inferred && (
                          <span
                            title="Legacy run before the worker patch — CLI inferred from token/cost shape (claude-code is the only CLI that emits parseable cost). New runs land here directly."
                            style={{ color: "var(--overlay1)", fontWeight: 400, fontSize: 10, marginLeft: 6 }}
                          >
                            (inferred)
                          </span>
                        )}
                      </>
                    : m.kind === "api" ? m.model
                    : <span style={{ color: "var(--overlay0)" }}>(unknown — pre-patch run)</span>}
                </div>
                <div style={{ marginTop: 4, height: 4, background: "var(--surface0)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{
                    width: `${Math.max(2, barPct)}%`,
                    height: "100%",
                    background: m.kind === "cli" ? "var(--peach)" : m.kind === "api" ? "var(--blue)" : "var(--overlay1)",
                    opacity: 0.7,
                  }} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "right", minWidth: 80 }}>
                {m.runs} run{m.runs === 1 ? "" : "s"}
              </div>
              <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "right", minWidth: 90 }}>
                {fmtTokens(m.tokens_in + m.tokens_out)} tokens
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, textAlign: "right", minWidth: 80 }}>
                {fmtUsd(m.usd)} <span style={{ color: "var(--overlay0)", fontWeight: 400, fontSize: 10 }}>{pctTotal}%</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentsBreakdown({ agents, totalUsd }: {
  agents: DashboardData["agents"];
  totalUsd: number;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const maxUsd = Math.max(0.0001, ...agents.map((a) => a.usd));

  return (
    <div style={{ ...panelStyle, padding: 0 }}>
      {agents.map((a) => {
        const isOpen = expanded === a.agent;
        const pctTotal = totalUsd > 0 ? Math.round((a.usd / totalUsd) * 100) : 0;
        const barPct = (a.usd / maxUsd) * 100;
        const failRate = a.runs > 0 ? Math.round((a.runs_failed / a.runs) * 100) : 0;
        return (
          <div key={a.agent} style={{ borderBottom: "1px solid var(--surface0)" }}>
            <button
              onClick={() => setExpanded(isOpen ? null : a.agent)}
              style={{
                width: "100%",
                display: "grid",
                gridTemplateColumns: "auto 1fr auto auto auto auto",
                alignItems: "center", gap: 12,
                padding: "12px 14px",
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--text)", textAlign: "left", fontFamily: "var(--font-sans)",
              }}
            >
              <Bot size={14} color="var(--overlay0)" />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.agent}
                </div>
                <div style={{ marginTop: 4, height: 4, background: "var(--surface0)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{
                    width: `${Math.max(2, barPct)}%`,
                    height: "100%",
                    background: failRate >= 30 ? "var(--peach)" : "var(--blue)",
                    opacity: 0.7,
                  }} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "right", minWidth: 80 }}>
                {a.runs} run{a.runs === 1 ? "" : "s"}
                {a.runs_failed > 0 && (
                  <span style={{ color: "var(--red)", marginLeft: 4 }} title={`${a.runs_failed} failed (${failRate}%)`}>
                    · {a.runs_failed}✗
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "right", minWidth: 70 }}>
                {a.sprints} sprint{a.sprints === 1 ? "" : "s"}
              </div>
              <div style={{ fontSize: 11, color: "var(--overlay0)", textAlign: "right", minWidth: 70 }}>
                {a.avg_wall_ms ? `~${fmtDuration(a.avg_wall_ms)}` : "—"}
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, textAlign: "right", minWidth: 90 }}>
                {fmtUsd(a.usd)} <span style={{ color: "var(--overlay0)", fontWeight: 400, fontSize: 10 }}>{pctTotal}%</span>
              </div>
            </button>

            {isOpen && (
              <div style={{ padding: "8px 14px 14px 38px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, background: "var(--crust)" }}>
                <div>
                  <div style={detailLabel}>Tokens</div>
                  <div style={detailValue}>
                    ↑ {fmtTokens(a.tokens_in)} in · ↓ {fmtTokens(a.tokens_out)} out
                  </div>
                </div>
                <div>
                  <div style={detailLabel}>Total wall time</div>
                  <div style={detailValue}>{fmtDuration(a.total_wall_ms)}</div>
                </div>
                <div>
                  <div style={detailLabel}>Last run</div>
                  <div style={detailValue}>{a.last_run ? timeAgo(a.last_run) : "—"}</div>
                </div>
                <div>
                  <div style={detailLabel}>Sprints touched</div>
                  <div style={detailValue}>{a.sprints}</div>
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <div style={detailLabel}>By intent</div>
                  <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                    <IntentSplitChip intent="discovery" runs={a.runs_discovery} usd={a.usd_discovery} />
                    <IntentSplitChip intent="execution" runs={a.runs_execution} usd={a.usd_execution} />
                    {a.runs - a.runs_discovery - a.runs_execution > 0 && (
                      <IntentSplitChip
                        intent="other"
                        runs={a.runs - a.runs_discovery - a.runs_execution}
                        usd={a.usd - a.usd_discovery - a.usd_execution}
                      />
                    )}
                  </div>
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <div style={detailLabel}>Runtimes used</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                    {a.runtimes.length === 0 ? (
                      <span style={{ fontSize: 11, color: "var(--overlay0)" }}>—</span>
                    ) : a.runtimes.map((rt) => (
                      <RuntimeChip key={rt.key} label={rt.key} runs={rt.runs} usd={rt.usd} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function IntentSplitChip({ intent, runs, usd }: {
  intent: "discovery" | "planning" | "execution" | "review" | "other";
  runs: number;
  usd: number;
}) {
  const cfg = {
    discovery: { label: "Discovery", icon: <Sparkles size={10} />, bg: "rgba(20,99,255,0.10)",  fg: "var(--blue)"   },
    planning:  { label: "Planning",  icon: <ListTodo size={10} />, bg: "rgba(167,139,250,0.10)", fg: "var(--mauve)" },
    execution: { label: "Execution", icon: <Bot size={10} />,      bg: "rgba(28,191,107,0.10)", fg: "var(--green)"  },
    review:    { label: "Review",    icon: <Check size={10} />,    bg: "rgba(245,159,0,0.10)",  fg: "var(--peach)"  },
    other:     { label: "Other",     icon: <Info size={10} />,     bg: "var(--surface0)",       fg: "var(--overlay0)" },
  }[intent];
  const dim = runs === 0;
  return (
    <span
      title={`${runs} run${runs === 1 ? "" : "s"} · ${fmtUsd(usd)}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontSize: 11, padding: "3px 8px", borderRadius: 4,
        background: cfg.bg, color: cfg.fg, fontWeight: 600,
        opacity: dim ? 0.4 : 1,
      }}
    >
      {cfg.icon}
      <span>{cfg.label}</span>
      <span style={{ opacity: 0.85 }}>{runs}</span>
      {usd > 0 && <span style={{ opacity: 0.7, fontSize: 10 }}>· {fmtUsd(usd)}</span>}
    </span>
  );
}

export { CostPanel, AgentModelTable, UsageByModel, AgentsBreakdown };
