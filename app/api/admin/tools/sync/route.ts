/**
 * POST /api/admin/tools/sync
 *
 * Reconciles the `tools` table with the TOOL_CATALOG source of truth in
 * services/command-center/lib/tool-catalog.ts.
 *
 * Behavior:
 *   - For each entry in TOOL_CATALOG: UPSERT by slug (insert if missing,
 *     update name/description/type/status/origin if present).
 *   - For each built-in tool in the DB whose slug is NOT in TOOL_CATALOG:
 *     mark status='deprecated'. User-origin tools are untouched.
 *
 * Response: { upserted, deprecated, total }
 *
 * Admin-only. Uses service-role key to bypass RLS.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { TOOL_CATALOG } from "@/lib/tool-catalog";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") {
    throw new Error("Forbidden");
  }
}

export async function POST(req: NextRequest) {
  try {
    await assertAdmin(req);

    const sb = serviceClient();

    // 1. Upsert catalog entries
    const catalogSlugs = TOOL_CATALOG.map((t) => t.slug);
    const { data: upserted, error: upsertErr } = await sb
      .from("tools")
      .upsert(
        TOOL_CATALOG.map((t) => ({
          slug: t.slug,
          name: t.name,
          description: t.description,
          type: t.type,
          status: t.status,
          origin: t.origin,
          tenant_id: null,
        })),
        { onConflict: "slug" },
      )
      .select("slug");
    if (upsertErr) {
      return NextResponse.json({ error: `Upsert failed: ${upsertErr.message}` }, { status: 500 });
    }

    // 2. Deprecate built-in tools no longer in the catalog
    const inList = `(${catalogSlugs.map((s) => `"${s}"`).join(",")})`;
    const { data: deprecated, error: deprecateErr } = await sb
      .from("tools")
      .update({ status: "deprecated" })
      .eq("origin", "built-in")
      .neq("status", "deprecated")
      .not("slug", "in", inList)
      .select("slug");
    if (deprecateErr) {
      return NextResponse.json({ error: `Deprecate failed: ${deprecateErr.message}` }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      upserted: upserted?.length ?? 0,
      deprecated: deprecated?.length ?? 0,
      total: TOOL_CATALOG.length,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
