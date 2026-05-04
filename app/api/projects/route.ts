/**
 * GET  /api/projects?factoryId=...  — list projects for a factory
 * POST /api/projects                — create a new project (with intake brief)
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { slugify } from "@/lib/slugify";

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

export async function GET(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
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
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ projects: projects ?? [] });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const body = await req.json() as {
      factoryId: string;
      name: string;
      slug?: string;
      intake_brief: string;
      pipeline_id?: string;
      mode?: "new" | "adopt";
      repo_url?: string;
      storage_backend_name?: string;  // immutable — chosen at creation, stored in settings
    };

    if (!body.factoryId) return NextResponse.json({ error: "factoryId required" }, { status: 400 });
    if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (!body.intake_brief?.trim()) return NextResponse.json({ error: "intake_brief required" }, { status: 400 });

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
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
