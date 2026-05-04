/**
 * GET /api/marketplace/skills
 *
 * Browse public skill listings. Returns listing metadata + publisher
 * store slug + a flag indicating whether the calling tenant has already
 * installed this skill (via a transactions row).
 *
 * Query: ?category=guideline|playbook|reference (optional)
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

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = serviceClient();
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: member } = await sb
      .from("tenant_members").select("tenant_id").eq("user_id", user.id).maybeSingle();
    const tenantId = member?.tenant_id as string | undefined;

    const url = new URL(req.url);
    const category = url.searchParams.get("category");

    const { data: listings, error } = await sb
      .from("marketplace_listings")
      .select("id, name, description, avatar, price_cents, currency, origin, metadata, store_id, created_at, updated_at, marketplace_stores(slug, name, verified)")
      .eq("listing_type", "skill")
      .eq("status",       "active")
      .eq("visibility",   "public")
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    let installedSet = new Set<string>();
    if (tenantId && listings && listings.length > 0) {
      const { data: txs } = await sb
        .from("marketplace_transactions")
        .select("listing_id")
        .eq("buyer_id", tenantId)
        .in("listing_id", listings.map((l) => l.id as string));
      installedSet = new Set((txs ?? []).map((t) => t.listing_id as string));
    }

    const filtered = (listings ?? []).filter((l) => {
      if (!category) return true;
      const meta = (l.metadata as Record<string, unknown> | null) ?? {};
      return meta.skill_category === category;
    });

    const shaped = filtered.map((l) => {
      const meta = (l.metadata as Record<string, unknown> | null) ?? {};
      const store = (l.marketplace_stores as { slug?: string; name?: string; verified?: boolean } | null);
      return {
        id:           l.id as string,
        name:         l.name as string,
        description:  l.description as string,
        avatar:       l.avatar as string | null,
        price_cents:  l.price_cents as number,
        currency:     l.currency as string,
        origin:       l.origin as string,
        category:     (meta.skill_category as string) ?? "guideline",
        slug:         (meta.skill_slug as string) ?? "",
        store: store ? { slug: store.slug ?? "", name: store.name ?? "", verified: store.verified ?? false } : null,
        installed:    installedSet.has(l.id as string),
        created_at:   l.created_at as string,
        updated_at:   l.updated_at as string,
      };
    });

    return NextResponse.json({ skills: shaped });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
