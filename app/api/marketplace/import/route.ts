/**
 * POST /api/marketplace/import
 *
 * Imports a single agent from a repo-backed marketplace listing into the
 * caller's factory. Fetches the YAML at HEAD of the publisher's verified
 * branch, validates tool references against the platform catalog, and
 * upserts into agent_definitions.
 *
 * Missing tools don't block the import — they're returned in `warnings`
 * and the agent is still created (user resolves manually: add the tool to
 * the platform catalog, or remove from the agent's tool list).
 *
 * Body: { listingId: string; agentSlug: string; targetFactoryId: string }
 * Returns: {
 *   ok: true,
 *   action: 'created' | 'updated',
 *   agentId: string,
 *   warnings: string[]
 * }
 *
 * Authorization: caller must be owner/admin of the target factory's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { load as parseYaml } from "js-yaml";
import { TOOL_CATALOG } from "@/lib/tool-catalog";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { MarketplaceImportSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

async function assertFactoryAdmin(sb: SupabaseClient, userId: string, factoryId: string) {
  const { data: factory } = await sb.from("factories").select("id, tenant_id").eq("id", factoryId).maybeSingle();
  if (!factory) throw new NotFoundError("Factory not found");
  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", factory.tenant_id).eq("user_id", userId).maybeSingle();
  if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
    throw new ForbiddenError("Caller is not an admin of this factory's tenant");
  }
  return { factory };
}

interface AgentYaml {
  slug?: string;
  name?: string;
  version?: string;
  squad?: string;
  level?: string | null;
  origin?: string;
  icon?: string;
  tags?: string[];
  persona?: string;
  tools?: string[];
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, MarketplaceImportSchema);
    const listingId       = body.listingId.trim();
    const agentSlug       = body.agentSlug?.trim();
    const targetFactoryId = body.targetFactoryId?.trim();
    const onConflict      = body.onConflict ?? null;

    if (!agentSlug || !targetFactoryId) {
      throw new ValidationError("agentSlug and targetFactoryId are required for this listing kind", []);
    }
    if (!SLUG_RE.test(agentSlug)) {
      throw new ValidationError("Invalid agentSlug", []);
    }

    const { user, sb } = await getOperatorUser(req);
    const { factory } = await assertFactoryAdmin(sb, user.id, targetFactoryId);

    const { data: listing } = await sb
      .from("marketplace_listings")
      .select("id, metadata, factory_repo_id, status, visibility")
      .eq("id", listingId)
      .maybeSingle();
    if (!listing || listing.status !== "active" || listing.visibility !== "public") {
      return NextResponse.json({ error: "Listing not found or not importable" }, { status: 404 });
    }

    const m = (listing.metadata as Record<string, unknown> | null) ?? {};

    // Two source paths:
    //   1. Repo-backed (operator-published): YAML at HEAD of verified branch.
    //   2. DB-backed (platform Built-In): agent_definitions row under the
    //      source factory.
    if (!listing.factory_repo_id) {
      const sourceFactoryId = m.source_factory_id as string | undefined;
      if (!sourceFactoryId) {
        return NextResponse.json({ error: "Listing has neither factory_repo_id nor source_factory_id — not importable" }, { status: 422 });
      }
      const { data: srcAgent } = await sb
        .from("agent_definitions")
        .select("slug, name, level, squad, version, spec, metadata, icon, tags")
        .eq("factory_id", sourceFactoryId)
        .eq("slug", agentSlug)
        .maybeSingle();
      if (!srcAgent) {
        return NextResponse.json({ error: `Agent "${agentSlug}" not in source factory` }, { status: 404 });
      }
      return await ingestFromDb(sb, factory, listingId, srcAgent, onConflict);
    }

    const repoOwner = m.repo_owner as string | undefined;
    const repoName = m.repo_name as string | undefined;
    const repoBranch = m.repo_branch as string | undefined;
    const factorySlug = m.factory_slug as string | undefined;
    if (!repoOwner || !repoName || !repoBranch || !factorySlug) {
      return NextResponse.json({ error: "Listing metadata incomplete" }, { status: 500 });
    }

    // Fetch the agent YAML from the publisher's repo (HEAD of verified branch)
    const url = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${encodeURIComponent(repoBranch)}/factories/${factorySlug}/agents/contracts/${agentSlug}.yaml`;
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404) {
      // Try .yml fallback
      const urlYml = url.replace(/\.yaml$/, ".yml");
      const resYml = await fetch(urlYml, { cache: "no-store" });
      if (!resYml.ok) {
        return NextResponse.json({ error: `Agent YAML not found at ${url}` }, { status: 404 });
      }
      return await ingest(sb, factory, listingId, await resYml.text(), agentSlug, onConflict);
    }
    if (!res.ok) {
      return NextResponse.json({ error: `Fetch failed (${res.status}) from ${url}` }, { status: 502 });
    }
    return await ingest(sb, factory, listingId, await res.text(), agentSlug, onConflict);
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

/**
 * Decide what to do when (tenant_id, slug) already has rows.
 *
 * After mig 188 the agent_definitions UNIQUE constraint widened to
 * (tenant_id, slug, origin_id), so multiple rows with the same slug from
 * different sources can coexist. This resolver picks an existing row only
 * when the *origin* matches (legitimate re-import / YAML refresh from HEAD);
 * otherwise the caller INSERTs a new row.
 *
 *   - row with same origin_id exists  → update in place (refresh)
 *   - no row with same origin_id      → insert new row (coexist)
 *
 * The legacy onConflict='replace' / 'cancel' values are still accepted for
 * backwards compat — pre-mig-188 callers that hit a 409 may retry with
 * 'replace' to wipe ALL same-slug rows from any source. Most callers should
 * just stop sending onConflict.
 */
