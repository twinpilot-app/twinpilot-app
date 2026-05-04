/**
 * POST /api/marketplace/install
 *
 * Installs a marketplace listing for the current tenant. Behaviour
 * depends on listing_type:
 *
 *   - 'factory'  (default, legacy): creates a transaction + a disabled
 *                factory record on the buyer tenant. Operator enables it
 *                in Factory Manager.
 *
 *   - 'agent':   requires `targetFactoryId` (must belong to the buyer
 *                tenant). Clones the source agent_definition into that
 *                factory so the operator can use it immediately. No new
 *                factory is created.
 *
 *   - 'pipeline': not yet implemented (returns 501).
 *
 *   - 'skill':   requires `targetFactoryId`. Optionally `targetProjectId`
 *                for project-specific install (otherwise factory-default).
 *                Copies the publisher's factory_skills row into the
 *                buyer's factory_skills with origin='marketplace' and
 *                source_url = listing URL for traceability.
 *
 * Conflict handling (BL-26 / Discovery Slice 3):
 *   When a slug clash is detected the route returns 409 with a structured
 *   `conflict` block describing the existing entity. The UI renders a
 *   keep / replace / cancel modal. Replace re-submits the same request
 *   with `onConflict: "replace"`; the route then deletes the existing
 *   row before inserting the new one (atomic at the row level — agent /
 *   skill install only touches one record). Default (omitted onConflict)
 *   is the legacy "block and surface" behaviour.
 *
 * Body: {
 *   listingId: string,
 *   targetFactoryId?: string,
 *   targetProjectId?: string,
 *   onConflict?: "replace" | "cancel"
 * }
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

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = serviceClient();
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: member } = await sb
      .from("tenant_members")
      .select("tenant_id")
      .eq("user_id", user.id)
      .single();
    if (!member) return NextResponse.json({ error: "No tenant" }, { status: 404 });

    const tenantId = member.tenant_id as string;
    const body = await req.json() as {
      listingId?:       string;
      targetFactoryId?: string;
      targetProjectId?: string;
      /** BL-26 / Discovery Slice 3 — when slug clash is detected the
       *  default response is a 409 with a structured `conflict` block.
       *  Caller can re-submit with onConflict='replace' to overwrite the
       *  existing entity, or 'cancel' to no-op (returns 200 with skipped). */
      onConflict?:      "replace" | "cancel";
      /** Migration 171 — adoption mode for pipeline + agent listings.
       *   · "install" (default) — creates a marketplace_installs ref;
       *     canonical row stays shared / read-only. Updates from the
       *     publisher propagate automatically.
       *   · "clone" — legacy behaviour: copies the canonical row into
       *     the tenant's pipelines / agent_definitions table with
       *     origin_id stamped. Operator can edit the local copy. */
      mode?:            "install" | "clone";
    };
    if (!body.listingId) return NextResponse.json({ error: "listingId is required" }, { status: 400 });
    const onConflict = body.onConflict ?? null;

    // Fetch listing — public listings only. Private listings (visibility =
    // 'private') aren't installable yet; the future grants table will be the
    // path for sharing private listings with specific tenants.
    const { data: listing, error: listErr } = await sb
      .from("marketplace_listings")
      .select("*")
      .eq("id", body.listingId)
      .eq("status", "active")
      .eq("visibility", "public")
      .single();

    if (listErr || !listing) {
      return NextResponse.json({ error: "Listing not found or not installable" }, { status: 404 });
    }

    // ── Dispatch by listing_type ─────────────────────────────────────────
    // The "already installed" gate (marketplace_transactions row exists)
    // is enforced ONLY for factory-type listings — those create a new
    // factory record and re-installing would clone it. Agent / skill /
    // pipeline installs are clone-into-tenant operations whose conflict
    // resolution lives at the row level (slug clash → keep / replace /
    // cancel) in their respective install* helpers. That lets the
    // operator refresh a stale tenant copy without needing to delete
    // the marketplace_transactions row by hand.
    const listingType = (listing.listing_type as string | undefined) ?? "factory";
    // Default mode is "install" (reference) — the new adoption model.
    // Operators who want a local editable copy use the Clone icon on
    // the Studio card AFTER installing. Skills don't yet support refs
    // so the skill path forces clone regardless of body.mode.
    const mode = listingType === "skill" ? "clone" : (body.mode ?? "install");

    if (listingType === "pipeline") {
      if (mode === "install") {
        return await installPipelineRef(sb, listing, tenantId, body.targetFactoryId);
      }
      return await installPipelineListing(sb, listing, tenantId, user.id, onConflict);
    }

    if (listingType === "agent") {
      if (mode === "install") {
        return await installAgentRef(sb, listing, tenantId, body.targetFactoryId);
      }
      return await installAgentListing(sb, listing, body.targetFactoryId, tenantId, user.id, onConflict);
    }

    if (listingType === "skill") {
      // Skills don't yet support ref mode — the worker materialises the
      // skill body into the workdir at sprint dispatch, which currently
      // requires a tenant-side copy. Skill listings stay clone-only
      // until that materialisation can read from canonical rows.
      return await installSkillListing(sb, listing, body.targetFactoryId, body.targetProjectId, tenantId, user.id, onConflict);
    }

    // Default: factory-type install (legacy path). Block re-install via
    // the transaction record so we don't clone the factory twice.
    const { data: existingFactoryTx } = await sb
      .from("marketplace_transactions")
      .select("id")
      .eq("listing_id", listing.id)
      .eq("buyer_id", tenantId)
      .maybeSingle();
    if (existingFactoryTx) {
      return NextResponse.json({ error: "Already installed", transactionId: existingFactoryTx.id }, { status: 409 });
    }
    return await installFactoryListing(sb, listing, tenantId, user.id);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Factory-type install. Two flavours:
 *
 *   1. Plain category listing (legacy): creates an empty factory record
 *      tagged with the listing's category. No agents come along — the
 *      buyer wires up their own. This is how the original Software
 *      Factory / IoT factories work.
 *
 *   2. Factory-with-content listing (new): when the listing carries
 *      metadata.source_factory_id, the install ALSO clones every
 *      agent_definition under that source factory into the new buyer
 *      factory. This is how Built-In Templates ships the pipeline-composer
 *      today, and how any future factory-with-canonical-agents will
 *      ship more agents over time.
 */
