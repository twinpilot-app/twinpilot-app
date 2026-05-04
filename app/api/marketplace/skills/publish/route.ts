/**
 * POST /api/marketplace/skills/publish
 * POST /api/marketplace/skills/unpublish (via ?action=unpublish)
 *
 * Publishes a factory_skills row to the marketplace as listing_type='skill'.
 * Only origin='custom' skills are publishable today — built-in and
 * github-import skills carry external attribution that could create
 * IP/licensing confusion if republished. Operators wanting to curate a
 * github-import collection can copy/edit into a custom skill first.
 *
 * Idempotent: re-publishing the same skill_id refreshes the listing's
 * name/description/metadata + bumps source_version_at_publish so installs
 * after a republish pick up the new body.
 *
 * Body (publish):   { skill_id, name?, description?, price_cents? }
 * Body (unpublish): { skill_id }  with ?action=unpublish
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

async function getUserAndSkill(req: NextRequest, skillId: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");

  const { data: skill } = await sb
    .from("factory_skills")
    .select("id, factory_id, project_id, slug, name, description, body, category, allowed_tools, disable_model_invocation, model_override, origin, source_url")
    .eq("id", skillId)
    .maybeSingle();
  if (!skill) throw new Error("NotFound");

  const { data: factory } = await sb
    .from("factories").select("tenant_id, name, avatar, category").eq("id", skill.factory_id).maybeSingle();
  if (!factory) throw new Error("NotFound");

  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).maybeSingle();
  if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
    throw new Error("Forbidden");
  }

  return { sb, user, skill, factory };
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
  if (existing) return existing as { id: string; slug: string };

  const { data: tenant } = await sb
    .from("tenants").select("slug, name").eq("id", tenantId).single();
  if (!tenant) throw new Error("NotFound");

  const { data: created, error } = await sb
    .from("marketplace_stores")
    .insert({ tenant_id: tenantId, slug: tenant.slug, name: tenant.name, verified: false })
    .select("id, slug")
    .single();
  if (error || !created) throw new Error(error?.message ?? "Could not create store");
  return created as { id: string; slug: string };
}

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "publish";

    const body = await req.json() as {
      skill_id?:    string;
      name?:        string;
      description?: string;
      price_cents?: number;
    };
    const skillId = body.skill_id?.trim();
    if (!skillId) return NextResponse.json({ error: "skill_id is required" }, { status: 400 });

    const { sb, skill, factory } = await getUserAndSkill(req, skillId);

    if (action === "unpublish") {
      // Mark the skill listing as archived rather than hard-delete — keeps
      // existing transactions auditable and prior installs functional.
      const { data: listing } = await sb
        .from("marketplace_listings")
        .select("id")
        .eq("listing_type", "skill")
        .eq("publisher_id", factory.tenant_id)
        .filter("metadata->>source_skill_id", "eq", skill.id as string)
        .maybeSingle();
      if (!listing) {
        return NextResponse.json({ ok: true, archived: false, message: "No active listing." });
      }
      const { error: upErr } = await sb
        .from("marketplace_listings")
        .update({ status: "archived", updated_at: new Date().toISOString() })
        .eq("id", listing.id);
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
      return NextResponse.json({ ok: true, archived: true, listingId: listing.id });
    }

    // ── Publish ──────────────────────────────────────────────────────────
    if (skill.origin !== "custom") {
      return NextResponse.json({
        error: `Only custom skills can be published. This skill came from "${skill.origin}" — copy it into a custom skill first if you want to share your version.`,
      }, { status: 422 });
    }

    const store = await ensureStore(sb, factory.tenant_id);

    const name        = (body.name ?? skill.name as string).trim();
    const description = (body.description ?? skill.description as string).trim();
    const priceCents  = Math.max(0, Number.isFinite(body.price_cents) ? Math.floor(body.price_cents as number) : 0);

    const metadata = {
      source_skill_id:           skill.id as string,
      skill_slug:                skill.slug as string,
      skill_category:            skill.category as string,
      skill_allowed_tools:       skill.allowed_tools as string[] ?? [],
      skill_disable_model_inv:   skill.disable_model_invocation as boolean ?? false,
      skill_model_override:      skill.model_override as string | null,
      published_at:              new Date().toISOString(),
    };

    // Existing listing for this skill_id?
    const { data: existing } = await sb
      .from("marketplace_listings")
      .select("id")
      .eq("listing_type", "skill")
      .eq("publisher_id", factory.tenant_id)
      .filter("metadata->>source_skill_id", "eq", skill.id as string)
      .maybeSingle();

    let listingId: string;
    if (existing) {
      const { error } = await sb
        .from("marketplace_listings")
        .update({
          store_id:       store.id,
          category_slug:  factory.category ?? "general",
          name,
          description,
          avatar:         factory.avatar,
          listing_type:   "skill",
          origin:         "community",
          status:         "active",
          price_cents:    priceCents,
          currency:       "USD",
          metadata,
          updated_at:     new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      listingId = existing.id as string;
    } else {
      const { data: created, error } = await sb
        .from("marketplace_listings")
        .insert({
          publisher_id:   factory.tenant_id,
          store_id:       store.id,
          category_slug:  factory.category ?? "general",
          name,
          description,
          avatar:         factory.avatar,
          listing_type:   "skill",
          origin:         "community",
          status:         "active",
          visibility:     "public",
          price_cents:    priceCents,
          currency:       "USD",
          metadata,
        })
        .select("id")
        .single();
      if (error || !created) return NextResponse.json({ error: error?.message ?? "publish failed" }, { status: 500 });
      listingId = created.id as string;
    }

    return NextResponse.json({ ok: true, listingId, storeSlug: store.slug });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
