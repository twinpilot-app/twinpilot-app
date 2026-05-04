/**
 * GET /api/projects/:id/sprints/:sprintId/review
 *
 * Returns everything the operator needs to audit what the agents in this
 * sprint received as input, after the sprint has run:
 *
 *   - Sprint metadata (intent, verdict, briefing, dispatch config)
 *   - Frozen .tp/ context files (sprints.context_snapshot, written by the
 *     worker at dispatch — see Phase 3 of Local+Git Excellence)
 *   - Per-agent runs with their effective configuration (model, cli,
 *     auth_mode, tools, status, cost) and a snippet of output
 *   - Approved memory entries that were loaded into MEMORY.md at dispatch
 *
 * Phase 3 v1: rebuilds context lazily (snapshot was captured at dispatch).
 * Future: capture per-agent persona + briefing snapshots so persona
 * edits after the fact don't change what we show as "what the agent saw".
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sprintId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId, sprintId } = await params;

    /* ── Membership ─────────────────────────────────────────────────── */
    const { data: project } = await sb
      .from("projects")
      .select("factory_id")
      .eq("id", projectId)
      .maybeSingle();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).maybeSingle();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    /* ── Sprint row ─────────────────────────────────────────────────── */
    const { data: sprint, error: sprintErr } = await sb
      .from("sprints")
      .select(`
        id, sprint_num, status, intent, briefing, repo_tag, commit_sha,
        config, outcome, context_snapshot, needs_human,
        failure_class, failure_reason,
        created_at, completed_at, trigger_run_id, composed_pipeline
      `)
      .eq("id", sprintId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (sprintErr) return NextResponse.json({ error: sprintErr.message }, { status: 500 });
    if (!sprint)   return NextResponse.json({ error: "Sprint not found" }, { status: 404 });

    /* ── Per-agent runs ─────────────────────────────────────────────── */
    const { data: runsRaw } = await sb
      .from("agent_runs")
      .select(`
        id, agent, squad, status, step, run_type,
        llm_model, tokens_in, tokens_out, cost_usd, output_size_bytes,
        started_at, finished_at, error, output_ref, output_content,
        metrics, parent_run_id, context_bytes
      `)
      .eq("sprint_id", sprintId)
      .order("step", { ascending: true })
      .order("started_at", { ascending: true });
    const runs = runsRaw ?? [];

    /* ── Approved memory entries that would be loaded at this sprint ─ */
    // Note: this returns the CURRENT approved set, not exactly what was
    // present at sprint dispatch (history reconstruction would need the
    // approved_at filter). For Phase 3 v1, current set is acceptable.
    const { data: memoryEntries } = await sb
      .from("project_memory_entries")
      .select("id, type, title, content, status, created_at, agent_slug, sprint_id")
      .eq("project_id", projectId)
      .eq("status", "approved")
      .order("created_at", { ascending: true });

    /* ── Per-step instruction overrides from the sprint config ──────── */
    // sprint.config can carry stepRouting (per-step CLI overrides) and
    // agentInstructions (per-agent text overrides). Surfacing these means
    // the operator knows whether a given step ran with custom routing.
    const cfg = (sprint.config ?? {}) as Record<string, unknown>;
    const stepRouting = cfg.stepRouting as Record<string, unknown> | undefined;
    const agentInstructions = cfg.agentInstructions as Record<string, unknown> | undefined;

    return NextResponse.json({
      sprint: {
        id: sprint.id,
        sprint_num: sprint.sprint_num,
        status: sprint.status,
        intent: sprint.intent,
        briefing: sprint.briefing,
        repo_tag: sprint.repo_tag,
        commit_sha: sprint.commit_sha,
        outcome: sprint.outcome,
        needs_human: sprint.needs_human,
        failure_class:  sprint.failure_class  ?? null,
        failure_reason: sprint.failure_reason ?? null,
        created_at: sprint.created_at,
        completed_at: sprint.completed_at,
        trigger_run_id: sprint.trigger_run_id,
        composed_pipeline: sprint.composed_pipeline,
      },
      context_snapshot: sprint.context_snapshot ?? null,
      step_routing: stepRouting ?? null,
      agent_instructions: agentInstructions ?? null,
      runs,
      approved_memory_entries: memoryEntries ?? [],
    });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