async function installFactoryListing(
  sb: ReturnType<typeof serviceClient>,
  listing: Record<string, unknown>,
  tenantId: string,
  userId: string,
): Promise<NextResponse> {
  const { data: tx, error: txErr } = await sb
    .from("marketplace_transactions")
    .insert({
      listing_id: listing.id as string,
      buyer_id: tenantId,
      buyer_user_id: userId,
      price_cents: listing.price_cents as number,
      currency: listing.currency as string,
      status: "completed",
    })
    .select("id")
    .single();

  if (txErr) {
    return NextResponse.json({ error: `Transaction failed: ${txErr.message}` }, { status: 500 });
  }

  // Map listing.origin to factories.origin. Listing origins are about
  // WHERE it came from (tirsa publisher, community, paid); factory
  // origins are about WHAT the factory IS (community-cloned,
  // purchased, custom-built, built-in). Migration 131 added 'built-in'
  // for platform-canonical clones.
  const listingOrigin = listing.origin as string;
  const factoryOrigin =
    listingOrigin === "tirsa"     ? "built-in"
    : listingOrigin === "community" ? "community"
    : listingOrigin === "paid"      ? "paid"
    :                                 "custom";

  const { data: factory, error: fErr } = await sb
    .from("factories")
    .insert({
      tenant_id: tenantId,
      name: listing.name as string,
      slug: listing.category_slug as string,
      category: listing.category_slug as string,
      origin: factoryOrigin,
      type: "factory",
      enabled: false,
      listing_id: listing.id as string,
      transaction_id: tx!.id,
      avatar: listing.avatar as string | null,
      config: {
        max_concurrent_projects: 3,
        default_provider: "anthropic",
        default_model: "claude-sonnet-4-6",
      },
    })
    .select("id")
    .single();

  if (fErr) {
    await sb.from("marketplace_transactions").delete().eq("id", tx!.id);
    return NextResponse.json({ error: `Factory creation failed: ${fErr.message}` }, { status: 500 });
  }

  // Factory-with-content path: clone every agent under the source factory.
  // Cloning happens AFTER the factory record is created so the new agents
  // can FK onto it. Failure in this step is non-fatal — the factory is
  // installed; agents missing means the buyer can re-install or copy
  // manually. We still log the count.
  let agentsCloned = 0;
  const meta = (listing.metadata as Record<string, unknown> | null) ?? {};
  const sourceFactoryId = meta.source_factory_id as string | undefined;

  if (sourceFactoryId) {
    // Pull source agents. Selects only canonical columns since migration
    // 082 collapsed autonomy / spec_type / contract_md into spec.
    const { data: sourceAgents, error: srcErr } = await sb
      .from("agent_definitions")
      .select("slug, name, level, squad, version, spec, metadata")
      .eq("factory_id", sourceFactoryId);

    if (!srcErr && sourceAgents && sourceAgents.length > 0) {
      const cloneRows = sourceAgents.map((src) => ({
        tenant_id:  tenantId,
        factory_id: factory!.id,
        slug:       src.slug,
        name:       src.name,
        level:      src.level,
        origin:     "built-in" as const,
        enabled:    true,
        squad:      src.squad,
        version:    src.version,
        spec:       src.spec,
        metadata:   {
          ...((src.metadata as Record<string, unknown> | null) ?? {}),
          installed_from_listing_id: listing.id as string,
          installed_at: new Date().toISOString(),
        },
      }));
      const { data: clonedRows, error: cloneErr } = await sb
        .from("agent_definitions")
        .insert(cloneRows)
        .select("id");
      if (!cloneErr && clonedRows) agentsCloned = clonedRows.length;
    }
  }

  try {
    const { createNotification } = await import("@/lib/notifications");
    await createNotification({
      tenantId,
      eventType: "factory_installed",
      severity: "info",
      title: `Factory installed — ${listing.name as string}`,
      body: agentsCloned > 0
        ? `${agentsCloned} agent${agentsCloned === 1 ? "" : "s"} cloned. Enable the factory in Factory Manager.`
        : `From ${listing.origin as string} marketplace. Enable it in Factory Manager.`,
      metadata: { listingId: listing.id as string, factoryId: factory!.id, agentsCloned },
    });
  } catch { /* notification failure is non-blocking */ }

  return NextResponse.json({
    transactionId: tx!.id,
    factoryId: factory!.id,
    agentsCloned,
    message: agentsCloned > 0
      ? `"${listing.name as string}" installed with ${agentsCloned} agent${agentsCloned === 1 ? "" : "s"}. Enable it in Factory Manager.`
      : `"${listing.name as string}" installed. Enable it in Factory Manager.`,
  });
}

