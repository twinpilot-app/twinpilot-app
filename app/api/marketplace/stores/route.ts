/**
 * GET /api/marketplace/stores
 *
 * Lists all marketplace stores (one per publishing tenant) that have at
 * least one active, repo-backed factory listing. Each store entry includes
 * a factory count for display.
 *
 * Returns: { stores: [{ id, slug, name, description, avatar, verified,
 *                       factory_count }] }
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

export async function GET(req: NextRequest) {
  try {
    const { sb } = await assertAuth(req);

    // Two-shaped query: factory listings either have a verified GitHub
    // backing (factory_repo_id IS NOT NULL) or they're DB-backed Built-In
    // listings (metadata.source_factory_id IS NOT NULL). Both should
    // surface in the Stores grid so the Built-In tenant appears alongside
    // operator-published stores.
    const { data: listings, error } = await sb
      .from("marketplace_listings")
      .select("store_id, metadata, factory_repo_id")
      .eq("listing_type", "factory")
      .eq("status", "active")
      .eq("visibility", "public")
      .not("store_id", "is", null)
      .or("factory_repo_id.not.is.null,metadata->>source_factory_id.not.is.null");
    if (error) throw new Error(error.message);

    const storeIds = Array.from(new Set((listings ?? []).map((l) => l.store_id).filter(Boolean) as string[]));
    if (storeIds.length === 0) return NextResponse.json({ stores: [] });

    const { data: stores, error: sErr } = await sb
      .from("marketplace_stores")
      .select("id, slug, name, description, avatar, verified")
      .in("id", storeIds)
      .order("name");
    if (sErr) throw new Error(sErr.message);

    const counts = new Map<string, number>();
    const ownerByStore = new Map<string, string>();
    for (const l of listings ?? []) {
      if (!l.store_id) continue;
      counts.set(l.store_id, (counts.get(l.store_id) ?? 0) + 1);
      if (!ownerByStore.has(l.store_id)) {
        const m = (l.metadata as Record<string, unknown> | null) ?? {};
        const owner = m.repo_owner as string | undefined;
        if (owner) ownerByStore.set(l.store_id, owner);
      }
    }

    const withCounts = (stores ?? []).map((s) => ({
      ...s,
      factory_count: counts.get(s.id) ?? 0,
      github_owner: ownerByStore.get(s.id) ?? null,
    }));
    return NextResponse.json({ stores: withCounts });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}
