/**
 * GET /api/projects/[id]/dashboard
 *
 * Server-side aggregation for the Twin Dashboard. One round-trip returns
 * everything the page needs: live status, health window, cost rollup,
 * backlog counts, and a sprint timeline. Clients should not stitch this
 * together themselves — projects with hundreds of sprints would N+1 the
 * frontend.
 *
 * Membership check mirrors the rest of /api/projects/[id]/* — service-role
 * client + manual tenant_members lookup.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { computeBudgetStatus, type BudgetConfig } from "@/lib/budget";

export const dynamic = "force-dynamic";

const HEALTH_WINDOW_DAYS = 30;
const TIMELINE_LIMIT     = 20;
const COST_BY_DAY_DAYS   = 14;
const STALE_DOING_HOURS  = 24;

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function getUser(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { user, sb };
}

type SprintRow = {
  id: string;
  sprint_num: number;
  status: string;
  intent: string | null;
  briefing: string | null;
  trigger_run_id: string | null;
  created_at: string;
  completed_at: string | null;
  needs_human: boolean;
  outcome: { intent?: string; verdict?: string; reason?: string; metrics?: Record<string, unknown> } | null;
  config: Record<string, unknown> | null;
  composed_pipeline: { source_sprint_id?: string } | null;
  /** BL-26 Phase 1 — populated when status='failed'. */
  failure_class: string | null;
};

type AgentRunRow = {
  sprint_id: string | null;
  agent: string | null;
  status: string;
  step: number | null;
  tokens_in:  number | null;
  tokens_out: number | null;
  cost_usd:   number | null;
  started_at:  string | null;
  finished_at: string | null;
  llm_model:  string | null;
  metrics: {
    cli?:       string;
    provider?:  string;
    model?:     string | null;
    wall_ms?:   number;
    auth_mode?: "api_key" | "subscription";
  } | null;
};

