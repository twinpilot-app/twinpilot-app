/**
 * GET  /api/cli/projects — list projects for the authenticated CLI.
 * POST /api/cli/projects — create a new project and dispatch its pipeline
 *   (equivalent to `from-scratch`). Body:
 *     { briefing, slug?, domain?, pipelineSlug?, factoryId? }
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli, requireFactoryId, type CliAuthContext } from "@/lib/cli-api-auth";
import { dispatchSprint } from "@/lib/sprint-dispatcher";
import { slugify } from "@/lib/slugify";

interface PipelineStep {
  step:      number;
  agent:     string;
  gate:      "human" | null;
  phase:     number;
  phaseName: string;
}

async function loadPipeline(sb: CliAuthContext["sb"], slug: string): Promise<PipelineStep[]> {
  const { data } = await sb
    .from("pipelines")
    .select("steps, name")
    .eq("slug", slug)
    .eq("is_active", true)
    .is("tenant_id", null)
    .maybeSingle();
  return (data?.steps as PipelineStep[] | undefined) ?? [];
}

export const dynamic = "force-dynamic";

const DEFAULT_PIPELINE_SLUG = "full-product-development";

function extractProjectName(briefing: string): string {
  const firstSentence = briefing.split(/[.,;:\n]/)[0]?.trim() ?? briefing;
  return firstSentence.split(/\s+/).slice(0, 8).join(" ");
}

/* ── GET — list ── */
export async function GET(req: NextRequest) {
  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;

  let query = auth.sb
    .from("projects")
    .select("id, name, slug, domain, status, current_phase, current_phase_name, created_at, factory_id");

  if (auth.factoryId) {
    query = query.eq("factory_id", auth.factoryId);
  } else {
    const { data: factories } = await auth.sb.from("factories").select("id").eq("tenant_id", auth.tenantId);
    const ids = (factories ?? []).map((f) => f.id as string);
    if (ids.length === 0) return NextResponse.json({ projects: [] });
    query = query.in("factory_id", ids);
  }

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ projects: data ?? [] });
}

/* ── POST — create + dispatch ── */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    briefing?: string;
    slug?: string;
    domain?: string;
    pipelineSlug?: string;
    factoryId?: string;
  };

  if (!body.briefing || body.briefing.trim().length < 5) {
    return NextResponse.json({ error: "briefing is required (min 5 chars)" }, { status: 400 });
  }

  const auth = await authCli(req, { requestedFactoryId: body.factoryId ?? null });
  if (auth instanceof NextResponse) return auth;

  const factory = await requireFactoryId(auth);
  if (factory instanceof NextResponse) return factory;
  const { factoryId } = factory;

  const briefing     = body.briefing.trim();
  const slug         = body.slug?.trim() || slugify(extractProjectName(briefing));
  const domain       = body.domain?.trim() || "general";
  const pipelineSlug = body.pipelineSlug?.trim() || DEFAULT_PIPELINE_SLUG;

  // Reject if slug collides
  const { data: existing } = await auth.sb
    .from("projects")
    .select("id, status")
    .eq("slug", slug)
    .eq("factory_id", factoryId)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: `Project "${slug}" already exists (status: ${existing.status})` },
      { status: 409 },
    );
  }

  const dbSteps: PipelineStep[] = await loadPipeline(auth.sb, pipelineSlug).catch(() => []);
  if (dbSteps.length === 0) {
    return NextResponse.json({ error: `Pipeline "${pipelineSlug}" not found or empty` }, { status: 400 });
  }

  const name = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const uniqueAgents = [...new Set(dbSteps.map((s) => s.agent))];
  const humanGates   = dbSteps.filter((s) => s.gate === "human").length;

  const { data: created, error: createErr } = await auth.sb
    .from("projects")
    .insert({
      factory_id: factoryId,
      name,
      slug,
      domain,
      // Project starts as queued — the dispatchSprint that follows
      // (a few lines below) acquires the slot and flips to 'running'.
      status: "queued",
      base_ref: "unversioned",
      bom: {
        signal: briefing,
        agents: uniqueAgents,
        phases: 11,
        humanGates,
        mcps: ["spec-registry", "repo"],
        base_ref: "unversioned",
      },
      pipeline: dbSteps as unknown as Record<string, unknown>[],
      pipeline_slug: pipelineSlug,
    })
    .select("id")
    .single();

  if (createErr || !created) {
    return NextResponse.json({ error: createErr?.message ?? "insert failed" }, { status: 500 });
  }

  const dispatch = await dispatchSprint({
    sb: auth.sb,
    projectId: created.id,
    factoryId,
    tenantId: auth.tenantId,
    projectSlug: slug,
    payload: { signal: briefing, domain },
  });

  if (!dispatch.ok) {
    return NextResponse.json(
      { error: `Dispatch failed: ${dispatch.reason}${dispatch.detail ? ` — ${dispatch.detail}` : ""}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    id:            created.id,
    slug,
    name,
    domain,
    pipelineSlug,
    stepCount:     dbSteps.length,
    humanGates,
    triggerRunId:  dispatch.triggerRunId,
  });
}