/**
 * Agent-type install — clones the source agent_definition (referenced by
 * listing.metadata.source_agent_id) into the operator's chosen factory.
 * The buyer ends up with a real, editable copy under their own
 * tenant/factory. No new factory is created.
 *
 * Why a copy and not a reference: future updates to the canonical
 * platform agent shouldn't silently rewrite operators' working agents.
 * Re-install is the explicit update path.
 */
async function installAgentListing(
  sb: ReturnType<typeof serviceClient>,
  listing: Record<string, unknown>,
  targetFactoryId: string | undefined,
  tenantId: string,
  userId: string,
  onConflict: "replace" | "cancel" | null,
): Promise<NextResponse> {
  if (!targetFactoryId) {
    return NextResponse.json(
      { error: "targetFactoryId is required for agent-type listings — pick which factory to install the agent into." },
      { status: 400 },
    );
  }

  // Verify the target factory belongs to the buyer tenant. Cross-tenant
  // installs are a security risk we avoid up front.
  const { data: targetFactory } = await sb
    .from("factories")
    .select("id, tenant_id, name, slug")
    .eq("id", targetFactoryId)
    .single();
  if (!targetFactory || targetFactory.tenant_id !== tenantId) {
    return NextResponse.json({ error: "Target factory not found or not in your tenant." }, { status: 404 });
  }

  // Resolve source agent. listing.metadata.source_agent_id is the
  // convention introduced in migration 128. If it's missing the listing
  // is malformed.
  const meta = (listing.metadata as Record<string, unknown> | null) ?? {};
  const sourceAgentId = meta.source_agent_id as string | undefined;
  if (!sourceAgentId) {
    return NextResponse.json(
      { error: "Listing is missing source_agent_id in metadata — contact the publisher." },
      { status: 422 },
    );
  }

  // Migration 082 collapsed autonomy / spec_type / contract_md into spec
  // — only canonical columns are selected here.
  const { data: sourceAgent, error: srcErr } = await sb
    .from("agent_definitions")
    .select("slug, name, level, squad, version, spec, metadata")
    .eq("id", sourceAgentId)
    .single();
  if (srcErr || !sourceAgent) {
    return NextResponse.json({ error: "Source agent not found." }, { status: 404 });
  }

  // ── Conflict guard ──────────────────────────────────────────────
  // Slug clash returns a structured 409 the UI can render as a
  // keep / replace / cancel modal. onConflict='replace' overwrites the
  // existing row in place; 'cancel' is a no-op success.
  const { data: collision } = await sb
    .from("agent_definitions")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("factory_id", targetFactoryId)
    .eq("slug", sourceAgent.slug as string)
    .maybeSingle();
  if (collision) {
    if (onConflict === "cancel") {
      return NextResponse.json({
        skipped: true,
        reason: "conflict-cancel",
        message: `Install cancelled — kept existing agent "${collision.name}".`,
      });
    }
    if (onConflict !== "replace") {
      return NextResponse.json({
        error:    `An agent with slug "${sourceAgent.slug}" already exists in factory "${targetFactory.name}".`,
        conflict: {
          kind:          "agent",
          slug:          sourceAgent.slug,
          existing_id:   collision.id,
          existing_name: collision.name,
          scope:         `factory "${targetFactory.name}"`,
        },
      }, { status: 409 });
    }
    // onConflict === "replace" — drop the existing row before insert.
    // Single-row delete; no cascading worries.
    const { error: delErr } = await sb
      .from("agent_definitions")
      .delete()
      .eq("id", collision.id);
    if (delErr) {
      return NextResponse.json({ error: `Replace failed (delete): ${delErr.message}` }, { status: 500 });
    }
  }

  // Transaction first so the install lifecycle is auditable even if the
  // agent insert fails downstream.
  const { data: tx, error: txErr } = await sb
    .from("marketplace_transactions")
    .insert({
      listing_id: listing.id as string,
      buyer_id: tenantId,
      buyer_user_id: userId,
      price_cents: listing.price_cents as number,
      currency: listing.currency as string,
      status: "completed",
    })
    .select("id")
    .single();
  if (txErr) {
    return NextResponse.json({ error: `Transaction failed: ${txErr.message}` }, { status: 500 });
  }

  // Clone — origin stays "built-in" so the operator knows it's a
  // platform-published agent (deletable but flagged differently in
  // Studio than user-created ones). Stamp installed_from in metadata so
  // we can detect re-install / update later.
  const cloneMetadata = {
    ...((sourceAgent.metadata as Record<string, unknown> | null) ?? {}),
    installed_from_listing_id: listing.id as string,
    installed_at: new Date().toISOString(),
  };

  const { data: cloned, error: cloneErr } = await sb
    .from("agent_definitions")
    .insert({
      tenant_id:    tenantId,
      factory_id:   targetFactoryId,
      slug:         sourceAgent.slug as string,
      name:         sourceAgent.name as string,
      level:        sourceAgent.level as string | null,
      origin:       "built-in",
      enabled:      true,
      squad:        sourceAgent.squad as string | null,
      version:      sourceAgent.version as string | null,
      spec:         sourceAgent.spec,
      metadata:     cloneMetadata,
    })
    .select("id, slug, name")
    .single();

  if (cloneErr) {
    await sb.from("marketplace_transactions").delete().eq("id", tx!.id);
    return NextResponse.json({ error: `Agent install failed: ${cloneErr.message}` }, { status: 500 });
  }

  try {
    const { createNotification } = await import("@/lib/notifications");
    await createNotification({
      tenantId,
      eventType: "factory_installed",  // reuse — generic install event
      severity: "info",
      title: `Agent installed — ${cloned!.name}`,
      body: `Cloned into factory "${targetFactory.name}". Wire it into a pipeline in Project Settings.`,
      metadata: { listingId: listing.id as string, factoryId: targetFactoryId, agentId: cloned!.id, agentSlug: cloned!.slug },
    });
  } catch { /* non-blocking */ }

  return NextResponse.json({
    transactionId: tx!.id,
    agentId: cloned!.id,
    agentSlug: cloned!.slug,
    factoryId: targetFactoryId,
    message: `"${cloned!.name}" installed into factory "${targetFactory.name}".`,
  });
}

