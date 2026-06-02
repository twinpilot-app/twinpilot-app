/**
 * GET /api/marketplace — list active marketplace listings
 * Query: ?origin=tirsa|community|paid (optional filter)
 * Returns: { listings: [...], installed: { [listingId]: transactionId } }
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

    // Get tenant
    const { data: member } = await sb
      .from("tenant_members")
      .select("tenant_id")
      .eq("user_id", user.id)
      .single();
    if (!member) return NextResponse.json({ error: "No tenant" }, { status: 404 });

    const tenantId = member.tenant_id as string;

    // Fetch listings
    const origin = req.nextUrl.searchParams.get("origin");
    let query = sb.from("marketplace_listings")
      .select("id, publisher_id, category_slug, name, description, avatar, price_cents, currency, origin, status, metadata, created_at")
      .eq("status", "active")
      .eq("visibility", "public")
      .order("created_at");

    if (origin) query = query.eq("origin", origin);

    const { data: listings, error: listErr } = await query;
    if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });

    // Fetch this tenant's transactions to know what's already installed
    const { data: transactions } = await sb
      .from("marketplace_transactions")
      .select("id, listing_id, status")
      .eq("buyer_id", tenantId);

    const installed: Record<string, string> = {};
    for (const tx of transactions ?? []) {
      if (tx.status === "completed") {
        installed[tx.listing_id as string] = tx.id as string;
      }
    }

    // Get publisher names
    const publisherIds = [...new Set((listings ?? []).map((l) => l.publisher_id as string))];
    const { data: publishers } = await sb
      .from("tenants")
      .select("id, name")
      .in("id", publisherIds);
    const publisherMap: Record<string, string> = {};
    for (const p of publishers ?? []) publisherMap[p.id as string] = p.name as string;

    return NextResponse.json({
      listings: (listings ?? []).map((l) => ({
        ...l,
        publisher_name: publisherMap[l.publisher_id as string] ?? "Unknown",
        installed: !!(installed[l.id as string]),
        transaction_id: installed[l.id as string] ?? null,
      })),
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
