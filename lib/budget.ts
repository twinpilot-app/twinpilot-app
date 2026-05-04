/**
 * Per-project soft budget brake.
 *
 * Shared between the dashboard endpoint (visibility) and the auto-drain
 * dispatcher (pre-flight enforcement). TwinPilot is explicitly NOT the
 * system of record — actual hard limits live at the provider's console.
 * This module just gives operators a soft circuit-breaker.
 *
 * Disabled by default (`budget.enabled !== true`). When enabled, we sum
 * cost_usd over the configured scope:
 *   - "api_only" → only metrics.auth_mode='api_key' runs (real $)
 *   - "all"      → everything, including subscription estimates
 *
 * Status:
 *   - "ok"   → no caps hit, no warning thresholds breached
 *   - "warn" → ≥80% of any cap → display banner, but dispatch continues
 *   - "halt" → ≥100% of any cap AND budget.action='halt' → block dispatch
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface BudgetConfig {
  enabled?:          boolean;
  scope?:            "api_only" | "all";
  monthly_usd_cap?:  number;
  daily_usd_cap?:    number;
  action?:           "warn" | "halt";
}

export interface BudgetStatus {
  enabled:           boolean;
  scope:             "api_only" | "all";
  action:            "warn" | "halt";
  month_total_usd:   number;
  day_total_usd:     number;
  monthly_cap:       number | null;
  daily_cap:         number | null;
  status:            "ok" | "warn" | "halt";
  reason:            string | null;
  /** % of the lowest binding cap. 0..100+, null when no caps configured. */
  pct_of_cap:        number | null;
}

const WARN_PCT = 0.8;

function startOfMonthUtc(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}
function startOfDayUtc(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export async function computeBudgetStatus(
  sb: SupabaseClient,
  projectId: string,
  budgetCfg: BudgetConfig | null | undefined,
): Promise<BudgetStatus> {
  const enabled = budgetCfg?.enabled === true;
  const scope: "api_only" | "all" = budgetCfg?.scope === "all" ? "all" : "api_only";
  const action: "warn" | "halt"   = budgetCfg?.action === "halt" ? "halt" : "warn";
  const monthlyCap = typeof budgetCfg?.monthly_usd_cap === "number" && budgetCfg.monthly_usd_cap > 0
    ? budgetCfg.monthly_usd_cap : null;
  const dailyCap = typeof budgetCfg?.daily_usd_cap === "number" && budgetCfg.daily_usd_cap > 0
    ? budgetCfg.daily_usd_cap : null;

  // Always compute the rollups — UI shows them even when disabled (operator
  // wants to know the current burn before flipping enabled=true).
  const monthStart = startOfMonthUtc();
  const dayStart   = startOfDayUtc();

  // Pull recent runs scoped to the current month. We need finished_at,
  // cost_usd, and metrics.auth_mode (for scope filtering).
  const { data: rowsRaw } = await sb
    .from("agent_runs")
    .select("cost_usd, finished_at, metrics, llm_model")
    .eq("project_id", projectId)
    .gte("finished_at", monthStart)
    .not("cost_usd", "is", null);
  const rows = (rowsRaw ?? []) as Array<{
    cost_usd: number | null;
    finished_at: string | null;
    metrics: { auth_mode?: "api_key" | "subscription"; cli?: string } | null;
    llm_model: string | null;
  }>;

  let monthTotal = 0;
  let dayTotal = 0;
  for (const r of rows) {
    const us = Number(r.cost_usd ?? 0);
    if (us <= 0) continue;

    // Scope filter: api_only excludes subscription rows. Heuristic for
    // legacy rows missing auth_mode mirrors the dashboard's logic.
    if (scope === "api_only") {
      const auth = r.metrics?.auth_mode;
      if (auth === "subscription") continue;
      if (!auth) {
        // Legacy: API path (no cli marker) with llm_model = real money;
        // CLI path with no auth_mode = assume subscription (skip).
        if (!(!r.metrics?.cli && r.llm_model)) continue;
      }
    }

    monthTotal += us;
    if (r.finished_at && r.finished_at >= dayStart) {
      dayTotal += us;
    }
  }

  // Round to cents to keep the UI tidy; storage stays at full precision.
  monthTotal = Math.round(monthTotal * 1_000_000) / 1_000_000;
  dayTotal   = Math.round(dayTotal   * 1_000_000) / 1_000_000;

  // Determine status.
  let status: "ok" | "warn" | "halt" = "ok";
  let reason: string | null = null;
  let pctOfCap: number | null = null;

  if (enabled) {
    const checks: Array<{ used: number; cap: number; label: string }> = [];
    if (monthlyCap !== null) checks.push({ used: monthTotal, cap: monthlyCap, label: "monthly" });
    if (dailyCap   !== null) checks.push({ used: dayTotal,   cap: dailyCap,   label: "daily" });

    for (const c of checks) {
      const pct = c.cap > 0 ? (c.used / c.cap) * 100 : 0;
      if (pctOfCap === null || pct > pctOfCap) pctOfCap = pct;
      if (c.used >= c.cap) {
        if (action === "halt") {
          status = "halt";
          reason = `${c.label} cap reached: $${c.used.toFixed(4)} of $${c.cap.toFixed(2)}`;
          break;
        }
        // action='warn' — first-cap-hit message wins; we never set "halt"
        // here, and 'warn' overwriting 'warn' is harmless.
        status = "warn";
        reason = `${c.label} cap reached (warn-only): $${c.used.toFixed(4)} of $${c.cap.toFixed(2)}`;
      } else if (c.used >= c.cap * WARN_PCT && status === "ok") {
        status = "warn";
        reason = `${c.label} budget at ${Math.round(pct)}%: $${c.used.toFixed(4)} of $${c.cap.toFixed(2)}`;
      }
    }
  }

  return {
    enabled,
    scope,
    action,
    month_total_usd: monthTotal,
    day_total_usd:   dayTotal,
    monthly_cap:     monthlyCap,
    daily_cap:       dailyCap,
    status,
    reason,
    pct_of_cap:      pctOfCap === null ? null : Math.round(pctOfCap),
  };
}
