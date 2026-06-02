/**
 * GET /api/projects/[id]/sprints/[sprintId]/tool-usage
 *
 * Per-agent rollup of MCP + native tool calls for one sprint. Aggregates
 * the raw `events.jsonl` written by each agent's claude-code run during
 * the sprint, returning typed counts so the operator can answer "which
 * tools did agent X actually call?" without grepping the workdir.
 *
 * Each agent in the sprint writes one events.jsonl file. The path differs
 * by orchestration mode (same routing as cli-executor.ts):
 *
 *   local-git: {workdir}/.tp/audit/{agentSlug}/events.jsonl
 *   local:     {localBase}/TwinPilotProjects/.../staging/sprint-N/_audit/{agentSlug}/events.jsonl
 *   cloud:     bucket → same suffix under TwinPilotProjects/.../staging/sprint-N/_audit/{agentSlug}/events.jsonl
 *
 * For each file we parse `assistant` events and extract `tool_use`
 * blocks; tool names starting with `mcp__` are categorised as MCP,
 * everything else as native (Read / Write / Edit / Bash / Glob /
 * Grep / WebFetch / Task / etc).
 *
 * Auth: Bearer {supabase access_token}.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { TP_BUCKET, sprintPath, localSprintPath, localProjectRoot, isWithinBase } from "@/lib/paths";

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

interface ToolCount { calls: number }
interface AgentRollup {
  mcp:    Record<string, ToolCount>;
  native: Record<string, ToolCount>;
  /** Sum across mcp + native, computed once for the response. */
  total:  number;
  /** Set when this agent's events.jsonl couldn't be loaded or parsed.
   *  Surfaces the file as "no signal" instead of "agent called nothing". */
  error?: string;
}

/**
 * Parse a Claude Code stream-json line by line. Yields tool names from
 * every `assistant` event's `tool_use` content blocks. Malformed lines
 * are skipped; the caller decides whether silence means "no tools" or
 * "parse failed" via the side-channel error.
 */
function extractToolCallsFromJsonl(jsonl: string): string[] {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type !== "assistant") continue;
      const msg = event.message as { content?: unknown[] } | undefined;
      for (const block of msg?.content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use" && typeof b.name === "string") out.push(b.name);
      }
    } catch { /* skip malformed line */ }
  }
  return out;
}

function categoriseToolCalls(toolNames: string[]): AgentRollup {
  const mcp:    Record<string, ToolCount> = {};
  const native: Record<string, ToolCount> = {};
  for (const name of toolNames) {
    const bucket = name.startsWith("mcp__") ? mcp : native;
    if (!bucket[name]) bucket[name] = { calls: 0 };
    bucket[name].calls += 1;
  }
  return { mcp, native, total: toolNames.length };
}

/**
 * Read events.jsonl from one of the candidate paths the worker may have
 * written. Returns null when no file exists at any candidate; callers
 * treat that as "agent didn't produce trace files" (a real smell, not
 * an aggregator error).
 */
function readLocalEventsJsonl(candidates: string[], localBase: string | undefined): string | null {
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    if (localBase && !isWithinBase(resolve(p), localBase)) continue;
    try {
      return readFileSync(p, "utf-8");
    } catch { /* unreadable, try next */ }
  }
  return null;
}

