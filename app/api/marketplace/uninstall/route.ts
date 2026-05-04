/**
 * POST /api/marketplace/uninstall
 *
 * Removes a previously installed marketplace artifact from the caller's
 * tenant. Two shapes:
 *
 *   1. Agent uninstall (legacy):
 *      Body: { listingId, agentSlug, targetFactoryId }
 *      Matches agent_definitions by (tenant_id, origin_id, slug).
 *      Blocks when any tenant pipeline references the agent slug.
 *
 *   2. Pipeline uninstall:
 *      Body: { listingId, kind: "pipeline" }
 *      Matches pipelines by (tenant_id, origin_id). Blocks when any
 *      project in the tenant references the pipeline (default,
 *      discovery, planning, execution, or review slot). Also drops
 *      the marketplace_transactions row so the listing reverts to a
 *      "not installed" state in the marketplace UI.
 *
 * Authorization: caller must be admin of the target tenant.
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

async function assertFactoryAdmin(req: NextRequest, factoryId: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: factory } = await sb.from("factories").select("id, tenant_id").eq("id", factoryId).maybeSingle();
  if (!factory) throw new Error("NotFound");
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", factory.tenant_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || !["platform_admin", "admin"].includes(member.role)) throw new Error("Forbidden");
  return { sb, factory };
}

async function assertTenantAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: member } = await sb
    .from("tenant_members")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) throw new Error("Forbidden");
  if (!["platform_admin", "admin"].includes(member.role as string)) throw new Error("Forbidden");
  return { sb, tenantId: member.tenant_id as string };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      listingId?:        string;
      agentSlug?:        string;
      skillSlug?:        string;
      targetFactoryId?:  string;
      kind?:             "agent" | "pipeline" | "skill";
    };
    const listingId = body.listingId?.trim();
    if (!listingId) {
      return NextResponse.json({ error: "listingId is required" }, { status: 400 });
    }

    // ── Pipeline uninstall ─────────────────────────────────────────────
    if (body.kind === "pipeline") {
      const { sb, tenantId } = await assertTenantAdmin(req);

      // First: drop the marketplace_installs ref if any — that handles
      // the install-by-reference path (no clone in tenant).
      const { data: refRow } = await sb
        .from("marketplace_installs")
        .select("id, source_id")
        .eq("tenant_id", tenantId)
        .eq("listing_id", listingId)
        .eq("kind", "pipeline")
        .maybeSingle();
      if (refRow) {
        // Block when projects reference the canonical pipeline this ref
        // points to — same protection the clone path enforces.
        const { data: refProjects } = await sb
          .from("projects")
          .select("name, pipeline_id, discovery_pipeline_id, planning_pipeline_id, execution_pipeline_id, review_pipeline_id")
          .or([
            `pipeline_id.eq.${refRow.source_id}`,
            `discovery_pipeline_id.eq.${refRow.source_id}`,
            `planning_pipeline_id.eq.${refRow.source_id}`,
            `execution_pipeline_id.eq.${refRow.source_id}`,
            `review_pipeline_id.eq.${refRow.source_id}`,
          ].join(","));
        if (refProjects && refProjects.length > 0) {
          return NextResponse.json({
            error:    `Pipeline reference is in use by ${refProjects.length} project(s) — clear the assignment in Project Settings before uninstalling.`,
            projects: refProjects.map((p) => p.name as string),
          }, { status: 409 });
        }
        await sb.from("marketplace_installs").delete().eq("id", refRow.id);
        await sb
          .from("marketplace_transactions")
          .delete()
          .eq("listing_id", listingId)
          .eq("buyer_id", tenantId);
        return NextResponse.json({ ok: true, removed: 1, mode: "install", message: "Pipeline reference removed." });
      }

      // Otherwise, look for a clone (legacy or explicit clone mode).
      const { data: copy } = await sb
        .from("pipelines")
        .select("id, name, slug")
        .eq("tenant_id", tenantId)
        .eq("origin_id", listingId)
        .maybeSingle();
      if (!copy) {
        // Even if there's no row, drop the transactions row so the
        // marketplace UI flips back to "not installed". Operators who
        // already deleted the pipeline manually in Studio shouldn't be
        // stuck with a stale "Installed" badge.
        await sb
          .from("marketplace_transactions")
          .delete()
          .eq("listing_id", listingId)
          .eq("buyer_id", tenantId);
        return NextResponse.json({ ok: true, removed: 0, message: "No installed pipeline reference or clone found — transaction record cleared." });
      }

      // Block when projects reference this pipeline through any of the
      // per-intent slots (migration 169) or the legacy default slot.
      const { data: projects } = await sb
        .from("projects")
        .select("name, pipeline_id, discovery_pipeline_id, planning_pipeline_id, execution_pipeline_id, review_pipeline_id")
        .or([
          `pipeline_id.eq.${copy.id}`,
          `discovery_pipeline_id.eq.${copy.id}`,
          `planning_pipeline_id.eq.${copy.id}`,
          `execution_pipeline_id.eq.${copy.id}`,
          `review_pipeline_id.eq.${copy.id}`,
        ].join(","));
      if (projects && projects.length > 0) {
        return NextResponse.json({
          error: `Pipeline "${copy.name}" is in use by ${projects.length} project(s) — clear the assignment in Project Settings before uninstalling.`,
          projects: projects.map((p) => p.name as string),
        }, { status: 409 });
      }

      const { error: delErr } = await sb
        .from("pipelines")
        .delete()
        .eq("id", copy.id);
      if (delErr) throw new Error(delErr.message);

      await sb
        .from("marketplace_transactions")
        .delete()
        .eq("listing_id", listingId)
        .eq("buyer_id", tenantId);

      return NextResponse.json({
        ok:      true,
        removed: 1,
        message: `"${copy.name}" uninstalled.`,
      });
    }

    // ── Skill uninstall ────────────────────────────────────────────────
    // Body: { listingId, kind:"skill", skillSlug?, targetFactoryId? }
    // Two flavours:
    //  · ref       — skillSlug provided (or omitted when listing has only
    //                one skill ref): drop marketplace_installs row.
    //  · clone     — targetFactoryId + skillSlug: drop factory_skills row.
    if (body.kind === "skill") {
      const { sb, tenantId } = await assertTenantAdmin(req);
      const slug = body.skillSlug?.trim();

      // Try ref first — fastest signal of adoption.
      let refQ = sb
        .from("marketplace_installs")
        .select("id, source_id")
        .eq("tenant_id", tenantId)
        .eq("listing_id", listingId)
        .eq("kind", "skill");
      if (slug) {
        const { data: bySlug } = await sb
          .from("factory_skills")
          .select("id")
          .eq("slug", slug)
          .is("project_id", null);
        const candidateIds = (bySlug ?? []).map((r) => r.id as string);
        if (candidateIds.length > 0) refQ = refQ.in("source_id", candidateIds);
      }
      const { data: refRow } = await refQ.maybeSingle();
      if (refRow) {
        await sb.from("marketplace_installs").delete().eq("id", refRow.id);
        return NextResponse.json({ ok: true, removed: 1, mode: "install", message: "Skill reference removed." });
      }

      // Fall back to clone removal — needs targetFactoryId for scoping.
      const targetFid = body.targetFactoryId?.trim();
      if (!targetFid || !slug) {
        return NextResponse.json({ error: "No skill ref or clone matched. Pass targetFactoryId + skillSlug to drop a clone." }, { status: 404 });
      }
      const { data: clone } = await sb
        .from("factory_skills")
        .select("id, name")
        .eq("factory_id", targetFid)
        .eq("slug", slug)
        .is("project_id", null)
        .eq("origin_id", listingId)
        .maybeSingle();
      if (!clone) {
        return NextResponse.json({ error: "No installed clone of this skill found." }, { status: 404 });
      }
      const { error: delErr } = await sb.from("factory_skills").delete().eq("id", clone.id);
      if (delErr) throw new Error(delErr.message);
      return NextResponse.json({ ok: true, removed: 1, mode: "clone", message: `Skill "${clone.name}" uninstalled.` });
    }

    // ── Agent uninstall ────────────────────────────────────────────────
    // Pipeline-only callers omit agentSlug; if kind="agent" without slug,
    // treat as ref uninstall — the install record carries the canonical
    // source_id so the slug isn't needed. The legacy clone path keeps
    // requiring agentSlug + targetFactoryId.
    if (body.kind === "agent" && !body.agentSlug) {
      const { sb, tenantId } = await assertTenantAdmin(req);
      const { data: refRow } = await sb
        .from("marketplace_installs")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("listing_id", listingId)
        .eq("kind", "agent")
        .maybeSingle();
      if (!refRow) {
        return NextResponse.json({ error: "No installed agent reference found for this listing." }, { status: 404 });
      }
      await sb.from("marketplace_installs").delete().eq("id", refRow.id);
      await sb
        .from("marketplace_transactions")
        .delete()
        .eq("listing_id", listingId)
        .eq("buyer_id", tenantId);
      return NextResponse.json({ ok: true, removed: 1, mode: "install", message: "Agent reference removed." });
    }

    const agentSlug = body.agentSlug?.trim();
    const targetFactoryId = body.targetFactoryId?.trim();

    if (!agentSlug || !targetFactoryId) {
      return NextResponse.json({ error: "listingId, agentSlug, targetFactoryId are required" }, { status: 400 });
    }

    const { sb, factory } = await assertFactoryAdmin(req, targetFactoryId);

    // Block uninstall if any pipeline in this tenant references the agent slug.
    const { data: pipelines } = await sb
      .from("pipelines")
      .select("name")
      .eq("tenant_id", factory.tenant_id)
      .contains("steps", [{ agent: agentSlug }]);
    if (pipelines && pipelines.length > 0) {
      return NextResponse.json({
        error: "Agent is in use",
        pipelines: pipelines.map((p) => p.name as string),
      }, { status: 409 });
    }

    const { data, error } = await sb
      .from("agent_definitions")
      .delete()
      .eq("tenant_id", factory.tenant_id)
      .eq("factory_id", factory.id)
      .eq("origin_id", listingId)
      .eq("slug", agentSlug)
      .select("id");
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, removed: (data ?? []).length });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
