/**
 * POST /api/studio/sessions/:id/confirm
 *
 * Flushes the session's StudioPlan to the live tables in FK-safe order:
 *   pipelines → agents → projects → operations
 *
 * Synthetic ids (`staged:<entity>-<uuid>`) on cross-entity refs
 * (project.pipelineId, operation.{projectId,pipelineId}) are resolved against
 * a `committed` map built up as each batch lands. After every batch the map
 * is the source of truth for "this staged id now corresponds to this real
 * UUID".
 *
 * Atomicity: Supabase's JS client doesn't expose a transaction primitive,
 * so the endpoint does manual best-effort rollback — on any insert error,
 * the previously inserted rows are deleted in reverse order. This isn't
 * strict DB atomicity (a concurrent reader could observe partial state in
 * the millisecond window between insert and rollback), but it's
 * operator-visible the same as atomic for the single-user confirm flow we
 * support today. Hardening to a true Postgres function is registered as a
 * follow-up debt.
 *
 * On success: marks the session confirmed, persists the synthetic→real id
 * mapping inside plan.committed, and snapshots the chat history if the
 * caller passed one in the body.
 *
 * Body: { chatHistory?: unknown }   (optional snapshot for audit)
 * Returns: { ok: true, committed: { squads, pipelines, agents, projects } }
 *           on success; { ok: false, error, partialRollback?: boolean } on
 *           failure.
 *
 * Authorization: caller must own the session (session.user_id === auth.uid)
 * and have owner/admin role in the tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSessionById } from "@/lib/studio-session";
import { isStagedId, type StagedId, type StudioPlan } from "@/lib/studio-plan-types";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertAuth(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { sb, user };
}

interface CommittedMap {
  pipelines:    Record<StagedId, string>;
  agents:       Record<StagedId, string>;
  projects:     Record<StagedId, string>;
  backlogItems: Record<StagedId, string>;
}

function emptyCommitted(): CommittedMap {
  return { pipelines: {}, agents: {}, projects: {}, backlogItems: {} };
}

/** Resolve a ref (real UUID or staged id) against the committed map. */
function resolveRef(
  ref: string,
  type: keyof CommittedMap,
  committed: CommittedMap,
): string {
  if (!isStagedId(ref)) return ref;            // real UUID, pass through
  const real = committed[type][ref as StagedId];
  if (!real) throw new Error(`Unresolved staged ${type.slice(0, -1)} reference: ${ref}`);
  return real;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { sb, user } = await assertAuth(req);
    const { id: sessionId } = await params;

    const session = await getSessionById(sb, sessionId);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (session.user_id !== user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (session.status !== "draft") {
      return NextResponse.json({ error: `Session is ${session.status}, nothing to confirm` }, { status: 409 });
    }
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", session.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member || !["platform_admin", "admin"].includes(member.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: { chatHistory?: unknown } = {};
    try { body = (await req.json()) as typeof body; } catch { /* body is optional */ }

    const plan: StudioPlan = session.plan;
    const committed = emptyCommitted();

    // Track inserted ids for rollback on partial failure.
    const insertedIds: { table: string; id: string }[] = [];

    async function rollback(reason: string) {
      // Delete in reverse insertion order — projects depend on pipelines,
      // agents depend on squads, ops update projects (already deleted).
      for (let i = insertedIds.length - 1; i >= 0; i--) {
        const { table, id } = insertedIds[i]!;
        await sb.from(table).delete().eq("id", id);
      }
      return NextResponse.json({
        ok:               false,
        error:            reason,
        partialRollback:  insertedIds.length > 0,
        rolledBackCount:  insertedIds.length,
      }, { status: 500 });
    }

    // ── 1. Pipelines ────────────────────────────────────────────────────
    for (const pl of plan.pipelines) {
      const { data, error } = await sb
        .from("pipelines")
        .insert({
          name:        pl.name,
          slug:        pl.slug,
          description: pl.description ?? null,
          tenant_id:   session.tenant_id,
          type:        "custom",
          steps:       pl.steps,
          created_by:  session.user_id,
        })
        .select("id")
        .single();
      if (error || !data) return rollback(`Pipeline "${pl.name}" failed: ${error?.message ?? "unknown"}`);
      committed.pipelines[pl.id] = data.id as string;
      insertedIds.push({ table: "pipelines", id: data.id as string });
    }

    // ── 2. Agents (squad is a free-form tag — no FK resolution) ─────────
    // Insert shape mirrors what /studio's saveAgent writes so the live
    // edit modal can read every field back without a re-mapping shim.
    // Top-level columns: slug, name, squad, icon, level, version, tags
    // Spec contents: description (= persona — legacy field name /studio
    // and the YAML export both read), tools. We also persist `persona`
    // alongside `description` so future readers using the YAML-canonical
    // name don't have to know about the legacy alias.
    for (const ag of plan.agents) {
      const spec = {
        description: ag.persona,
        persona:     ag.persona,
        tools:       ag.tools,
      };
      const { data, error } = await sb
        .from("agent_definitions")
        .insert({
          slug:        ag.slug,
          name:        ag.name,
          squad:       ag.squad || null,
          icon:        ag.icon  ?? null,
          level:       ag.level ?? null,
          version:     ag.version,
          tags:        ag.tags  ?? [],
          parent_slug: null,
          origin:      "user",
          tenant_id:   session.tenant_id,
          factory_id:  session.factory_id,
          enabled:     true,
          spec,
          metadata:    {},
        })
        .select("id")
        .single();
      if (error || !data) return rollback(`Agent "${ag.name}" failed: ${error?.message ?? "unknown"}`);
      committed.agents[ag.id] = data.id as string;
      insertedIds.push({ table: "agent_definitions", id: data.id as string });
    }

    // ── 3. Projects (resolve pipelineId staged refs) ────────────────────
    for (const pj of plan.projects) {
      let pipelineIdResolved: string | null = null;
      let pipelineSteps: unknown[] = [];
      if (pj.pipelineId) {
        try {
          pipelineIdResolved = resolveRef(pj.pipelineId, "pipelines", committed);
        } catch (e) {
          return rollback((e as Error).message);
        }
        // Fetch steps from the inserted pipeline (or pre-existing one) to
        // cache on the project row, matching the original create_project
        // behavior.
        const { data: pl } = await sb
          .from("pipelines")
          .select("steps")
          .eq("id", pipelineIdResolved)
          .maybeSingle();
        pipelineSteps = (pl?.steps as unknown[] | undefined) ?? [];
      }

      const { data, error } = await sb
        .from("projects")
        .insert({
          name:         pj.name,
          slug:         pj.slug,
          factory_id:   session.factory_id,
          intake_brief: pj.brief,
          status:       "idle",
          mode:         "auto",
          created_by:   session.user_id,
          pipeline_id:  pipelineIdResolved,
          pipeline:     pipelineSteps,
        })
        .select("id")
        .single();
      if (error || !data) return rollback(`Project "${pj.name}" failed: ${error?.message ?? "unknown"}`);
      committed.projects[pj.id] = data.id as string;
      insertedIds.push({ table: "projects", id: data.id as string });
    }

    // ── 4. Backlog items ────────────────────────────────────────────────
    // projectId may be a real UUID (existing project) or a staged id from
    // an earlier create_project turn — the project came in batch 3 above
    // so committed.projects is fully populated by now.
    for (const bi of (plan.backlogItems ?? [])) {
      let projectIdResolved: string;
      try {
        projectIdResolved = resolveRef(bi.projectId, "projects", committed);
      } catch (e) {
        return rollback((e as Error).message);
      }
      // Append to end of the target project's todo column. Same gap-of-100
      // convention as the manual create endpoint.
      const { data: max } = await sb
        .from("project_backlog_items")
        .select("order_index")
        .eq("project_id", projectIdResolved)
        .eq("status", "todo")
        .order("order_index", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextOrder = (max?.order_index ?? 0) + 100;
      const { data, error } = await sb
        .from("project_backlog_items")
        .insert({
          project_id:  projectIdResolved,
          title:       bi.title,
          description: bi.description ?? null,
          status:      "todo",
          source:      "wizard-gen",
          order_index: nextOrder,
          created_by:  session.user_id,
        })
        .select("id")
        .single();
      if (error || !data) return rollback(`Backlog item "${bi.title}" failed: ${error?.message ?? "unknown"}`);
      committed.backlogItems[bi.id] = data.id as string;
      insertedIds.push({ table: "project_backlog_items", id: data.id as string });
    }

    // ── 5. Operations (assign_pipeline only, today) ─────────────────────
    for (const op of plan.operations) {
      if (op.kind !== "assign_pipeline") continue;
      let projectIdResolved: string;
      let pipelineIdResolved: string;
      try {
        projectIdResolved  = resolveRef(op.projectId,  "projects",  committed);
        pipelineIdResolved = resolveRef(op.pipelineId, "pipelines", committed);
      } catch (e) {
        return rollback((e as Error).message);
      }
      const { data: pl } = await sb
        .from("pipelines")
        .select("steps")
        .eq("id", pipelineIdResolved)
        .maybeSingle();
      const { error } = await sb
        .from("projects")
        .update({
          pipeline_id: pipelineIdResolved,
          pipeline:    (pl?.steps as unknown[] | undefined) ?? [],
          updated_at:  new Date().toISOString(),
        })
        .eq("id", projectIdResolved)
        .eq("factory_id", session.factory_id);
      if (error) return rollback(`assign_pipeline failed: ${error.message}`);
      // Update doesn't push into insertedIds — rollback restores the
      // previous pipeline_id implicitly only by deleting; we accept the
      // assign as the last-write-wins side effect of the failed batch.
    }

    // ── 6. Mark session confirmed + persist committed map ──────────────
    const { error: confirmErr } = await sb
      .from("studio_sessions")
      .update({
        status:       "confirmed",
        confirmed_at: new Date().toISOString(),
        chat_history: body.chatHistory ?? null,
        plan: {
          ...plan,
          committed: {
            ...committed,
            at: new Date().toISOString(),
          },
        },
      })
      .eq("id", sessionId)
      .eq("status", "draft");
    if (confirmErr) {
      // Rare: inserts succeeded but the session marker failed. Don't
      // rollback the inserts in this case — the operator's data landed
      // and the session row can be patched manually.
      return NextResponse.json({
        ok:       false,
        error:    `Inserts succeeded but session could not be marked confirmed: ${confirmErr.message}`,
        committed,
      }, { status: 500 });
    }

    return NextResponse.json({ ok: true, committed });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}
