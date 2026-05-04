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
  const { data: factory } = await sb
    .from("factories")
    .select("id, slug, name, avatar, tenant_id, category, config")
    .eq("id", factoryId)
    .maybeSingle();
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

async function ensureStore(
  sb: ReturnType<typeof serviceClient>,
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
  if (!tenant) throw new Error("NotFound");

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
    const body = (await req.json()) as { factoryId?: string };
    const factoryId = body.factoryId?.trim();
    if (!factoryId) return NextResponse.json({ error: "factoryId is required" }, { status: 400 });

    const { sb, factory } = await assertFactoryAdmin(req, factoryId);

    const { data: repo } = await sb
      .from("factory_repos")
      .select("id, owner, name, branch, verified_at")
      .eq("factory_id", factory.id)
      .eq("purpose", "marketplace")
      .maybeSingle();

    if (!repo || !repo.verified_at) {
      return NextResponse.json(
        { error: "Marketplace repository must be verified before publishing" },
        { status: 400 },
      );
    }

    const store = await ensureStore(sb, factory.tenant_id);

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
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