/**
 * Skill-type install — copies the publisher's factory_skills row into
 * the buyer's factory_skills with origin='marketplace'. The body is
 * snapshotted (not referenced) so future edits by the publisher don't
 * silently rewrite the buyer's working copy. Re-install is the explicit
 * update path.
 *
 * Scope: factory-default (project_id=null) by default, or
 * project-specific when targetProjectId is supplied. The slug must not
 * collide within the target scope (factory + project_id pair).
 */
async function installSkillListing(
  sb: ReturnType<typeof serviceClient>,
  listing: Record<string, unknown>,
  targetFactoryId: string | undefined,
  targetProjectId: string | undefined,
  tenantId: string,
  userId: string,
  onConflict: "replace" | "cancel" | null,
): Promise<NextResponse> {
  if (!targetFactoryId) {
    return NextResponse.json(
      { error: "targetFactoryId is required for skill-type listings — pick which factory to install the skill into." },
      { status: 400 },
    );
  }

  const { data: targetFactory } = await sb
    .from("factories")
    .select("id, tenant_id, name")
    .eq("id", targetFactoryId)
    .single();
  if (!targetFactory || targetFactory.tenant_id !== tenantId) {
    return NextResponse.json({ error: "Target factory not found or not in your tenant." }, { status: 404 });
  }

  // If a project is specified, verify it belongs to the target factory.
  if (targetProjectId) {
    const { data: targetProject } = await sb
      .from("projects").select("id, factory_id").eq("id", targetProjectId).maybeSingle();
    if (!targetProject || targetProject.factory_id !== targetFactoryId) {
      return NextResponse.json({ error: "Target project not found or not in the target factory." }, { status: 404 });
    }
  }

  const meta = (listing.metadata as Record<string, unknown> | null) ?? {};
  const sourceSkillId = meta.source_skill_id as string | undefined;
  if (!sourceSkillId) {
    return NextResponse.json(
      { error: "Listing is missing source_skill_id in metadata — contact the publisher." },
      { status: 422 },
    );
  }

  const { data: sourceSkill, error: srcErr } = await sb
    .from("factory_skills")
    .select("slug, name, description, body, category, allowed_tools, disable_model_invocation, model_override")
    .eq("id", sourceSkillId)
    .single();
  if (srcErr || !sourceSkill) {
    return NextResponse.json({ error: "Source skill not found or has been deleted by the publisher." }, { status: 404 });
  }

  // ── Slug-collision check within scope ──────────────────────────
  // Same conflict flow as agent install — structured 409 by default,
  // onConflict='replace' overwrites in place, 'cancel' is a no-op.
  const slug = sourceSkill.slug as string;
  const scopeFilter = targetProjectId
    ? sb.from("factory_skills")
        .select("id, name")
        .eq("factory_id", targetFactoryId)
        .eq("project_id", targetProjectId)
        .eq("slug", slug)
    : sb.from("factory_skills")
        .select("id, name")
        .eq("factory_id", targetFactoryId)
        .is("project_id", null)
        .eq("slug", slug);
  const { data: collision } = await scopeFilter;
  if (collision && collision.length > 0) {
    const existing = collision[0];
    if (onConflict === "cancel") {
      return NextResponse.json({
        skipped: true,
        reason: "conflict-cancel",
        message: `Install cancelled — kept existing skill "${existing.name}".`,
      });
    }
    if (onConflict !== "replace") {
      const scopeLabel = targetProjectId
        ? `project (factory "${targetFactory.name}")`
        : `factory "${targetFactory.name}"`;
      return NextResponse.json({
        error:    `A skill with slug "${slug}" already exists in ${scopeLabel}.`,
        conflict: {
          kind:          "skill",
          slug,
          existing_id:   existing.id,
          existing_name: existing.name,
          scope:         scopeLabel,
        },
      }, { status: 409 });
    }
    // onConflict === "replace" — drop the existing skill before insert.
    const { error: delErr } = await sb
      .from("factory_skills")
      .delete()
      .eq("id", existing.id);
    if (delErr) {
      return NextResponse.json({ error: `Replace failed (delete): ${delErr.message}` }, { status: 500 });
    }
  }

  const { data: tx, error: txErr } = await sb
    .from("marketplace_transactions")
    .insert({
      listing_id:    listing.id as string,
      buyer_id:      tenantId,
      buyer_user_id: userId,
      price_cents:   listing.price_cents as number,
      currency:      listing.currency as string,
      status:        "completed",
    })
    .select("id")
    .single();
  if (txErr) {
    return NextResponse.json({ error: `Transaction failed: ${txErr.message}` }, { status: 500 });
  }

  const sourceVersion = (meta.published_at as string | undefined) ?? null;

  const { data: inserted, error: insErr } = await sb
    .from("factory_skills")
    .insert({
      factory_id:               targetFactoryId,
      project_id:               targetProjectId ?? null,
      slug:                     sourceSkill.slug,
      name:                     sourceSkill.name,
      description:              sourceSkill.description,
      body:                     sourceSkill.body,
      category:                 sourceSkill.category,
      allowed_tools:            sourceSkill.allowed_tools ?? [],
      disable_model_invocation: sourceSkill.disable_model_invocation ?? false,
      model_override:           sourceSkill.model_override,
      origin:                   "marketplace",
      source_url:               `marketplace://${listing.id as string}`,
      source_version:           sourceVersion,
    })
    .select("id, slug, name")
    .single();

  if (insErr) {
    await sb.from("marketplace_transactions").delete().eq("id", tx!.id);
    return NextResponse.json({ error: `Skill install failed: ${insErr.message}` }, { status: 500 });
  }

  try {
    const { createNotification } = await import("@/lib/notifications");
    await createNotification({
      tenantId,
      eventType: "factory_installed",
      severity:  "info",
      title:     `Skill installed — ${inserted!.name}`,
      body:      targetProjectId
        ? `Project-scoped skill added. Materialised on next sprint dispatch.`
        : `Factory-default skill added. Applies to every project in "${targetFactory.name}".`,
      metadata:  { listingId: listing.id as string, factoryId: targetFactoryId, projectId: targetProjectId, skillId: inserted!.id, skillSlug: inserted!.slug },
    });
  } catch { /* non-blocking */ }

  return NextResponse.json({
    transactionId: tx!.id,
    skillId:       inserted!.id,
    skillSlug:     inserted!.slug,
    factoryId:     targetFactoryId,
    projectId:     targetProjectId ?? null,
    message:       `"${inserted!.name}" installed${targetProjectId ? " (project scope)" : ` into factory "${targetFactory.name}"`}.`,
  });
}

