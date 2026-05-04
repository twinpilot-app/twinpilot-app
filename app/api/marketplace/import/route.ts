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
import { createClient } from "@supabase/supabase-js";
import { load as parseYaml } from "js-yaml";
import { TOOL_CATALOG } from "@/lib/tool-catalog";

export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
    const body = (await req.json()) as {
      listingId?: string;
      agentSlug?: string;
      targetFactoryId?: string;
    };
    const listingId = body.listingId?.trim();
    const agentSlug = body.agentSlug?.trim();
    const targetFactoryId = body.targetFactoryId?.trim();

    if (!listingId || !agentSlug || !targetFactoryId) {
      return NextResponse.json({ error: "listingId, agentSlug, targetFactoryId are required" }, { status: 400 });
    }
    if (!SLUG_RE.test(agentSlug)) {
      return NextResponse.json({ error: "Invalid agentSlug" }, { status: 400 });
    }

    const { sb, factory } = await assertFactoryAdmin(req, targetFactoryId);

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
      return await ingestFromDb(sb, factory, listingId, srcAgent);
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
      return await ingest(sb, factory, listingId, await resYml.text(), agentSlug);
    }
    if (!res.ok) {
      return NextResponse.json({ error: `Fetch failed (${res.status}) from ${url}` }, { status: 502 });
    }
    return await ingest(sb, factory, listingId, await res.text(), agentSlug);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

async function ingest(
  sb: ReturnType<typeof serviceClient>,
  factory: { id: string; tenant_id: string },
  listingId: string,
  yamlText: string,
  expectedSlug: string,
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

  const { data: existing } = await sb
    .from("agent_definitions")
    .select("id")
    .eq("tenant_id", factory.tenant_id)
    .eq("slug", parsed.slug)
    .maybeSingle();

  if (existing) {
    const { error } = await sb.from("agent_definitions").update(row).eq("id", existing.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, action: "updated", agentId: existing.id, warnings });
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
  sb: ReturnType<typeof serviceClient>,
  factory: { id: string; tenant_id: string },
  listingId: string,
  srcAgent: Record<string, unknown>,
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

  const { data: existing } = await sb
    .from("agent_definitions")
    .select("id")
    .eq("tenant_id", factory.tenant_id)
    .eq("slug", slug)
    .maybeSingle();

  if (existing) {
    const { error } = await sb.from("agent_definitions").update(row).eq("id", existing.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, action: "updated", agentId: existing.id, warnings });
  }

  const { data: created, error } = await sb
    .from("agent_definitions")
    .insert(row)
    .select("id")
    .single();
  if (error || !created) return NextResponse.json({ error: error?.message ?? "Insert failed" }, { status: 500 });

  return NextResponse.json({ ok: true, action: "created", agentId: created.id, warnings });
}
