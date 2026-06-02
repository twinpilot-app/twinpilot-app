/**
 * Frontend-side mirror of services/control-plane/lib/sprint-diagnostics.ts.
 *
 * The worker classifies failures and stamps `sprints.failure_class`; this
 * module just gives the UI the shared type + presentation labels. Keep
 * the FailureClass union and FAILURE_CLASS_LABELS in sync with the worker
 * file when adding a new class — the DB CHECK constraint (migration 161)
 * will reject any value that isn't here.
 */

export type FailureClass =
  | "context_overflow"
  | "tool_missing"
  | "max_turns"
  | "loop"
  | "rate_limited"
  | "auth_failed"
  | "no_worker"
  | "timeout"
  | "crash"
  | "unknown";

interface ClassPresentation {
  label: string;
  hint:  string;
  /** Catppuccin-aligned token. Different colours per class so the
   *  badge is scannable at a glance in a sprint list. */
  color: string;
  bg:    string;
}

export const FAILURE_CLASS_LABELS: Record<FailureClass, ClassPresentation> = {
  context_overflow: {
    label: "Context overflow",
    hint:  "Agent ran out of context window. Trim persona / .tp / skills, or move to a model with a larger context.",
    color: "#a78bfa",
    bg:    "rgba(167,139,250,0.15)",
  },
  tool_missing: {
    label: "Tool missing",
    hint:  "Agent called a tool that's not registered. Check the agent's allowed-tools list and MCP server configuration.",
    color: "#f59f00",
    bg:    "rgba(245,159,0,0.15)",
  },
  max_turns: {
    label: "Max turns",
    hint:  "Agent hit its turn limit before finishing. Raise max_turns on the agent or split the task into smaller sprints.",
    color: "#f5c542",
    bg:    "rgba(245,197,66,0.15)",
  },
  loop: {
    label: "Loop detected",
    hint:  "Agent repeated the same tool call 4+ times in a row — usually means it's stuck. Inspect the audit trail.",
    color: "#df8e1d",
    bg:    "rgba(223,142,29,0.15)",
  },
  rate_limited: {
    label: "Rate limited",
    hint:  "Provider rate-limit / 429. Retry usually succeeds after a short backoff; consider upgrading the provider plan.",
    color: "#5b9aff",
    bg:    "rgba(91,154,255,0.15)",
  },
  auth_failed: {
    label: "Auth failed",
    hint:  "Provider authentication failed (API key invalid, OAuth expired). Check Integrations → Providers.",
    color: "#e44b5f",
    bg:    "rgba(228,75,95,0.15)",
  },
  no_worker: {
    label: "No worker",
    hint:  "Trigger.dev accepted the run but no worker picked it up. In local mode, start `tp workers dev` and retry. In cloud mode, redeploy the worker.",
    color: "#f59f00",
    bg:    "rgba(245,159,0,0.18)",
  },
  timeout: {
    label: "Timeout",
    hint:  "CLI subprocess exceeded its timeout_secs budget. Default is 30 min; raise the per-agent override or retry — the partial audit was saved.",
    color: "#df8e1d",
    bg:    "rgba(223,142,29,0.15)",
  },
  crash: {
    label: "Crashed",
    hint:  "Worker hit an unhandled error. See failure_reason on the sprint and the worker logs for the stack.",
    color: "#e44b5f",
    bg:    "rgba(228,75,95,0.12)",
  },
  unknown: {
    label: "Unknown",
    hint:  "Sprint failed with no recognisable error string. Inspect the audit trail manually.",
    color: "var(--overlay0)",
    bg:    "var(--surface1)",
  },
};

/** Type guard so callers don't have to widen-then-narrow on every read. */
export function isFailureClass(v: unknown): v is FailureClass {
  return typeof v === "string" && v in FAILURE_CLASS_LABELS;
}