/**
 * Pipeline-type install — copies the publisher's pipeline into the
 * buyer's tenant as a 'custom' pipeline + ensures every agent slug
 * referenced by the steps exists in the buyer's agent_definitions.
 *
 * Missing agent strategy:
 *   1. look up the canonical row in built-in/templates by slug
 *   2. if found, clone into the buyer's first factory with origin='built-in'
 *   3. if not found, the slug is unresolvable — surface in the response
 *      so the operator knows which step won't work
 *
 * Existing agents (operator already has a row with that slug) are
 * preserved untouched — installing a pipeline never overwrites a
 * tenant's customizations.
 */
async function installPipelineListing(
  sb: ReturnType<typeof serviceClient>,
  listing: Record<string, unknown>,
  tenantId: string,
  userId: string,
  onConflict: "replace" | "cancel" | null,
): Promise<NextResponse> {
  const meta = (listing.metadata as Record<string, unknown> | null) ?? {};
  const sourcePipelineId = meta.source_pipeline_id as string | undefined;
  if (!sourcePipelineId) {
    return NextResponse.json(
      { error: "Listing is missing source_pipeline_id in metadata — contact the publisher." },
      { status: 422 },
    );
  }

  // Pull the system pipeline. RLS already permits authenticated users to
  // read system pipelines (tenant_id IS NULL); we use the service client
  // here for consistency with the rest of the install path.
  const { data: srcPl } = await sb
    .from("pipelines")
    .select("id, slug, name, description, category, plan_required, steps, intent")
    .eq("id", sourcePipelineId)
    .maybeSingle();
  if (!srcPl) {
    return NextResponse.json({ error: "Source pipeline not found." }, { status: 404 });
  }

  // Detect existing tenant copies of THIS listing (or a stale copy with
  // the canonical slug — older installs predate origin_id, so we fall
  // back to slug match for backwards compat). Migration 170 adds
  // pipelines.origin_id; until every old copy gets its origin_id
  // backfilled by being replaced, the slug fallback covers the gap.
  const baseSlug = srcPl.slug as string;
  const { data: collisionByOrigin } = await sb
    .from("pipelines")
    .select("id, slug, name, origin_id")
    .eq("tenant_id", tenantId)
    .eq("origin_id", listing.id as string)
    .maybeSingle();
  const { data: collisionBySlug } = collisionByOrigin
    ? { data: null }
    : await sb
        .from("pipelines")
        .select("id, slug, name, origin_id")
        .eq("tenant_id", tenantId)
        .eq("slug", baseSlug)
        .maybeSingle();
  const collision = collisionByOrigin ?? collisionBySlug;
  if (collision) {
    if (onConflict === "cancel") {
      return NextResponse.json({
        skipped: true,
        reason: "conflict-cancel",
        message: `Install cancelled — kept existing pipeline "${collision.name}".`,
      });
    }
    if (onConflict !== "replace") {
      return NextResponse.json({
        error: `A pipeline named "${collision.name}" already exists in this tenant.`,
        conflict: {
          kind:          "pipeline" as const,
          slug:          collision.slug,
          existing_id:   collision.id,
          existing_name: collision.name,
          scope:         `tenant`,
        },
      }, { status: 409 });
    }
    // Replace: remove any project FKs to this pipeline first (would
    // block the delete via ON DELETE SET NULL; but pipeline_id columns
    // on projects do that already), then drop the row.
    const { error: delErr } = await sb
      .from("pipelines")
      .delete()
      .eq("id", collision.id);
    if (delErr) {
      return NextResponse.json({ error: `Replace failed (delete): ${delErr.message}` }, { status: 500 });
    }
  }

  // ── Resolve required agents ─────────────────────────────────────────────
  const steps = (srcPl.steps as Array<{ step: number; agent: string }> | null) ?? [];
  const requiredSlugs = Array.from(new Set(steps.map((s) => s.agent).filter(Boolean)));

  // Buyer tenant's first factory — needed because agent_definitions
  // requires a factory_id. Operator can move agents around later.
  const { data: buyerFactory } = await sb
    .from("factories")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!buyerFactory) {
    return NextResponse.json({
      error: "Your tenant has no factory yet — create or install a factory first, then install the pipeline.",
    }, { status: 422 });
  }

  // Existing agents in the tenant — by slug.
  const { data: existingAgents } = await sb
    .from("agent_definitions")
    .select("slug")
    .eq("tenant_id", tenantId)
    .in("slug", requiredSlugs);
  const existingSlugSet = new Set((existingAgents ?? []).map((a) => a.slug as string));
  const missingSlugs = requiredSlugs.filter((s) => !existingSlugSet.has(s));

  // Pull canonical rows for the missing slugs from built-in/templates.
  const { data: canonicalAgents } = await sb
    .from("agent_definitions")
    .select("slug, name, level, squad, version, spec, metadata")
    .eq("origin", "built-in")
    .in("slug", missingSlugs)
    .in("tenant_id", [
      // built-in tenant id — we don't hardcode, look it up.
      ...(await sb.from("tenants").select("id").eq("slug", "built-in").maybeSingle()
          .then((r) => r.data ? [r.data.id as string] : [])),
    ]);
  const canonicalBySlug = new Map((canonicalAgents ?? []).map((a) => [a.slug as string, a]));

  const installedAgents: string[] = [];
  const unresolvedAgents: string[] = [];
  for (const slug of missingSlugs) {
    const canonical = canonicalBySlug.get(slug);
    if (!canonical) {
      unresolvedAgents.push(slug);
      continue;
    }
    const { error: cloneErr } = await sb.from("agent_definitions").insert({
      tenant_id:  tenantId,
      factory_id: buyerFactory.id,
      slug:       canonical.slug,
      name:       canonical.name,
      level:      canonical.level,
      origin:     "built-in",
      enabled:    true,
      squad:      canonical.squad,
      version:    canonical.version,
      spec:       canonical.spec,
      metadata:   {
        ...((canonical.metadata as Record<string, unknown> | null) ?? {}),
        installed_from_listing_id: listing.id as string,
        installed_at:              new Date().toISOString(),
      },
    });
    if (!cloneErr) installedAgents.push(slug);
    else           unresolvedAgents.push(slug);
  }

  // ── Transaction + pipeline copy ─────────────────────────────────────────
  // Reuse a prior marketplace_transactions row when the operator is
  // re-installing — keeps the install ledger from accumulating duplicate
  // rows for the same buyer/listing pair on every refresh. Insert a new
  // row only on the first install.
  const { data: priorTx } = await sb
    .from("marketplace_transactions")
    .select("id")
    .eq("listing_id", listing.id as string)
    .eq("buyer_id", tenantId)
    .maybeSingle();
  let txId: string;
  if (priorTx) {
    txId = priorTx.id as string;
  } else {
    const { data: newTx, error: txErr } = await sb
      .from("marketplace_transactions")
      .insert({
        listing_id:    listing.id as string,
        buyer_id:      tenantId,
        buyer_user_id: userId,
        price_cents:   listing.price_cents as number,
        currency:      listing.currency as string,
        status:        "completed",
      })
      .select("id")
      .single();
    if (txErr) {
      return NextResponse.json({ error: `Transaction failed: ${txErr.message}` }, { status: 500 });
    }
    txId = newTx!.id as string;
  }

  // Copy the pipeline into the tenant. By this point any tenant collision
  // by listing or slug was already resolved (the Replace branch above
  // dropped it); fresh installs and post-replace inserts can use the
  // canonical slug verbatim.
  const copySlug = baseSlug;

  const { data: copied, error: copyErr } = await sb
    .from("pipelines")
    .insert({
      tenant_id:     tenantId,
      slug:          copySlug,
      name:          srcPl.name,
      description:   srcPl.description,
      type:          "custom",
      category:      srcPl.category,
      plan_required: srcPl.plan_required,
      steps:         srcPl.steps,
      intent:        srcPl.intent,
      is_active:     true,
      origin_id:     listing.id as string,
    })
    .select("id, slug, name")
    .single();
  if (copyErr) {
    if (!priorTx) await sb.from("marketplace_transactions").delete().eq("id", txId);
    return NextResponse.json({ error: `Pipeline copy failed: ${copyErr.message}` }, { status: 500 });
  }

  try {
    const { createNotification } = await import("@/lib/notifications");
    await createNotification({
      tenantId,
      eventType: "factory_installed",
      severity:  "info",
      title:     `Pipeline installed — ${copied!.name}`,
      body:      installedAgents.length > 0
        ? `Pipeline copied + ${installedAgents.length} agent${installedAgents.length === 1 ? "" : "s"} cloned (${installedAgents.join(", ")}).`
        : `Pipeline copied. All required agents already present.`,
      metadata: {
        listingId:        listing.id as string,
        pipelineId:       copied!.id,
        agentsInstalled:  installedAgents,
        agentsUnresolved: unresolvedAgents,
      },
    });
  } catch { /* non-blocking */ }

  return NextResponse.json({
    transactionId:       txId,
    pipelineId:          copied!.id,
    pipelineSlug:        copied!.slug,
    pipelineName:        copied!.name,
    agentsInstalled:     installedAgents,
    agentsUnresolved:    unresolvedAgents,
    message: unresolvedAgents.length > 0
      ? `"${copied!.name}" installed, but ${unresolvedAgents.length} agent slug${unresolvedAgents.length === 1 ? "" : "s"} could not be resolved: ${unresolvedAgents.join(", ")}. Those steps will fail until you provide the agents.`
      : `"${copied!.name}" installed. ${installedAgents.length === 0 ? "All required agents already present." : `${installedAgents.length} agent${installedAgents.length === 1 ? "" : "s"} cloned from Built-In Templates.`}`,
  });
}

