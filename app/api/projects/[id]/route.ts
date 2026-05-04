/**
 * PATCH  /api/projects/[id]  — update project (name, locked, repo_url)
 * DELETE /api/projects/[id]  — delete project (guards: not locked, not active)
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { TP_BUCKET, sprintPath, localSprintPath, localProjectRoot } from "@/lib/paths";

export const dynamic = "force-dynamic";

// Project is "active" only when a sprint is in flight (status='running').
// queued = about to dispatch but not yet started → safe to delete; the
// sprint will fail at dispatch but no infra was provisioned.
const ACTIVE_STATUSES = ["running"];

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

async function assertMember(
  sb: ReturnType<typeof serviceClient>,
  userId: string,
  factoryId: string,
  roles = ["platform_admin", "admin"],
) {
  const { data: factory } = await sb.from("factories").select("tenant_id").eq("id", factoryId).single();
  if (!factory) throw new Error("Factory not found");
  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", factory.tenant_id).eq("user_id", userId).single();
  if (!member || !roles.includes(member.role as string)) throw new Error("Forbidden");
}

const TRIGGER_API = "https://api.trigger.dev";

/**
 * Cancel the active Trigger.dev pipeline run for a project so a user-requested
 * pause takes effect immediately rather than after the current agent finishes.
 *
 * Looks up the sprint's trigger_run_id, then calls the Trigger.dev cancel API.
 * Non-fatal — if cancellation fails we still honour the DB pause.
 */