async function readBucketEventsJsonl(
  tenantSb: ReturnType<typeof serviceClient>,
  bucketPath: string,
): Promise<string | null> {
  try {
    const { data, error } = await tenantSb.storage.from(TP_BUCKET).download(bucketPath);
    if (error || !data) return null;
    return await data.text();
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sprintId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId, sprintId } = await params;

    // ── Auth ──────────────────────────────────────────────────
    const { data: project } = await sb
      .from("projects")
      .select("slug, factory_id, settings")
      .eq("id", projectId)
      .single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb
      .from("factories").select("tenant_id, slug").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data: tenant } = await sb.from("tenants").select("slug").eq("id", factory.tenant_id).single();

    const projectSlug  = project.slug as string;
    const tenantSlug   = tenant?.slug as string | undefined;
    const factorySlug  = factory.slug as string;
    const settings     = (project.settings ?? {}) as Record<string, unknown>;
    const cliConfig    = (settings.cli_agents ?? {}) as Record<string, unknown>;

    // ── Sprint + agents ───────────────────────────────────────
    const { data: sprint } = await sb
      .from("sprints")
      .select("id, sprint_num, status, config")
      .eq("id", sprintId)
      .eq("project_id", projectId)
      .single();
    if (!sprint) return NextResponse.json({ error: "Sprint not found" }, { status: 404 });

    const sprintConfig = (sprint.config ?? {}) as Record<string, unknown>;
    const sprintNum = sprint.sprint_num as number;

    // Tri-modal: prefer orchestration_mode from the sprint config when
    // present (set per-sprint), fall back to project settings, then to
    // the legacy mode field for older rows.
    const orchestrationMode =
      (sprintConfig.orchestration_mode as string | undefined)
      ?? (sprintConfig.mode as string | undefined)
      ?? (cliConfig.orchestration_mode as string | undefined)
      ?? "local";
    const isGitMode = orchestrationMode === "local-git";

    // Resolve localBase the same way files-route does — sprint config first,
    // then project settings, then tenant integrations (legacy fallback).
    let localBase = sprintConfig.localBasePath as string | undefined
      ?? cliConfig.local_base_path as string | undefined;
    if (!localBase) {
      const { data: storageInts } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", factory.tenant_id)
        .eq("service_id", "storage");
      for (const row of storageInts ?? []) {
        try {
          const cfg = JSON.parse(row.secret_value as string) as { type?: string; basePath?: string };
          if (cfg.type === "local" && cfg.basePath) { localBase = cfg.basePath; break; }
        } catch { /* ignore */ }
      }
    }

    // ── Agents involved in this sprint ────────────────────────
    const { data: runs } = await sb
      .from("agent_runs")
      .select("agent, status")
      .eq("sprint_id", sprintId);

    // De-duplicate; an agent that ran twice (rerun, retry) still has one
    // events.jsonl on disk because each run overwrites the prior file.
    // We surface the union of agents that appear in agent_runs.
    const agents = Array.from(new Set((runs ?? []).map((r) => r.agent as string).filter(Boolean)));

    // ── Resolve tenant Supabase for cloud reads (if applicable) ────
    let tenantSb: ReturnType<typeof serviceClient> | null = null;
    if (orchestrationMode === "cloud" && tenantSlug) {
      const { data: storageInts } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", factory.tenant_id)
        .eq("service_id", "storage");
      let tenantUrl: string | null = null;
      let tenantKey: string | null = null;
      for (const row of storageInts ?? []) {
        try {
          const cfg = JSON.parse(row.secret_value as string) as { type?: string; url?: string; key?: string };
          if (cfg.type === "supabase" && cfg.url && cfg.key) {
            tenantUrl = cfg.url; tenantKey = cfg.key; break;
          }
        } catch { /* ignore */ }
      }
      if (tenantUrl && tenantKey) {
        tenantSb = createClient(tenantUrl, tenantKey, { auth: { persistSession: false } });
      }
    }

    // ── Walk every agent, read + parse its events.jsonl ───────
    const byAgent: Record<string, AgentRollup> = {};
    const warnings: string[] = [];

    for (const agent of agents) {
      let jsonl: string | null = null;

      if (tenantSlug && factorySlug) {
        if (isGitMode) {
          // local-git: events.jsonl lives in .tp/audit/{agent}/ inside the
          // project workdir. The workdir is `{localBase}/TwinPilotProjects/
          // {tenantSlug}/{factorySlug}/{projectSlug}` — same prefix
          // localSprintPath builds, minus the staging/sprint-N tail.
          if (localBase) {
            const workdir = localProjectRoot(localBase, tenantSlug, factorySlug, projectSlug);
            const candidate = join(workdir, ".tp", "audit", agent, "events.jsonl");
            jsonl = readLocalEventsJsonl([candidate], localBase);
          }
        } else if (orchestrationMode === "local") {
          if (localBase) {
            const stagingBase = localSprintPath(localBase, tenantSlug, factorySlug, projectSlug, sprintNum);
            const candidate = join(stagingBase, "_audit", agent, "events.jsonl");
            jsonl = readLocalEventsJsonl([candidate], localBase);
          }
        } else if (orchestrationMode === "cloud" && tenantSb) {
          const basePrefix = sprintPath(tenantSlug, factorySlug, projectSlug, sprintNum);
          const bucketPath = `${basePrefix}/_audit/${agent}/events.jsonl`;
          jsonl = await readBucketEventsJsonl(tenantSb, bucketPath);
        }
      }

      if (jsonl === null) {
        byAgent[agent] = { mcp: {}, native: {}, total: 0, error: "events.jsonl not found" };
        continue;
      }

      try {
        const tools = extractToolCallsFromJsonl(jsonl);
        byAgent[agent] = categoriseToolCalls(tools);
      } catch (e) {
        byAgent[agent] = { mcp: {}, native: {}, total: 0, error: (e as Error).message ?? "parse failed" };
      }
    }

    // ── Totals + smell signals ────────────────────────────────
    let mcpTotal = 0, nativeTotal = 0;
    const mostUsed: { tool: string; agent: string; calls: number }[] = [];
    const agentsWithNoMcp: string[] = [];

    for (const [agent, roll] of Object.entries(byAgent)) {
      const mcpCount    = Object.values(roll.mcp).reduce((s, t) => s + t.calls, 0);
      const nativeCount = Object.values(roll.native).reduce((s, t) => s + t.calls, 0);
      mcpTotal    += mcpCount;
      nativeTotal += nativeCount;
      if (mcpCount === 0 && roll.total > 0) agentsWithNoMcp.push(agent);
      for (const [tool, t] of Object.entries(roll.mcp))    mostUsed.push({ tool, agent, calls: t.calls });
      for (const [tool, t] of Object.entries(roll.native)) mostUsed.push({ tool, agent, calls: t.calls });
    }
    mostUsed.sort((a, b) => b.calls - a.calls);

    if (agents.length === 0) warnings.push("No agent runs recorded for this sprint.");
    if (orchestrationMode === "cloud" && !tenantSb) {
      warnings.push("Cloud mode: tenant storage credentials unavailable; events.jsonl rows could not be read.");
    }
    if (!localBase && (orchestrationMode === "local" || isGitMode)) {
      warnings.push("Local mode: no local base path resolved; events.jsonl rows could not be read.");
    }

    return NextResponse.json({
      sprintId,
      sprintNum,
      orchestrationMode,
      byAgent,
      totals: {
        mcp_calls:           mcpTotal,
        native_calls:        nativeTotal,
        mostUsed:            mostUsed.slice(0, 10),
        agents_with_no_mcp:  agentsWithNoMcp,
      },
      warnings,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