async function resolveCollision(
  sb: SupabaseClient,
  tenantId: string,
  slug: string,
  newListingId: string,
  onConflict: "replace" | "cancel" | null,
): Promise<
  | { kind: "insert"; existingId: null }
  | { kind: "update"; existingId: string }
  | { kind: "cancel"; existingId: string; existingName: string }
> {
  // Same-origin hit (any factory under this tenant) — refresh that row.
  const { data: sameOrigin } = await sb
    .from("agent_definitions")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("slug", slug)
    .eq("origin_id", newListingId)
    .maybeSingle();
  if (sameOrigin) {
    return { kind: "update", existingId: sameOrigin.id as string };
  }

  // Legacy back-compat: onConflict='replace' nukes any same-slug row from
  // a different origin. Pre-mig-188 UI flow used this to overwrite. Post-188
  // the UI should stop sending it (rows just coexist), but if it still
  // arrives we honor it for the closest tenant-owned match.
  if (onConflict === "replace") {
    const { data: anyExisting } = await sb
      .from("agent_definitions")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("slug", slug)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (anyExisting) {
      return { kind: "update", existingId: anyExisting.id as string };
    }
  }
  if (onConflict === "cancel") {
    const { data: anyExisting } = await sb
      .from("agent_definitions")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("slug", slug)
      .limit(1)
      .maybeSingle();
    if (anyExisting) {
      return {
        kind:         "cancel",
        existingId:   anyExisting.id as string,
        existingName: anyExisting.name as string,
      };
    }
  }

  // No conflict — INSERT a new row. mig 188's UNIQUE on
  // (tenant_id, slug, origin_id) lets it coexist with any prior import.
  return { kind: "insert", existingId: null };
}

async function ingest(
  sb: SupabaseClient,
  factory: { id: string; tenant_id: string },
  listingId: string,
  yamlText: string,
  expectedSlug: string,
  onConflict: "replace" | "cancel" | null,
) {
  let parsed: AgentYaml;
  try {
    parsed = parseYaml(yamlText) as AgentYaml;
  } catch (err) {
    return NextResponse.json({ error: `Invalid YAML: ${(err as Error).message}` }, { status: 400 });
  }

  if (!parsed || typeof parsed !== "object") {
    return NextResponse.json({ error: "Invalid YAML content" }, { status: 400 });
  }
  if (!parsed.slug || parsed.slug !== expectedSlug) {
    return NextResponse.json({
      error: `YAML slug mismatch: file expected "${expectedSlug}", got "${parsed.slug ?? "undefined"}"`,
    }, { status: 400 });
  }
  if (!parsed.name) {
    return NextResponse.json({ error: "YAML missing required field: name" }, { status: 400 });
  }

  // Validate tools against platform catalog
  const catalogSlugs = new Set(TOOL_CATALOG.map((t) => t.slug));
  const requestedTools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const missingTools = requestedTools.filter((t) => !catalogSlugs.has(t));
  const warnings: string[] = [];
  if (missingTools.length > 0) {
    warnings.push(`Missing tools (agent imported but these are unresolved): ${missingTools.join(", ")}`);
  }

  // Build normalized spec
  const spec: Record<string, unknown> = {
    description: parsed.persona ?? "",
    output_types: [],
    suggested_inputs: [],
    tools: requestedTools,
    autonomy: "auto",
    human_gate_reason: "",
    sla: "",
    guardrails: "",
    accept_external_instructions: true,
    model_preference: "",
    max_rounds: 0,
  };

  const row: Record<string, unknown> = {
    tenant_id: factory.tenant_id,
    factory_id: factory.id,
    slug: parsed.slug,
    name: parsed.name,
    version: parsed.version ?? "1.0.0",
    squad: parsed.squad ?? null,
    level: parsed.level ?? null,
    icon: parsed.icon ?? null,
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    origin: "user",
    origin_id: listingId,
    enabled: missingTools.length === 0,
    metadata: {
      imported_from: listingId,
      source_origin: parsed.origin ?? null,
      missing_tools: missingTools,
    },
    spec,
  };

  const decision = await resolveCollision(sb, factory.tenant_id, parsed.slug, listingId, onConflict);
  if (decision.kind === "cancel") {
    return NextResponse.json({
      ok:               true,
      skipped:          true,
      reason:           "conflict-cancel",
      message:          `Import cancelled — kept existing agent "${decision.existingName}".`,
      agentId:          decision.existingId,
      warnings,
    });
  }
  if (decision.kind === "update") {
    const { error } = await sb.from("agent_definitions").update(row).eq("id", decision.existingId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, action: "updated", agentId: decision.existingId, warnings });
  }

  const { data: created, error } = await sb
    .from("agent_definitions")
    .insert(row)
    .select("id")
    .single();
  if (error || !created) return NextResponse.json({ error: error?.message ?? "Insert failed" }, { status: 500 });

  return NextResponse.json({ ok: true, action: "created", agentId: created.id, warnings });
}

