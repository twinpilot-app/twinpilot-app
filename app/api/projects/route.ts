/**
 * GET  /api/projects?factoryId=...  — list projects for a factory
 * POST /api/projects                — create a new project (with intake brief)
 */
import { NextRequest, NextResponse } from "next/server";
import { slugify } from "@/lib/slugify";
import { getOperatorUser, parseBody, errorResponse } from "@/lib/api-helpers";
import { ProjectCreateSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const factoryId = req.nextUrl.searchParams.get("factoryId");
    if (!factoryId) return NextResponse.json({ error: "factoryId required" }, { status: 400 });

    // Verify user belongs to the factory's tenant
    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", factoryId).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role").eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data: projects, error } = await sb
      .from("projects")
      .select("id, name, slug, status, phase, mode, intake_brief, prd_md, pipeline_id, discovery_pipeline_id, planning_pipeline_id, execution_pipeline_id, review_pipeline_id, heuristic_intent, execution_mode, repo_url, working_destination_id, use_operator_git_auth, sprint_count, base_ref, locked, settings, factory_id, created_at, updated_at")
      .eq("factory_id", factoryId)
      // Hide PIP-inception temp projects from the regular Projects list.
      // They live under Studio > PIP Manager > Browse. The .or() handles
      // both the missing-key case (settings.kind absent) and the
      // explicit-other-value case so projects without a `kind` set still
      // appear (PostgREST `.neq` returns NULL for null comparison and
      // would filter those out otherwise).
      .or("settings->>kind.is.null,settings->>kind.neq.pip-inception")
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ projects: projects ?? [] });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user, sb } = await getOperatorUser(req);
    // Validated body — Zod enforces name (≤200), briefing (≤16KB),
    // slug regex, mode enum. The schema rejects unknown fields, so
    // future additions go through api-schemas.ts.
    const body = await parseBody(req, ProjectCreateSchema);

    // Verify membership
    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", body.factoryId).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role").eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Resolve pipeline steps (if pipeline_id provided)
    let pipelineSteps: unknown[] = [];
    if (body.pipeline_id) {
      const { data: pipeline } = await sb
        .from("pipelines").select("steps").eq("id", body.pipeline_id).single();
      if (pipeline) pipelineSteps = pipeline.steps as unknown[] ?? [];
    }

    // Status starts at 'idle' (migration 160's 4-state model). The
    // Start Sprint flow checks for a pipeline + briefing/PRD/repo gate
    // separately; no need to encode "draft vs ready" in status.
    const projectSlug = body.slug ?? slugify(body.name);

    // Resolve storage backend type (supabase | local) from tenant_integrations
    let storageBackendType: "supabase" | "local" | undefined;
    if (body.storage_backend_name) {
      const { data: integration } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", factory.tenant_id)
        .eq("service_id", "storage")
        .eq("var_name", body.storage_backend_name)
        .single();
      if (integration?.secret_value) {
        try {
          const cfg = JSON.parse(integration.secret_value as string) as { type?: string };
          if (cfg.type === "supabase" || cfg.type === "local") storageBackendType = cfg.type;
        } catch { /* ignore parse errors */ }
      }
    }

    const { data: project, error } = await sb
      .from("projects")
      .insert({
        factory_id:    body.factoryId,
        name:          body.name.trim(),
        slug:          projectSlug,
        status:        "idle",
        phase:         "validate",
        mode:          body.mode ?? "new",
        intake_brief:  body.intake_brief.trim(),
        pipeline_id:   body.pipeline_id ?? null,
        pipeline:      pipelineSteps,
        repo_url:      body.repo_url ?? null,
        bom:           {},
        settings:      body.storage_backend_name
          ? {
              storage_backend_name: body.storage_backend_name,
              ...(storageBackendType ? { storage_backend_type: storageBackendType } : {}),
            }
          : {},
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ project }, { status: 201 });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
