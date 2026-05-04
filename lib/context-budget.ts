/**
 * Frontend mirror of services/control-plane/lib/context-budget.ts.
 *
 * The worker measures byte sizes per source (persona, .tp/PROJECT.md,
 * skills, MCP config, etc.) right before launching the CLI and stamps
 * the result on `agent_runs.context_bytes`. This file is just the
 * shared type plus presentation labels for the sprint review UI.
 *
 * Keep the source list in sync with the worker — adding a key requires
 * touching both files (the schema is JSONB, no DB CHECK to enforce).
 */

export type ContextBudgetSource =
  | "persona"
  | "project_md"
  | "memory_md"
  | "sprint_md"
  | "sprint_items_md"
  | "prd_md"
  | "skills"
  | "guidelines"
  | "briefing"
  | "claude_md"
  | "mcp_config"
  | "task";

export type ContextBudget = Partial<Record<ContextBudgetSource, number>> & { total?: number };

interface SourcePresentation {
  label: string;
  /** What's actually inside this bucket. Shown in tooltip. */
  hint:  string;
  /** Catppuccin-aligned token, picked so adjacent bars in a stacked
   *  view stay distinguishable. */
  color: string;
}

export const CONTEXT_SOURCE_LABELS: Record<ContextBudgetSource, SourcePresentation> = {
  persona: {
    label: "Persona",
    hint:  "Subagent definition file (.claude/agents/{slug}.md). The agent's role, instructions, and guardrails.",
    color: "#a78bfa",
  },
  project_md: {
    label: "PROJECT.md",
    hint:  "Project briefing + PRD + exit criteria. Stable across sprints.",
    color: "#1463ff",
  },
  memory_md: {
    label: "MEMORY.md",
    hint:  "Recent sprint outcomes + approved memory entries (decisions, conventions, gotchas).",
    color: "#5b9aff",
  },
  sprint_md: {
    label: "SPRINT.md",
    hint:  "This sprint's specific briefing — only present when distinct from the project briefing.",
    color: "#00c2a8",
  },
  sprint_items_md: {
    label: "SPRINT-ITEMS.md",
    hint:  "Selected backlog items for this sprint. Authoritative scope.",
    color: "#1cbf6b",
  },
  prd_md: {
    label: "PRD.md",
    hint:  "Mirror of projects.prd_md when present.",
    color: "#94e2d5",
  },
  skills: {
    label: "Skills",
    hint:  "Sum of all materialised .claude/skills/*/SKILL.md files. Loaded lazily by claude-code, but the description always loads at session start.",
    color: "#f59f00",
  },
  guidelines: {
    label: "Guidelines",
    hint:  "Combined factory + project guidelines passed to the agent (deprecated path; most projects now use Skills).",
    color: "#df8e1d",
  },
  briefing: {
    label: "BRIEFING.md",
    hint:  "Per-agent task brief written for this run.",
    color: "#f5c542",
  },
  claude_md: {
    label: "CLAUDE.md",
    hint:  "Project-level harness instructions read by claude-code at startup.",
    color: "#7287fd",
  },
  mcp_config: {
    label: "MCP config",
    hint:  ".mcp.json (or .codex/.gemini equivalents) — the tool descriptions claude-code injects into its system prompt.",
    color: "#ea76cb",
  },
  task: {
    label: "Task",
    hint:  "Inline task / message text passed to the CLI on the command line.",
    color: "var(--overlay1)",
  },
};

export const CONTEXT_SOURCE_ORDER: ContextBudgetSource[] = [
  "persona",
  "project_md",
  "memory_md",
  "sprint_md",
  "sprint_items_md",
  "prd_md",
  "skills",
  "guidelines",
  "briefing",
  "claude_md",
  "mcp_config",
  "task",
];

/** Format bytes for a compact UI badge: "1.2 KB", "47 KB", "1.4 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Sum the source counters and return the total (excluding `total`
 *  itself when present, to avoid double-counting on stale data). */
export function sumBudget(b: ContextBudget | null | undefined): number {
  if (!b) return 0;
  let s = 0;
  for (const key of CONTEXT_SOURCE_ORDER) {
    const v = b[key];
    if (typeof v === "number") s += v;
  }
  return s;
}
