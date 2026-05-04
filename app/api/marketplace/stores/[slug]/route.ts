/**
 * GET /api/marketplace/stores/:slug
 *
 * Returns store metadata + the list of its factory listings. Pipelines
 * are surfaced INSIDE each factory's drill-in page (listings/[id])
 * rather than at store level — keeps the catalog organised: a store
 * has factories, a factory has pipelines + agents.
 *
 * Returns: { store, factories[] }
 *
 * Authorization: any authenticated user.
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

async function assertAuth(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { sb, user };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const { sb } = await assertAuth(req);
    const { slug } = await params;

    const { data: store, error: sErr } = await sb
      .from("marketplace_stores")
      .select("id, slug, name, description, avatar, verified, created_at")
      .eq("slug", slug)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!store) return NextResponse.json({ error: "Store not found" }, { status: 404 });

    // Built-In store ships canonical factories seeded via migration; they
    // don't have a factory_repo backing. For all other (operator-published)
    // stores, factory_repo_id IS NOT NULL is required - that's the
    // operator's signal that they verified a real source.
    const isBuiltIn = (store.slug as string) === "built-in";

    let listingsQuery = sb
      .from("marketplace_listings")
      .select("id, name, description, avatar, category_slug, metadata, factory_repo_id, created_at")
      .eq("store_id", store.id)
      .eq("listing_type", "factory")
      .eq("status", "active")
      .eq("visibility", "public")
      .order("name");
    if (!isBuiltIn) {
      listingsQuery = listingsQuery.not("factory_repo_id", "is", null);
    }
    const { data: listings, error: lErr } = await listingsQuery;
    if (lErr) throw new Error(lErr.message);

    const factories = (listings ?? []).map((l) => {
      const m = (l.metadata as Record<string, unknown> | null) ?? {};
      return {
        id: l.id,
        name: l.name,
        description: l.description,
        avatar: l.avatar,
        category_slug: l.category_slug,
        factory_slug: (m.factory_slug as string | undefined)
                   ?? (m.source_factory_slug as string | undefined)
                   ?? null,
        repo_owner: (m.repo_owner as string | undefined) ?? null,
        repo_name: (m.repo_name as string | undefined) ?? null,
        repo_branch: (m.repo_branch as string | undefined) ?? null,
      };
    });

    return NextResponse.json({ store, factories });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}