/**
 * Pipeline INSTALL (ref) — migration 171's adoption mode for marketplace
 * pipelines that don't need to be customised. Records a marketplace_installs
 * row pointing at the canonical pipeline; nothing is copied. The picker
 * surfaces the canonical alongside tenant rows so the operator can pick
 * it directly. Canonical agents referenced by the pipeline are derived
 * at query time (steps[].agent → agent_definitions.slug in built-in
 * tenant), so no per-agent ref records are needed.
 */
async function installPipelineRef(
  sb: ReturnType<typeof serviceClient>,
  listing: Record<string, unknown>,
  tenantId: string,
  targetFactoryId?: string,
): Promise<NextResponse> {
  const meta = (listing.metadata as Record<string, unknown> | null) ?? {};
  const sourcePipelineId = meta.source_pipeline_id as string | undefined;
  if (!sourcePipelineId) {
    return NextResponse.json(
      { error: "Listing is missing source_pipeline_id in metadata — contact the publisher." },
      { status: 422 },
    );
  }

  // Verify the canonical pipeline still exists. If the publisher deleted
  // it, fail loudly rather than recording a dangling ref.
  const { data: canonical } = await sb
    .from("pipelines")
    .select("id, name, slug")
    .eq("id", sourcePipelineId)
    .maybeSingle();
  if (!canonical) {
    return NextResponse.json({ error: "Source pipeline no longer exists." }, { status: 404 });
  }

  // Idempotent: if the tenant already has this listing installed (as a
  // ref), bail with a friendly success rather than violating the unique
  // constraint.
  const { data: existing } = await sb
    .from("marketplace_installs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("listing_id", listing.id as string)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({
      ok:           true,
      alreadyInstalled: true,
      installId:    existing.id,
      message:      `"${canonical.name}" is already installed in this tenant.`,
    });
  }

  const { data: inserted, error: insErr } = await sb
    .from("marketplace_installs")
    .insert({
      tenant_id:  tenantId,
      factory_id: targetFactoryId ?? null,
      listing_id: listing.id as string,
      kind:       "pipeline",
      source_id:  canonical.id as string,
    })
    .select("id")
    .single();
  if (insErr) {
    return NextResponse.json({ error: `Install failed: ${insErr.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok:           true,
    mode:         "install",
    installId:    inserted!.id,
    pipelineId:   canonical.id,
    pipelineName: canonical.name,
    pipelineSlug: canonical.slug,
    message:      `"${canonical.name}" installed (reference). Updates from the publisher will propagate automatically.`,
  });
}

/**
 * Agent INSTALL (ref) — same pattern as installPipelineRef. The canonical
 * agent_definitions row stays under the publisher's tenant (typically
 * the platform's built-in tenant); no clone happens.
 */
async function installAgentRef(
  sb: ReturnType<typeof serviceClient>,
  listing: Record<string, unknown>,
  tenantId: string,
  targetFactoryId?: string,
): Promise<NextResponse> {
  // factory_id is optional for ref installs — refs are tenant-scoped
  // adoption records, not factory-bound rows. Operator can still pass
  // targetFactoryId to scope visibility (Studio Agents view filters by
  // factory) but it's not required.

  // Resolve canonical agent. Agent listings carry source_agent_slug in
  // metadata; we look it up under the built-in tenant.
  const meta = (listing.metadata as Record<string, unknown> | null) ?? {};
  const sourceAgentSlug = meta.source_agent_slug as string | undefined;
  if (!sourceAgentSlug) {
    return NextResponse.json(
      { error: "Listing is missing source_agent_slug in metadata — contact the publisher." },
      { status: 422 },
    );
  }

  const { data: builtInTenant } = await sb
    .from("tenants")
    .select("id")
    .eq("slug", "built-in")
    .maybeSingle();
  if (!builtInTenant) {
    return NextResponse.json({ error: "Platform built-in tenant not configured." }, { status: 500 });
  }
  const { data: canonical } = await sb
    .from("agent_definitions")
    .select("id, name, slug")
    .eq("tenant_id", builtInTenant.id)
    .eq("slug", sourceAgentSlug)
    .maybeSingle();
  if (!canonical) {
    return NextResponse.json({ error: "Source agent no longer exists." }, { status: 404 });
  }

  const { data: existing } = await sb
    .from("marketplace_installs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("listing_id", listing.id as string)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({
      ok:               true,
      alreadyInstalled: true,
      installId:        existing.id,
      message:          `"${canonical.name}" is already installed in this tenant.`,
    });
  }

  const { data: inserted, error: insErr } = await sb
    .from("marketplace_installs")
    .insert({
      tenant_id:  tenantId,
      factory_id: targetFactoryId,
      listing_id: listing.id as string,
      kind:       "agent",
      source_id:  canonical.id as string,
    })
    .select("id")
    .single();
  if (insErr) {
    return NextResponse.json({ error: `Install failed: ${insErr.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok:        true,
    mode:      "install",
    installId: inserted!.id,
    agentId:   canonical.id,
    agentName: canonical.name,
    agentSlug: canonical.slug,
    message:   `"${canonical.name}" installed (reference). Updates from the publisher will propagate automatically.`,
  });
}
