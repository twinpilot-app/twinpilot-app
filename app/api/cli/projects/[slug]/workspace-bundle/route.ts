/**
 * GET /api/cli/projects/[slug]/workspace-bundle
 *
 * CLI counterpart of the dashboard's prepare-workspace dispatch. Returns
 * everything `tp prepare workspace` needs to materialise the agent
 * workspace LOCALLY, without dispatching the worker task. No
 * Trigger.dev round-trip.
 *
 * Auth: CLI API key via authCli (Bearer <key>). Auth resolves the
 * factory the key belongs to, so cross-factory data is unreachable.
 *
 * Available for local / local-git mode projects only. Cloud mode 422.
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli, requireFactoryId } from "@/lib/cli-api-auth";
import { mintWorkerToken } from "@/lib/worker-jwt";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;
  const factory = await requireFactoryId(auth);
  if (factory instanceof NextResponse) return factory;

  const { slug } = await ctx.params;

  const { data: project } = await auth.sb
    .from("projects")
    .select("id, name, slug, factory_id, settings, repo_url, working_destination_id, use_operator_git_auth, pipeline, pipeline_id, discovery_pipeline_id, execution_pipeline_id")
    .eq("slug", slug)
    .eq("factory_id", factory.factoryId)
    .maybeSingle();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const { data: factoryRow } = await auth.sb
    .from("factories").select("tenant_id, slug").eq("id", project.factory_id).single();
  if (!factoryRow) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

  const { data: tenantRow } = await auth.sb
    .from("tenants").select("slug").eq("id", factoryRow.tenant_id).single();
  if (!tenantRow) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  // Mode validation
  const settings  = (project.settings ?? {}) as Record<string, unknown>;
  const cliAgents = (settings.cli_agents ?? {}) as Record<string, unknown>;
  const orchMode  = (cliAgents.orchestration_mode as "cloud" | "local" | "local-git" | undefined)
    ?? (cliAgents.execution_backend === "local" ? "local" : "cloud");
  if (orchMode === "cloud") {
    return NextResponse.json(
      { error: "workspace-bundle is only for local / local-git projects." },
      { status: 422 },
    );
  }

  // Resolve repo URL (local-git): same priority as run/prepare-workspace.
  let repoUrl: string | null = null;
  let repoOwner: string | null = null;
  if (orchMode === "local-git") {
    const workingDestId = (project.working_destination_id as string | null | undefined) ?? null;
    if (workingDestId) {
      const { data: dest } = await auth.sb
        .from("factory_output_destinations")
        .select("owner")
        .eq("id", workingDestId)
        .single();
      if (dest?.owner) {
        repoOwner = dest.owner as string;
        repoUrl   = `https://github.com/${dest.owner}/${project.slug}`;
      }
    }
    if (!repoUrl) {
      const legacy = (project.repo_url as string | null | undefined)?.trim();
      if (legacy) repoUrl = legacy;
    }
    if (!repoUrl) {
      return NextResponse.json(
        { error: "Local + Git mode requires a working repository. Set it in Project Settings first." },
        { status: 422 },
      );
    }
  }

  const targetBranch =
    (settings.output_branch as string | undefined)
    ?? (settings.github_branch as string | undefined)
    ?? "main";

  // Collect distinct agents from default + discovery + execution pipelines.
  const pipelineIds = [
    project.pipeline_id,
    project.discovery_pipeline_id,
    project.execution_pipeline_id,
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  const agentSlugs = new Set<string>();
  const denormSteps = (project.pipeline as { agent: string }[] | null) ?? [];
  for (const s of denormSteps) if (s.agent) agentSlugs.add(s.agent);
  if (pipelineIds.length > 0) {
    const { data: pipelines } = await auth.sb
      .from("pipelines")
      .select("id, steps")
      .in("id", pipelineIds);
    for (const p of pipelines ?? []) {
      const steps = (p.steps as { agent: string }[] | null) ?? [];
      for (const s of steps) if (s.agent) agentSlugs.add(s.agent);
    }
  }
  const slugList = Array.from(agentSlugs);

  type AgentRow = {
    slug:     string;
    spec?:    { description?: string; freestyle_process?: string; process?: string; guidelines?: string };
    metadata?: { instructions?: string };
  };
  const { data: agentDefsRaw } = await auth.sb
    .from("agent_definitions")
    .select("slug, spec, metadata")
    .in("slug", slugList)
    .eq("tenant_id", factoryRow.tenant_id);
  const agentDefs = (agentDefsRaw ?? []) as AgentRow[];
  const agents = slugList.map((slug) => {
    const a = agentDefs.find((r) => r.slug === slug);
    const spec = a?.spec ?? {};
    const meta = a?.metadata ?? {};
    const persona = String(spec.description ?? spec.freestyle_process ?? spec.process ?? meta.instructions ?? "");
    const guidelines = String(spec.guidelines ?? "");
    return { slug, persona, guidelines };
  });

  // Mint MCP server JWT — 30-min TTL for ad-hoc operator sessions.
  const jwt = mintWorkerToken({
    tenantId:  factoryRow.tenant_id as string,
    factoryId: project.factory_id as string,
    ttlSeconds: 60 * 30,
  });

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";

  const tenantSlug  = tenantRow.slug as string;
  const factorySlug = factoryRow.slug as string;
  const projectSlug = project.slug as string;

  const basePathHint =
    (cliAgents.local_base_path as string | undefined)?.trim() || null;

  return NextResponse.json({
    project: {
      id:        project.id,
      slug:      projectSlug,
      name:      project.name,
      orch_mode: orchMode,
    },
    tenant_slug:  tenantSlug,
    factory_slug: factorySlug,
    workdir_relative: `TwinPilotProjects/${tenantSlug}/${factorySlug}/${projectSlug}`,
    base_path_hint: basePathHint,
    git: orchMode === "local-git" ? {
      remote_url: repoUrl,
      branch:     targetBranch,
      owner:      repoOwner,
    } : null,
    agents,
    mcp: {
      session_env: {
        TIRSA_PROJECT_ID:    project.id,
        TIRSA_TENANT_ID:     factoryRow.tenant_id,
        TIRSA_TENANT_SLUG:   tenantSlug,
        TIRSA_FACTORY_SLUG:  factorySlug,
        TIRSA_PROJECT_SLUG:  projectSlug,
        TIRSA_BACKEND:       "local",
        TIRSA_ORCHESTRATION_MODE: orchMode,
      },
      secrets: {
        SUPABASE_URL:             supabaseUrl,
        NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
        SUPABASE_ANON_KEY:        supabaseAnonKey,
        SUPABASE_JWT:             jwt.token,
        SUPABASE_JWT_EXPIRES_AT:  String(jwt.expiresAt),
      },
    },
  });
}