type BacklogRow = {
  id: string;
  title: string;
  status: string;
  updated_at: string;
  metadata: { tags?: string[]; sprint_history?: unknown[] } | null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId } = await params;

    /* ── Project + factory + membership ────────────────────────────── */
    const { data: project } = await sb
      .from("projects")
      .select(`
        id, name, slug, status, archived_at, locked, execution_mode, settings, budget,
        repo_url, working_destination_id, use_operator_git_auth,
        pipeline_id, discovery_pipeline_id, execution_pipeline_id,
        last_composed_pipeline_sprint_id, factory_id, intake_brief, prd_md,
        prd_status, prd_authored_at, prd_authored_by_sprint_id, prd_authored_by_agent,
        created_at, updated_at
      `)
      .eq("id", projectId)
      .maybeSingle();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb
      .from("factories").select("tenant_id, slug, name").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).maybeSingle();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    /* ── Sprints (single fetch, slice for different views) ─────────── */
    // Pull enough to cover health window + timeline. Cap at 200 to avoid
    // pulling thousands on long-running autonomous projects.
    const { data: sprintsRaw } = await sb
      .from("sprints")
      .select(`
        id, sprint_num, status, intent, briefing, trigger_run_id,
        created_at, completed_at, needs_human, outcome, config, composed_pipeline,
        failure_class
      `)
      .eq("project_id", projectId)
      .order("sprint_num", { ascending: false })
      .limit(200);
    const sprints = (sprintsRaw ?? []) as SprintRow[];

    /* ── Agent runs for cost rollup (scoped to last 200 sprints) ───── */
    const sprintIds = sprints.map((s) => s.id);
    let runs: AgentRunRow[] = [];
    if (sprintIds.length > 0) {
      const { data: runsRaw } = await sb
        .from("agent_runs")
        .select("sprint_id, agent, status, step, tokens_in, tokens_out, cost_usd, started_at, finished_at, llm_model, metrics")
        .in("sprint_id", sprintIds);
      runs = (runsRaw ?? []) as AgentRunRow[];
    }

    /* ── Backlog ────────────────────────────────────────────────────── */
    const { data: backlogRaw } = await sb
      .from("project_backlog_items")
      .select("id, title, status, updated_at, metadata")
      .eq("project_id", projectId);
    const backlog = (backlogRaw ?? []) as BacklogRow[];

    /* ════════════════════════════════════════════════════════════════
     * NOW — current sprint, halt reason, paused flags
     * ════════════════════════════════════════════════════════════════ */
    // Sprint-side "active" means anything that isn't terminal. The
    // worker uses queued/running/waiting; pending_save and paused are
    // human-gate states — count them as active for dashboard purposes.
    const ACTIVE = new Set(["queued", "running", "waiting", "paused", "pending_save"]);
    const currentSprint = sprints.find((s) => ACTIVE.has(s.status)) ?? null;
    const settings = (project.settings ?? {}) as Record<string, unknown>;
    const autoDrainPaused = settings.auto_drain_pause_requested === true;
    const awaitingApproval = sprints.some((s) => s.status === "awaiting_approval");

    let haltReason: string | null = null;
    if (project.archived_at) haltReason = "Project archived";
    else if (project.status === "locked") haltReason = "Project locked";
    else if (currentSprint?.status === "paused") haltReason = "Sprint paused";
    else if (autoDrainPaused) haltReason = "Auto-drain paused";
    else if (awaitingApproval) haltReason = "Awaiting approval";

    const now = {
      current_sprint: currentSprint && {
        id: currentSprint.id,
        sprint_num: currentSprint.sprint_num,
        status: currentSprint.status,
        intent: currentSprint.intent,
        started_at: currentSprint.created_at,
        briefing: currentSprint.briefing,
      },
      project_status: project.status as string,
      execution_mode: project.execution_mode as string,
      paused: autoDrainPaused,
      awaiting_approval: awaitingApproval,
      halt_reason: haltReason,
    };

    /* ════════════════════════════════════════════════════════════════
     * HEALTH — verdicts in window, success rate, streaks, needs_human
     * ════════════════════════════════════════════════════════════════ */
    const windowMs = HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const completedInWindow = sprints.filter((s) =>
      s.completed_at && new Date(s.completed_at).getTime() >= cutoff,
    );

    let successCount = 0;
    let totalCount = 0;
    for (const s of completedInWindow) {
      const verdict = s.outcome?.verdict;
      if (!verdict) continue;
      totalCount++;
      if (verdict === "success") successCount++;
    }
    const successRate = totalCount > 0 ? successCount / totalCount : null;

    // Streaks computed over the most-recent completed sprints (any age).
    const completedDesc = sprints.filter((s) => s.completed_at);
    let consecutiveFailures = 0;
    for (const s of completedDesc) {
      const v = s.outcome?.verdict;
      if (v === "failed") consecutiveFailures++;
      else break;
    }
    let consecutiveNoOutput = 0;
    for (const s of completedDesc) {
      const v = s.outcome?.verdict;
      if (v === "no-output") consecutiveNoOutput++;
      else break;
    }

    const needsHumanCount = sprints.filter((s) => s.needs_human).length;
    const recentVerdicts = sprints.slice(0, 10).map((s) => ({
      sprint_num: s.sprint_num,
      verdict: s.outcome?.verdict ?? null,
      intent: s.outcome?.intent ?? s.intent ?? null,
      completed_at: s.completed_at,
      needs_human: s.needs_human,
      failure_class: s.failure_class ?? null,
    }));

    // BL-26 Phase 1 — failure-class breakdown for the health window.
    // Powers a small "Why are sprints failing?" panel: counts per class
    // over the same lookback as success_rate.
    const failureBreakdown: Record<string, number> = {};
    for (const s of completedInWindow) {
      if (s.status !== "failed" || !s.failure_class) continue;
      failureBreakdown[s.failure_class] = (failureBreakdown[s.failure_class] ?? 0) + 1;
    }

    const health = {
      success_rate: successRate,
      window_days: HEALTH_WINDOW_DAYS,
      window_total: totalCount,
      consecutive_failures: consecutiveFailures,
      consecutive_no_output: consecutiveNoOutput,
      needs_human_count: needsHumanCount,
      recent: recentVerdicts,
      failure_breakdown: failureBreakdown,
    };

    /* ════════════════════════════════════════════════════════════════
     * COST — totals, by-day, by-sprint
     * ════════════════════════════════════════════════════════════════ */
    let tokensInTotal = 0;
    let tokensOutTotal = 0;
    let usdTotal = 0;
    let usdReal = 0;        // sum of cost_usd where auth_mode='api_key' (actual money to providers)
    let usdEstimated = 0;   // sum of cost_usd where auth_mode='subscription' (claude-code Max etc — fictional billing)
    let runsReal = 0;
    let runsSubscription = 0;
    let runsUnknownAuth = 0;
    const usdBySprint = new Map<string, { tokens_in: number; tokens_out: number; usd: number; agent_count: number }>();
    const usdByDay = new Map<string, { tokens_in: number; tokens_out: number; usd: number; sprint_ids: Set<string> }>();
    type ByModelEntry = {
      key:        string;
      kind:       "cli" | "api" | "unknown";
      cli:        string | null;
      provider:   string | null;
      model:      string | null;
      runs:       number;
      tokens_in:  number;
      tokens_out: number;
      usd:        number;
      inferred:   boolean;
    };
    const byModel = new Map<string, ByModelEntry>();

    // Cross-tab agent × runtime — phase 2 of BL-26 telemetry. Surfaces
    // "fullstack-developer on opus = $X over N sprints" so the operator
    // can decide whether the model upgrade is paying for itself per role.
    type AgentRuntimeEntry = {
      key:        string;
      agent:      string;
      runtime:    string;       // e.g. "cli:claude-code:opus" / "api:claude-sonnet-4-6"
      kind:       "cli" | "api" | "unknown";
      cli:        string | null;
      model:      string | null;
      runs:       number;
      sprint_ids: Set<string>;
      tokens_in:  number;
      tokens_out: number;
      usd:        number;
      inferred:   boolean;
    };
    const byAgentRuntime = new Map<string, AgentRuntimeEntry>();
    const dayCutoff = Date.now() - COST_BY_DAY_DAYS * 24 * 60 * 60 * 1000;

    for (const r of runs) {
      const ti = r.tokens_in  ?? 0;
      const to = r.tokens_out ?? 0;
      const us = Number(r.cost_usd ?? 0);
      tokensInTotal  += ti;
      tokensOutTotal += to;
      usdTotal       += us;

      // auth_mode classification — drives the real vs estimated split.
      // Falls back to a heuristic for legacy rows missing metrics.auth_mode:
      // - llm_model set + no metrics.cli  → likely API path (real money)
      // - metrics.cli set + no auth_mode  → unknown (legacy CLI, count separately)
      const authMode = r.metrics?.auth_mode;
      if (authMode === "api_key") {
        usdReal += us;
        runsReal++;
      } else if (authMode === "subscription") {
        usdEstimated += us;
        runsSubscription++;
      } else {
        // Heuristic: API path (no cli marker) defaults to real money,
        // CLI path with no auth_mode defaults to subscription (safer
        // assumption — claude-code Max is the dominant case).
        if (!r.metrics?.cli && r.llm_model) {
          usdReal += us;
          runsReal++;
        } else {
          usdEstimated += us;
          runsUnknownAuth++;
        }
      }

      if (r.sprint_id) {
        const cur = usdBySprint.get(r.sprint_id) ?? { tokens_in: 0, tokens_out: 0, usd: 0, agent_count: 0 };
        cur.tokens_in  += ti;
        cur.tokens_out += to;
        cur.usd        += us;
        cur.agent_count++;
        usdBySprint.set(r.sprint_id, cur);
      }

      if (r.finished_at) {
        const t = new Date(r.finished_at).getTime();
        if (t >= dayCutoff) {
          const day = r.finished_at.slice(0, 10); // YYYY-MM-DD
          const cur = usdByDay.get(day) ?? { tokens_in: 0, tokens_out: 0, usd: 0, sprint_ids: new Set<string>() };
          cur.tokens_in  += ti;
          cur.tokens_out += to;
          cur.usd        += us;
          if (r.sprint_id) cur.sprint_ids.add(r.sprint_id);
          usdByDay.set(day, cur);
        }
      }

      /* by-model bucket — three signals, in priority order:
       *   1. metrics.cli (worker patch from this commit forward) — definitive.
       *   2. llm_model + metrics.provider (API path, agent-runtime.ts) —
       *      definitive.
       *   3. Heuristic for legacy rows: llm_model is null AND status='done'
       *      AND (any tokens or cost recorded) → almost certainly claude-code,
       *      because it's the only CLI that emits a parseable result with
       *      cost/tokens today (codex/gemini stay null on tokens). When the
       *      run is on a Claude subscription (Max plan), cost_usd may be 0
       *      but tokens_in/out are still populated by the JSONL stream parse.
       *   4. Anything else → "unknown".
       */
      let cli      = r.metrics?.cli      ?? null;
      const provider = r.metrics?.provider ?? null;
      let model    = r.metrics?.model    ?? r.llm_model ?? null;
      let inferred = false;
      if (!cli && !model && r.status === "done" && (ti > 0 || to > 0 || us > 0)) {
        cli = "claude-code";
        inferred = true;
      }
      const kind: ByModelEntry["kind"] = cli ? "cli" : (model || provider) ? "api" : "unknown";
      const key = cli ? `cli:${cli}:${model ?? "auto"}${inferred ? ":~" : ""}` : model ? `api:${model}` : "unknown";
      const entry = byModel.get(key) ?? { key, kind, cli, provider, model, runs: 0, tokens_in: 0, tokens_out: 0, usd: 0, inferred };
      entry.runs++;
      entry.tokens_in  += ti;
      entry.tokens_out += to;
      entry.usd        += us;
      byModel.set(key, entry);

      // Cross-tab agent × runtime entry. Same kind/cli/model/inferred
      // classification — only difference is the per-agent scoping and
      // distinct-sprint counting (drives the "over N sprints" datum).
      const agentForRow = r.agent ?? "unknown";
      const arKey = `${agentForRow}::${key}`;
      const arEntry = byAgentRuntime.get(arKey) ?? {
        key: arKey, agent: agentForRow, runtime: key, kind, cli, model,
        runs: 0, sprint_ids: new Set<string>(),
        tokens_in: 0, tokens_out: 0, usd: 0, inferred,
      };
      arEntry.runs++;
      arEntry.tokens_in  += ti;
      arEntry.tokens_out += to;
      arEntry.usd        += us;
      if (r.sprint_id) arEntry.sprint_ids.add(r.sprint_id);
      byAgentRuntime.set(arKey, arEntry);
    }

    const byDay = Array.from(usdByDay.entries())
      .map(([day, v]) => ({ day, tokens_in: v.tokens_in, tokens_out: v.tokens_out, usd: round6(v.usd), sprint_count: v.sprint_ids.size }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const bySprintRecent = sprints.slice(0, 10).map((s) => {
      const cur = usdBySprint.get(s.id) ?? { tokens_in: 0, tokens_out: 0, usd: 0, agent_count: 0 };
      return {
        sprint_num: s.sprint_num,
        tokens_in:  cur.tokens_in,
        tokens_out: cur.tokens_out,
        usd: round6(cur.usd),
        agent_count: cur.agent_count,
      };
    });

    const byModelArr = Array.from(byModel.values())
      .map((e) => ({ ...e, usd: round6(e.usd) }))
      .sort((a, b) => b.usd - a.usd || b.runs - a.runs);

    /* ════════════════════════════════════════════════════════════════
     * AGENTS — same data, grouped by agent name with details
     * ════════════════════════════════════════════════════════════════ */
    type AgentEntry = {
      agent:           string;
      runs:            number;
      runs_failed:     number;
      runs_discovery:  number;
      runs_execution:  number;
      usd_discovery:   number;
      usd_execution:   number;
      tokens_in:       number;
      tokens_out:      number;
      usd:             number;
      total_wall_ms:   number;   // sum of finished_at - started_at across runs
      counted_wall:    number;   // # runs with valid duration (for avg)
      sprint_ids:      Set<string>;
      runtimes:        Map<string, { runs: number; usd: number }>;  // CLI/API combo → counts
      last_run:        string | null;  // ISO timestamp of latest run (started_at or finished_at)
    };
    const agents = new Map<string, AgentEntry>();

    // Build sprint_id → intent map so we can split agent runs by intent
    // without re-querying. Uses outcome.intent first (worker-recorded),
    // falls back to sprints.intent column.
    type IntentLabel = "discovery" | "planning" | "execution" | "review" | null;
    const sprintIntent = new Map<string, IntentLabel>();
    for (const s of sprints) {
      const raw = (s.outcome?.intent ?? s.intent ?? null) as string | null;
      const intent: IntentLabel =
        raw === "discovery" || raw === "planning" || raw === "execution" || raw === "review"
          ? raw
          : null;
      sprintIntent.set(s.id, intent);
    }

    for (const r of runs) {
      const agent = r.agent;
      if (!agent) continue;
      const cur = agents.get(agent) ?? {
        agent,
        runs: 0, runs_failed: 0,
        runs_discovery: 0, runs_execution: 0,
        usd_discovery: 0, usd_execution: 0,
        tokens_in: 0, tokens_out: 0, usd: 0,
        total_wall_ms: 0, counted_wall: 0,
        sprint_ids: new Set<string>(),
        runtimes: new Map(),
        last_run: null,
      };
      cur.runs++;
      if (r.status === "failed" || r.status === "cancelled") cur.runs_failed++;
      const usForRun = Number(r.cost_usd ?? 0);
      cur.tokens_in  += r.tokens_in  ?? 0;
      cur.tokens_out += r.tokens_out ?? 0;
      cur.usd        += usForRun;
      if (r.sprint_id) cur.sprint_ids.add(r.sprint_id);

      const intent = r.sprint_id ? sprintIntent.get(r.sprint_id) ?? null : null;
      if (intent === "discovery") {
        cur.runs_discovery++;
        cur.usd_discovery += usForRun;
      } else if (intent === "execution") {
        cur.runs_execution++;
        cur.usd_execution += usForRun;
      }

      // Duration: prefer metrics.wall_ms (worker-recorded), fall back to
      // finished_at - started_at. Skip rows missing both.
      const wall = r.metrics?.wall_ms
        ?? (r.started_at && r.finished_at
          ? Math.max(0, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime())
          : 0);
      if (wall > 0) {
        cur.total_wall_ms += wall;
        cur.counted_wall++;
      }

      // Runtime label: same priority chain as by_model, but stringified
      const cli      = r.metrics?.cli      ?? null;
      const model    = r.metrics?.model    ?? r.llm_model ?? null;
      let label: string;
      if (cli) {
        label = `cli:${cli}${model ? `:${model}` : ""}`;
      } else if (model) {
        label = `api:${model}`;
      } else if (r.status === "done" && ((r.tokens_in ?? 0) > 0 || (r.tokens_out ?? 0) > 0 || Number(r.cost_usd ?? 0) > 0)) {
        label = `cli:claude-code:~`;  // inferred (~ marker, see by_model)
      } else {
        label = "unknown";
      }
      const rt = cur.runtimes.get(label) ?? { runs: 0, usd: 0 };
      rt.runs++;
      rt.usd += Number(r.cost_usd ?? 0);
      cur.runtimes.set(label, rt);

      // Last-seen tracking — use finished_at if present, else started_at
      const ts = r.finished_at ?? r.started_at;
      if (ts && (!cur.last_run || ts > cur.last_run)) cur.last_run = ts;

      agents.set(agent, cur);
    }

    const byAgent = Array.from(agents.values())
      .map((a) => ({
        agent:          a.agent,
        runs:           a.runs,
        runs_failed:    a.runs_failed,
        runs_discovery: a.runs_discovery,
        runs_execution: a.runs_execution,
        usd_discovery:  round6(a.usd_discovery),
        usd_execution:  round6(a.usd_execution),
        tokens_in:      a.tokens_in,
        tokens_out:     a.tokens_out,
        usd:            round6(a.usd),
        avg_wall_ms:    a.counted_wall > 0 ? Math.round(a.total_wall_ms / a.counted_wall) : null,
        total_wall_ms:  a.total_wall_ms,
        sprints:        a.sprint_ids.size,
        last_run:       a.last_run,
        runtimes:       Array.from(a.runtimes.entries())
                         .map(([key, v]) => ({ key, runs: v.runs, usd: round6(v.usd) }))
                         .sort((x, y) => y.runs - x.runs),
      }))
      .sort((a, b) => b.usd - a.usd || b.runs - a.runs);

    const byAgentRuntimeArr = Array.from(byAgentRuntime.values())
      .map((e) => ({
        agent:       e.agent,
        runtime:     e.runtime,
        kind:        e.kind,
        cli:         e.cli,
        model:       e.model,
        runs:        e.runs,
        sprints:     e.sprint_ids.size,
        tokens_in:   e.tokens_in,
        tokens_out:  e.tokens_out,
        usd:         round6(e.usd),
        usd_per_run: e.runs > 0 ? round6(e.usd / e.runs) : 0,
        inferred:    e.inferred,
      }))
      .sort((a, b) => b.usd - a.usd || b.runs - a.runs);

    const cost = {
      tokens_in_total:  tokensInTotal,
      tokens_out_total: tokensOutTotal,
      usd_total:        round6(usdTotal),
      usd_real:         round6(usdReal),
      usd_estimated:    round6(usdEstimated),
      runs_real:        runsReal,
      runs_subscription: runsSubscription,
      runs_unknown_auth: runsUnknownAuth,
      by_day:           byDay,
      by_sprint_recent: bySprintRecent,
      by_model:         byModelArr,
      by_agent_model:   byAgentRuntimeArr,
    };

    /* ════════════════════════════════════════════════════════════════
     * BACKLOG — column counts, by-tag, stale doing
     * ════════════════════════════════════════════════════════════════ */
    const backlogCounts = { todo: 0, doing: 0, done: 0, cancelled: 0 } as Record<string, number>;
    const tagBuckets = new Map<string, { todo: number; doing: number; done: number; cancelled: number }>();
    const staleDoing: { id: string; title: string; since: string }[] = [];
    const staleCutoff = Date.now() - STALE_DOING_HOURS * 60 * 60 * 1000;

    for (const it of backlog) {
      const status = it.status as string;
      if (status in backlogCounts) backlogCounts[status]++;

      const tags = (it.metadata?.tags ?? []) as string[];
      for (const tag of tags) {
        const cur = tagBuckets.get(tag) ?? { todo: 0, doing: 0, done: 0, cancelled: 0 };
        if (status in cur) (cur as Record<string, number>)[status]++;
        tagBuckets.set(tag, cur);
      }

      if (status === "doing" && it.updated_at && new Date(it.updated_at).getTime() < staleCutoff) {
        staleDoing.push({ id: it.id, title: it.title, since: it.updated_at });
      }
    }

    const byTag = Array.from(tagBuckets.entries())
      .map(([tag, v]) => ({ tag, ...v, total: v.todo + v.doing + v.done + v.cancelled }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12);

    // Latest review marker — proves a review-style agent ran its protocol
    // recently and surfaces what it decided. Drives the "Last reviewed"
    // line on the BacklogPanel; absence is itself a signal worth showing.
    const { data: lastMarkerRow } = await sb
      .from("project_review_markers")
      .select("agent_slug, action, summary, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastReviewMarker = lastMarkerRow ? {
      agent_slug: lastMarkerRow.agent_slug as string,
      action:     lastMarkerRow.action     as string,
      summary:    lastMarkerRow.summary    as string,
      created_at: lastMarkerRow.created_at as string,
    } : null;

    const backlogSummary = {
      todo:      backlogCounts.todo,
      doing:     backlogCounts.doing,
      done:      backlogCounts.done,
      cancelled: backlogCounts.cancelled,
      total:     backlog.length,
      by_tag:    byTag,
      stale_doing: staleDoing,
      last_review_marker: lastReviewMarker,
    };

    /* ════════════════════════════════════════════════════════════════
     * TIMELINE — last N sprints with rollup
     * ════════════════════════════════════════════════════════════════ */
    const timeline = sprints.slice(0, TIMELINE_LIMIT).map((s) => {
      const c = usdBySprint.get(s.id);
      const cfg = (s.config ?? {}) as Record<string, unknown>;
      const outcomeObj = (s.outcome as Record<string, unknown> | null) ?? null;
      const pendingPush = outcomeObj?.pending_push ?? null;
      // auto_acknowledged signals the sprint dispatched with auto_close on
      // and the failure was pre-accepted — UI suppresses the finalize bar.
      const autoAcknowledged = !!outcomeObj?.auto_acknowledged;
      return {
        id: s.id,
        sprint_num: s.sprint_num,
        status: s.status,
        intent: s.outcome?.intent ?? s.intent ?? null,
        verdict: s.outcome?.verdict ?? null,
        reason: s.outcome?.reason ?? null,
        started_at: s.created_at,
        completed_at: s.completed_at,
        briefing: s.briefing ? truncate(s.briefing, 140) : null,
        usd: c ? round6(c.usd) : 0,
        agent_count: c?.agent_count ?? 0,
        tokens_in:  c?.tokens_in  ?? 0,
        tokens_out: c?.tokens_out ?? 0,
        needs_human: s.needs_human,
        auto_composed: !!s.composed_pipeline,
        auto_acknowledged: autoAcknowledged,
        pending_push: pendingPush,
        trigger_source: (cfg.trigger_source as string) ?? null,
      };
    });

    const budgetStatus = await computeBudgetStatus(
      sb,
      projectId,
      (project.budget ?? {}) as BudgetConfig,
    );

    /* ════════════════════════════════════════════════════════════════
     * MEMORY — counts of proposed/approved entries for the panel
     * ════════════════════════════════════════════════════════════════ */
    const { data: memoryRowsForCounts } = await sb
      .from("project_memory_entries")
      .select("status, type")
      .eq("project_id", projectId);
    const memoryByStatus: Record<string, number> = { proposed: 0, approved: 0, rejected: 0, archived: 0 };
    const approvedByType: Record<string, number> = { decision: 0, convention: 0, gotcha: 0, dependency: 0 };
    for (const r of memoryRowsForCounts ?? []) {
      const s = r.status as string;
      const t = r.type as string;
      if (s in memoryByStatus) memoryByStatus[s]++;
      if (s === "approved" && t in approvedByType) approvedByType[t]++;
    }
    const memorySummary = {
      proposed_count:  memoryByStatus.proposed,
      approved_count:  memoryByStatus.approved,
      rejected_count:  memoryByStatus.rejected,
      archived_count:  memoryByStatus.archived,
      approved_by_type: approvedByType,
    };

    // ── PRD summary ─────────────────────────────────────────────────────
    // Slice 1 of Discovery / Product-Manager. Surfaces the PRD's status
    // + authoring trail without dumping the full body — the dashboard
    // shows an excerpt and a link to full view in Project Settings.
    const prdMdRaw = (project.prd_md as string | null) ?? "";
    const prdMd    = prdMdRaw.trim();
    let prdAuthoredBySprint: number | null = null;
    if (project.prd_authored_by_sprint_id) {
      const { data: prdSprint } = await sb
        .from("sprints").select("sprint_num")
        .eq("id", project.prd_authored_by_sprint_id as string).maybeSingle();
      prdAuthoredBySprint = (prdSprint?.sprint_num as number | null) ?? null;
    }
    const prdSummary = {
      has_content:           prdMd.length > 0,
      length_chars:          prdMd.length,
      status:                (project.prd_status as string | null) ?? null,
      authored_at:           (project.prd_authored_at as string | null) ?? null,
      authored_by_agent:     (project.prd_authored_by_agent as string | null) ?? null,
      authored_by_sprint:    prdAuthoredBySprint,
      excerpt:               prdMd.length > 0
        ? prdMd.slice(0, 280) + (prdMd.length > 280 ? "…" : "")
        : null,
    };

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        status: project.status,
        locked: project.locked,
        execution_mode: project.execution_mode,
        settings: project.settings,
        factory: { id: project.factory_id, slug: factory.slug, name: factory.name },
      },
      now,
      health,
      cost,
      budget: budgetStatus,
      memory: memorySummary,
      agents: byAgent,
      backlog: backlogSummary,
      prd: prdSummary,
      timeline,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

function round6(n: number): number { return Math.round(n * 1_000_000) / 1_000_000; }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