/**
 * DB-backed ingest — clones an agent_definition row from a platform Built-In
 * factory into the operator's target factory. Source spec is already in
 * the canonical shape (Studio-saved / migration-seeded), so we copy it
 * almost verbatim and rewrite only the tenant/factory/origin bookkeeping.
 *
 * Tool-catalog validation still runs so missing tools surface as warnings,
 * matching the YAML path's behaviour.
 */
async function ingestFromDb(
  sb: SupabaseClient,
  factory: { id: string; tenant_id: string },
  listingId: string,
  srcAgent: Record<string, unknown>,
  onConflict: "replace" | "cancel" | null,
) {
  const slug = srcAgent.slug as string;
  if (!slug) {
    return NextResponse.json({ error: "Source agent missing slug" }, { status: 500 });
  }

  const srcSpec = (srcAgent.spec as Record<string, unknown> | null) ?? {};
  const requestedTools = Array.isArray(srcSpec.tools) ? (srcSpec.tools as string[]) : [];
  const catalogSlugs = new Set(TOOL_CATALOG.map((t) => t.slug));
  const missingTools = requestedTools.filter((t) => !catalogSlugs.has(t));
  const warnings: string[] = [];
  if (missingTools.length > 0) {
    warnings.push(`Missing tools (agent imported but these are unresolved): ${missingTools.join(", ")}`);
  }

  const row: Record<string, unknown> = {
    tenant_id:  factory.tenant_id,
    factory_id: factory.id,
    slug,
    name:       srcAgent.name as string,
    version:    (srcAgent.version as string | null) ?? "1.0.0",
    squad:      (srcAgent.squad as string | null) ?? null,
    level:      (srcAgent.level as string | null) ?? null,
    icon:       (srcAgent.icon as string | null) ?? null,
    tags:       Array.isArray(srcAgent.tags) ? (srcAgent.tags as string[]) : [],
    origin:     "built-in",
    origin_id:  listingId,
    enabled:    missingTools.length === 0,
    metadata:   {
      ...((srcAgent.metadata as Record<string, unknown> | null) ?? {}),
      imported_from:  listingId,
      installed_at:   new Date().toISOString(),
      missing_tools:  missingTools,
    },
    spec: srcSpec,
  };

  const decision = await resolveCollision(sb, factory.tenant_id, slug, listingId, onConflict);
  if (decision.kind === "cancel") {
    return NextResponse.json({
      ok:               true,
      skipped:          true,
      reason:           "conflict-cancel",
      message:          `Import cancelled — kept existing agent "${decision.existingName}".`,
      agentId:          decision.existingId,
      warnings,
    });
  }
  if (decision.kind === "update") {
    const { error } = await sb.from("agent_definitions").update(row).eq("id", decision.existingId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, action: "updated", agentId: decision.existingId, warnings });
  }

  const { data: created, error } = await sb
    .from("agent_definitions")
    .insert(row)
    .select("id")
    .single();
  if (error || !created) return NextResponse.json({ error: error?.message ?? "Insert failed" }, { status: 500 });

  return NextResponse.json({ ok: true, action: "created", agentId: created.id, warnings });
}