async function cancelActiveTriggerRun(
  sb: ReturnType<typeof serviceClient>,
  projectId: string,
  sprintStatus: "paused" | "cancelled" = "paused",
): Promise<void> {
  try {
    // Find the trigger_run_id of the currently running sprint. The
    // sprint terminal/quiescent statuses are explicitly excluded so we
    // only target a sprint that's still mid-flight on Trigger.dev.
    const { data: sprint } = await sb
      .from("sprints")
      .select("id, trigger_run_id")
      .eq("project_id", projectId)
      .in("status", ["running", "queued", "waiting"])
      .not("trigger_run_id", "is", null)
      .order("sprint_num", { ascending: false })
      .limit(1)
      .maybeSingle();

    const runId = sprint?.trigger_run_id as string | null;
    if (!runId) return;

    // Resolve Trigger.dev key (dev/prod split, with legacy fallback).
    // cancelActiveTriggerRun doesn't know the execution mode, so try
    // prod → dev → legacy until one is found.
    let triggerKey: string | undefined;
    const { data: project } = await sb
      .from("projects")
      .select("factory_id")
      .eq("id", projectId)
      .single();
    if (project) {
      const { data: factory } = await sb
        .from("factories")
        .select("tenant_id")
        .eq("id", project.factory_id)
        .single();
      if (factory) {
        const tid = factory.tenant_id as string;
        for (const varName of ["TRIGGER_PROD_SECRET_KEY", "TRIGGER_DEV_SECRET_KEY", "TRIGGER_SECRET_KEY"]) {
          const { data: row } = await sb
            .from("tenant_integrations")
            .select("secret_value")
            .eq("tenant_id", tid)
            .eq("service_id", "trigger")
            .eq("var_name", varName)
            .maybeSingle();
          if (row?.secret_value) {
            triggerKey = row.secret_value as string;
            break;
          }
        }
      }
    }
    if (!triggerKey) {
      triggerKey = process.env.TRIGGER_SECRET_KEY;
    }
    if (!triggerKey) return;

    // Cancel via Trigger.dev REST API — cancels parent run and all child runs
    await fetch(`${TRIGGER_API}/api/v1/runs/${runId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${triggerKey}` },
    });

    // Mark sprint with the requested terminal status
    await sb
      .from("sprints")
      .update({ status: sprintStatus, ...(sprintStatus !== "paused" ? { completed_at: new Date().toISOString() } : {}) })
      .eq("id", sprint!.id);

  } catch {
    // Non-fatal — DB pause already written; log omitted to avoid noise
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id } = await params;
    const body = await req.json() as {
      locked?: boolean;
      name?: string;
      repo_url?: string | null;
      working_destination_id?: string | null;
      use_operator_git_auth?: boolean;
      status?: string;
      /** Pass `null` to unarchive (also flips status away from 'locked' if it was the archive flavour). */
      archived_at?: string | null;
      settings?: unknown;
      budget?: {
        enabled?:         boolean;
        scope?:           "api_only" | "all";
        monthly_usd_cap?: number | null;
        daily_usd_cap?:   number | null;
        action?:          "warn" | "halt";
      };
      pipeline_id?: string | null;
      discovery_pipeline_id?: string | null;
      planning_pipeline_id?:  string | null;
      execution_pipeline_id?: string | null;
      review_pipeline_id?:    string | null;
      heuristic_intent?:      boolean;
      execution_mode?: "manual" | "kanban_manual" | "kanban_auto";
      intake_brief?: string | null;
      prd_md?: string | null;
    };

    const { data: project } = await sb
      .from("projects")
      .select("factory_id, status, factories!inner(tenant_id)")
      .eq("id", id)
      .single();
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await assertMember(sb, user.id, project.factory_id as string);
    // Flatten the joined tenant_id so the canonical-adoption check below
    // doesn't have to dig through the factories relation each time.
    (project as Record<string, unknown>).tenant_id =
      (project.factories as unknown as { tenant_id?: string } | null)?.tenant_id ?? null;

    // Projects have four canonical statuses (migration 160):
    //   idle    — no sprint in flight
    //   queued  — about to start
    //   running — sprint mid-flight
    //   locked  — needs Studio (no pipeline, archived, manually locked)
    //
    // Sprints own pause / pending_save / failed / completed / waiting.
    // The wire still accepts a few legacy values that map onto the new
    // taxonomy:
    //   - "paused"    → translates to a sprint pause; project goes idle
    //   - "cancelled" → archives the project (status=locked, archived_at=now)
    //   - "ready"     → idle (legacy alias)
    //   - "draft"     → locked (legacy alias)
    const ALLOWED_STATUSES = ["idle", "queued", "running", "locked", "ready", "draft", "paused", "cancelled"];
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.locked       !== undefined) patch.locked       = body.locked;
    if (body.name         !== undefined) patch.name         = body.name;
    if (body.repo_url     !== undefined) patch.repo_url     = body.repo_url;
    if (body.working_destination_id !== undefined) {
      // Verify the destination belongs to the project's factory before
      // accepting the FK update — prevents cross-factory binds via crafted
      // requests. RLS already gates by tenant; this adds factory-scoping.
      if (body.working_destination_id) {
        const { data: dest } = await sb
          .from("factory_output_destinations")
          .select("factory_id")
          .eq("id", body.working_destination_id)
          .single();
        if (!dest || dest.factory_id !== project.factory_id) {
          return NextResponse.json({ error: "Working destination must belong to this project's factory." }, { status: 422 });
        }
      }
      patch.working_destination_id = body.working_destination_id;
    }
    if (body.use_operator_git_auth !== undefined) patch.use_operator_git_auth = body.use_operator_git_auth;
    if (body.settings     !== undefined) patch.settings     = body.settings;
    if (body.budget       !== undefined) {
      // Validate budget shape — caps must be positive numbers when present;
      // null clears the cap. Invalid action/scope rejected. The shape is
      // intentionally narrow because this drives auto-drain enforcement.
      const b = body.budget ?? {};
      const cleaned: Record<string, unknown> = {};
      if (b.enabled !== undefined) cleaned.enabled = !!b.enabled;
      if (b.scope   !== undefined) {
        if (b.scope !== "api_only" && b.scope !== "all") {
          return NextResponse.json({ error: "budget.scope must be 'api_only' or 'all'" }, { status: 400 });
        }
        cleaned.scope = b.scope;
      }
      if (b.action  !== undefined) {
        if (b.action !== "warn" && b.action !== "halt") {
          return NextResponse.json({ error: "budget.action must be 'warn' or 'halt'" }, { status: 400 });
        }
        cleaned.action = b.action;
      }
      if (b.monthly_usd_cap !== undefined) {
        if (b.monthly_usd_cap !== null && (typeof b.monthly_usd_cap !== "number" || b.monthly_usd_cap < 0)) {
          return NextResponse.json({ error: "budget.monthly_usd_cap must be a non-negative number or null" }, { status: 400 });
        }
        cleaned.monthly_usd_cap = b.monthly_usd_cap;
      }
      if (b.daily_usd_cap !== undefined) {
        if (b.daily_usd_cap !== null && (typeof b.daily_usd_cap !== "number" || b.daily_usd_cap < 0)) {
          return NextResponse.json({ error: "budget.daily_usd_cap must be a non-negative number or null" }, { status: 400 });
        }
        cleaned.daily_usd_cap = b.daily_usd_cap;
      }
      patch.budget = cleaned;
    }
    // archived_at = null is the unarchive path. Setting it explicitly
    // here lets the caller pair it with status='idle' to bring the
    // project back to Office in one round trip.
    if (body.archived_at !== undefined) patch.archived_at = body.archived_at;
    if (body.intake_brief !== undefined) patch.intake_brief  = body.intake_brief;
    if (body.prd_md       !== undefined) patch.prd_md         = body.prd_md;
    // Per-intent pipeline_ids — when the value points at a canonical
    // (tenant_id IS NULL) the tenant must have an active marketplace
    // ref for it. Defense in depth: the picker UI only lists what the
    // tenant adopted, but a stale tab or direct API call could try to
    // bind to a canonical without the install record.
    const tenantId = (project as unknown as Record<string, unknown>).tenant_id as string | undefined;
    async function assertCanonicalAdopted(pipelineId: string): Promise<NextResponse | null> {
      const { data: pl } = await sb
        .from("pipelines")
        .select("id, tenant_id")
        .eq("id", pipelineId)
        .maybeSingle();
      if (!pl) {
        return NextResponse.json({ error: "Pipeline not found." }, { status: 404 });
      }
      if (pl.tenant_id === null) {
        if (!tenantId) {
          return NextResponse.json({ error: "Cannot resolve tenant for ref check." }, { status: 500 });
        }
        const { data: ref } = await sb
          .from("marketplace_installs")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("kind", "pipeline")
          .eq("source_id", pipelineId)
          .maybeSingle();
        if (!ref) {
          return NextResponse.json({
            error: "This canonical pipeline isn't installed by your tenant. Install it from the marketplace before assigning it.",
            code:  "PIPELINE_REF_MISSING",
            hint:  { pipeline_id: pipelineId },
          }, { status: 403 });
        }
      }
      return null;
    }

    if (body.discovery_pipeline_id !== undefined) {
      if (body.discovery_pipeline_id) {
        const refErr = await assertCanonicalAdopted(body.discovery_pipeline_id);
        if (refErr) return refErr;
      }
      patch.discovery_pipeline_id = body.discovery_pipeline_id;
    }
    if (body.planning_pipeline_id !== undefined) {
      if (body.planning_pipeline_id) {
        const refErr = await assertCanonicalAdopted(body.planning_pipeline_id);
        if (refErr) return refErr;
      }
      patch.planning_pipeline_id = body.planning_pipeline_id;
    }
    if (body.execution_pipeline_id !== undefined) {
      if (body.execution_pipeline_id) {
        const refErr = await assertCanonicalAdopted(body.execution_pipeline_id);
        if (refErr) return refErr;
      }
      patch.execution_pipeline_id = body.execution_pipeline_id;
    }
    if (body.review_pipeline_id !== undefined) {
      if (body.review_pipeline_id) {
        const refErr = await assertCanonicalAdopted(body.review_pipeline_id);
        if (refErr) return refErr;
      }
      patch.review_pipeline_id = body.review_pipeline_id;
    }
    if (body.heuristic_intent !== undefined) patch.heuristic_intent = body.heuristic_intent;
    if (body.execution_mode        !== undefined) {
      if (!["manual", "kanban_manual", "kanban_auto"].includes(body.execution_mode)) {
        return NextResponse.json({ error: `Invalid execution_mode. Allowed: manual, kanban_manual, kanban_auto` }, { status: 400 });
      }
      patch.execution_mode = body.execution_mode;
    }
    if (body.pipeline_id !== undefined) {
      patch.pipeline_id = body.pipeline_id;
      let pipelineHasSteps = false;
      if (body.pipeline_id) {
        const { data: pl } = await sb.from("pipelines").select("steps").eq("id", body.pipeline_id).single();
        if (pl?.steps) {
          patch.pipeline = pl.steps;
          pipelineHasSteps = Array.isArray(pl.steps) && (pl.steps as unknown[]).length > 0;
        } else {
          patch.pipeline = [];
        }
      } else {
        patch.pipeline = [];
      }
      // Auto-flip locked → idle when a non-empty pipeline lands.
      // Inverse (idle → locked when pipeline is removed) is left to the
      // operator — they can clear the pipeline without losing the
      // project.
      if (project.status === "locked" && pipelineHasSteps) {
        patch.status = "idle";
      }
    }

    // Translate the wire status onto the new taxonomy. The pause and
    // cancel paths have side effects (cancelling the Trigger.dev run,
    // setting archived_at) handled below — this just normalises what
    // we write to projects.status.
    let pauseRequested  = false;
    let cancelRequested = false;
    if (body.status !== undefined) {
      if (!ALLOWED_STATUSES.includes(body.status)) {
        return NextResponse.json({ error: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(", ")}` }, { status: 400 });
      }
      switch (body.status) {
        case "paused":
          // Operator pause: pause the active sprint, project goes idle.
          pauseRequested = true;
          patch.status = "idle";
          break;
        case "cancelled":
          // Archive: hide from Office. status=locked, archived_at=now.
          cancelRequested = true;
          patch.status = "locked";
          patch.archived_at = new Date().toISOString();
          break;
        case "ready":
          patch.status = "idle";
          break;
        case "draft":
          patch.status = "locked";
          break;
        default:
          patch.status = body.status;  // idle/queued/running/locked passthrough
      }
    }

    const { data, error } = await sb.from("projects").update(patch).eq("id", id).select("*").single();
    if (error) throw new Error(error.message);

    // Cancel the active Trigger.dev run when the user pauses or archives.
    // Must happen BEFORE the sprint is closed because the helper only
    // cancels sprints not yet in a terminal status. The helper also
    // stamps the sprint with the requested terminal flag (paused vs
    // cancelled) so the sprint row reflects the operator's intent.
    if (pauseRequested || cancelRequested) {
      await cancelActiveTriggerRun(sb, id, cancelRequested ? "cancelled" : "paused");
    }

    return NextResponse.json({ project: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Delete sprint artifacts from local filesystem and/or bucket.
 * Non-fatal — logs warnings but doesn't block deletion.
 */
async function cleanupSprintArtifacts(
  sb: SupabaseClient,
  sprint: { sprint_num: number; config?: Record<string, unknown> | null },
  tenantSlug: string,
  factorySlug: string,
  projectSlug: string,
): Promise<void> {
  const sprintNum = sprint.sprint_num;
  const config = (sprint.config ?? {}) as Record<string, unknown>;
  const mode = config.mode as string | undefined;
  const localBase = config.localBasePath as string | undefined;

  // Clean local filesystem
  if (localBase && tenantSlug && factorySlug) {
    try {
      const dir = localSprintPath(localBase, tenantSlug, factorySlug, projectSlug, sprintNum);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[cleanup] local sprint-${sprintNum} failed:`, (e as Error).message);
    }
  }

  // Clean bucket
  try {
    const prefix = sprintPath(tenantSlug, factorySlug, projectSlug, sprintNum);
    const { data } = await sb.storage.from(TP_BUCKET).list(prefix, { limit: 1000 });
    if (data && data.length > 0) {
      // Recursively collect all file paths
      const paths: string[] = [];
      const collect = async (pfx: string) => {
        const { data: items } = await sb.storage.from(TP_BUCKET).list(pfx, { limit: 1000 });
        for (const item of items ?? []) {
          const full = `${pfx}/${item.name}`;
          if (!item.id) await collect(full);
          else paths.push(full);
        }
      };
      await collect(prefix);
      if (paths.length > 0) {
        const BATCH = 100;
        for (let i = 0; i < paths.length; i += BATCH) {
          await sb.storage.from(TP_BUCKET).remove(paths.slice(i, i + BATCH));
        }
      }
    }
  } catch (e) {
    console.warn(`[cleanup] bucket sprint-${sprintNum} failed:`, (e as Error).message);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id } = await params;

    const { data: project } = await sb
      .from("projects")
      .select("factory_id, status, locked, name, slug")
      .eq("id", id)
      .single();

    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await assertMember(sb, user.id, project.factory_id as string);

    if (project.locked) {
      return NextResponse.json(
        { error: "Project is locked. Unlock it first before deleting." },
        { status: 403 },
      );
    }

    if (ACTIVE_STATUSES.includes(project.status as string)) {
      return NextResponse.json(
        { error: `Cannot delete a project that is currently ${project.status}. Stop it first.` },
        { status: 409 },
      );
    }

    const projectSlug = project.slug as string;

    // Resolve tenant/factory slugs
    const { data: factory } = await sb.from("factories").select("tenant_id, slug").eq("id", project.factory_id).single();
    const factorySlug = factory?.slug as string ?? "";
    const { data: tenant } = await sb.from("tenants").select("slug").eq("id", factory?.tenant_id).single();
    const tenantSlug = tenant?.slug as string ?? "";

    // Load all sprints for artifact cleanup
    const { data: sprints } = await sb.from("sprints").select("id, sprint_num, config").eq("project_id", id);

    // Clean artifacts for each sprint (local + bucket)
    for (const sprint of sprints ?? []) {
      await cleanupSprintArtifacts(sb, sprint as { sprint_num: number; config?: Record<string, unknown> | null }, tenantSlug, factorySlug, projectSlug);
    }

    // Clean local project root (non-fatal)
    try {
      // Resolve localBase from tenant storage integrations
      const { data: storageInts } = await sb.from("tenant_integrations").select("secret_value").eq("tenant_id", factory?.tenant_id).eq("service_id", "storage");
      for (const row of storageInts ?? []) {
        try {
          const cfg = JSON.parse(row.secret_value as string) as { type?: string; basePath?: string };
          if (cfg.type === "local" && cfg.basePath && tenantSlug && factorySlug) {
            const projRoot = localProjectRoot(cfg.basePath, tenantSlug, factorySlug, projectSlug);
            if (existsSync(projRoot)) rmSync(projRoot, { recursive: true, force: true });
            break;
          }
        } catch { /* ignore */ }
      }
    } catch (e) {
      console.warn("[cleanup] local project root failed:", (e as Error).message);
    }

    // Cascade: events → runs → sprints → project
    const { data: runs } = await sb.from("agent_runs").select("id").eq("project_id", id);
    if (runs && runs.length > 0) {
      await sb.from("agent_events").delete().in("run_id", runs.map((r) => r.id));
      await sb.from("agent_runs").delete().eq("project_id", id);
    }
    await sb.from("sprints").delete().eq("project_id", id);
    await sb.from("projects").delete().eq("id", id);

    return NextResponse.json({ ok: true, deleted: id });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
