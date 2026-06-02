/**
 * POST /api/marketplace/publish
 *
 * Publishes a factory to the Marketplace. Requires a verified marketplace
 * repo binding (factory_repos row with purpose='marketplace' AND
 * verified_at NOT NULL). Idempotent: re-publishing refreshes the listing
 * metadata but keeps the same listing id.
 *
 * Auto-creates the tenant's marketplace_stores row on first publish (the
 * "Org store" visible to browsers), derived from the tenant's slug/name.
 *
 * Body: { factoryId: string }
 * Returns: { listingId, storeSlug }
 *
 * Authorization: caller must be owner/admin of the factory's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { MarketplaceFactoryPublishSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function assertFactoryAdmin(sb: SupabaseClient, userId: string, factoryId: string) {
  const { data: factory } = await sb
    .from("factories")
    .select("id, slug, name, avatar, tenant_id, category, config")
    .eq("id", factoryId)
    .maybeSingle();
  if (!factory) throw new NotFoundError("Factory not found");
  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", factory.tenant_id).eq("user_id", userId).maybeSingle();
  if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
    throw new ForbiddenError("Caller is not an admin of this factory's tenant");
  }
  return { factory };
}

async function ensureStore(
  sb: SupabaseClient,
  tenantId: string,
): Promise<{ id: string; slug: string }> {
  const { data: existing } = await sb
    .from("marketplace_stores")
    .select("id, slug")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (existing) return existing;

  const { data: tenant } = await sb
    .from("tenants")
    .select("slug, name")
    .eq("id", tenantId)
    .single();
  if (!tenant) throw new NotFoundError("Tenant not found");

  const { data: created, error } = await sb
    .from("marketplace_stores")
    .insert({
      tenant_id: tenantId,
      slug: tenant.slug,
      name: tenant.name,
      verified: false,
    })
    .select("id, slug")
    .single();
  if (error || !created) throw new Error(error?.message ?? "Could not create store");
  return created;
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, MarketplaceFactoryPublishSchema);
    const { user, sb } = await getOperatorUser(req);
    const { factory } = await assertFactoryAdmin(sb, user.id, body.factoryId);

    const { data: repo } = await sb
      .from("factory_repos")
      .select("id, owner, name, branch, verified_at")
      .eq("factory_id", factory.id)
      .eq("purpose", "marketplace")
      .maybeSingle();

    if (!repo || !repo.verified_at) {
      throw new ValidationError("Marketplace repository must be verified before publishing", []);
    }

    const store = await ensureStore(sb, factory.tenant_id as string);

    const cfg = (factory.config as { description?: string } | null) ?? {};
    const description = cfg.description?.toString().trim() || `Agents from ${factory.name}`;

    const { data: existing } = await sb
      .from("marketplace_listings")
      .select("id")
      .eq("factory_repo_id", repo.id)
      .maybeSingle();

    let listingId: string;
    if (existing) {
      const { error } = await sb
        .from("marketplace_listings")
        .update({
          publisher_id: factory.tenant_id,
          store_id: store.id,
          category_slug: factory.category ?? "general",
          name: factory.name,
          description,
          avatar: factory.avatar,
          listing_type: "factory",
          origin: "community",
          status: "active",
          metadata: {
            factory_id: factory.id,
            factory_slug: factory.slug,
            repo_owner: repo.owner,
            repo_name: repo.name,
            repo_branch: repo.branch,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
      listingId = existing.id;
    } else {
      const { data: created, error } = await sb
        .from("marketplace_listings")
        .insert({
          publisher_id: factory.tenant_id,
          store_id: store.id,
          factory_repo_id: repo.id,
          category_slug: factory.category ?? "general",
          name: factory.name,
          description,
          avatar: factory.avatar,
          listing_type: "factory",
          origin: "community",
          status: "active",
          metadata: {
            factory_id: factory.id,
            factory_slug: factory.slug,
            repo_owner: repo.owner,
            repo_name: repo.name,
            repo_branch: repo.branch,
          },
        })
        .select("id")
        .single();
      if (error || !created) throw new Error(error?.message ?? "Could not create listing");
      listingId = created.id;
    }

    return NextResponse.json({ listingId, storeSlug: store.slug });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
