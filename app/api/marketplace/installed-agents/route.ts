/**
 * GET /api/marketplace/installed-agents?tenantId=...
 *
 * Returns the canonical agents this tenant has access to via marketplace
 * installs (migration 171). Two sources:
 *
 *   1. Direct agent installs (marketplace_installs.kind='agent'):
 *      one ref per individual agent listing the operator installed.
 *
 *   2. Pipeline-derived agents (marketplace_installs.kind='pipeline'):
 *      every canonical pipeline the tenant ref-installed exposes its
 *      step agents. A pipeline ref is the operator's promise to use
 *      the pipeline as-is; the agents that pipeline references are
 *      automatically available too.
 *
 * Response: { agents: Array<{ id, slug, name, squad, level, ..., source: 'agent' | 'pipeline', listing_id, install_id, broken }> }
 *
 * Broken refs (canonical row was deleted upstream) come back with
 * `broken: true` so the UI can warn — distinct from "not installed".
 *
 * RLS-safe: marketplace_installs reads gate on tenant_members; the
 * canonical agent_definitions reads succeed via the relaxed SELECT
 * policy added in migration 167. Service-role only on writes; this is
 * read-only.
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

export async function GET(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!tenantId) return NextResponse.json({ agents: [] });

    // Membership gate
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Pull all installs for this tenant. We resolve agents from both
    // kinds in one round trip per kind.
    const { data: installs } = await sb
      .from("marketplace_installs")
      .select("id, listing_id, kind, source_id, factory_id, installed_at")
      .eq("tenant_id", tenantId)
      .in("kind", ["agent", "pipeline"]);

    const agentInstalls    = (installs ?? []).filter((r) => r.kind === "agent");
    const pipelineInstalls = (installs ?? []).filter((r) => r.kind === "pipeline");

    // ── Direct agent refs ──
    const directAgentIds = agentInstalls.map((r) => r.source_id as string);
    const { data: directAgents } = directAgentIds.length === 0
      ? { data: [] as Array<Record<string, unknown>> }
      : await sb
          .from("agent_definitions")
          .select("id, slug, name, level, enabled, origin, squad, version, spec, icon, tags, parent_slug, factory_id, tenant_id, metadata")
          .in("id", directAgentIds);
    const directAgentById = new Map((directAgents ?? []).map((a) => [a.id as string, a]));

    // ── Pipeline refs → derived agents ──
    // For every installed pipeline ref, fetch the canonical pipeline,
    // collect its step agent slugs, then look up canonical agents by
    // slug under the built-in tenant. We dedupe by agent.id when an
    // agent appears in multiple installed pipelines.
    const pipelineIds = pipelineInstalls.map((r) => r.source_id as string);
    const { data: pipelines } = pipelineIds.length === 0
      ? { data: [] as Array<{ id: string; steps: unknown }> }
      : await sb
          .from("pipelines")
          .select("id, steps")
          .in("id", pipelineIds);
    const slugSet = new Set<string>();
    for (const p of pipelines ?? []) {
      const steps = (p.steps as Array<{ agent?: string }> | null) ?? [];
      for (const s of steps) if (s.agent) slugSet.add(s.agent);
    }
    let derivedAgents: Array<Record<string, unknown>> = [];
    if (slugSet.size > 0) {
      // Built-in tenant id lookup — resolved once per request.
      const { data: builtIn } = await sb
        .from("tenants")
        .select("id")
        .eq("slug", "built-in")
        .maybeSingle();
      if (builtIn) {
        const { data: agents } = await sb
          .from("agent_definitions")
          .select("id, slug, name, level, enabled, origin, squad, version, spec, icon, tags, parent_slug, factory_id, tenant_id, metadata")
          .eq("tenant_id", builtIn.id)
          .in("slug", [...slugSet]);
        derivedAgents = agents ?? [];
      }
    }

    // ── Compose response ──
    // Direct agent refs win over pipeline-derived (more specific
    // adoption signal). Then merge pipeline-derived agents not already
    // covered.
    const seenIds = new Set<string>();
    const out: Array<Record<string, unknown>> = [];
    for (const ref of agentInstalls) {
      const canonical = directAgentById.get(ref.source_id as string) ?? null;
      if (canonical) seenIds.add(canonical.id as string);
      out.push({
        ...(canonical ?? { id: ref.source_id, slug: null, name: null }),
        source:     "agent" as const,
        listing_id: ref.listing_id as string,
        install_id: ref.id as string,
        broken:     canonical === null,
      });
    }
    for (const a of derivedAgents) {
      if (seenIds.has(a.id as string)) continue;
      seenIds.add(a.id as string);
      out.push({
        ...a,
        source:     "pipeline" as const,
        listing_id: null,
        install_id: null,
        broken:     false,
      });
    }

    return NextResponse.json({ agents: out });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
