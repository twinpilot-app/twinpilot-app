/**
 * POST /api/marketplace/unpublish
 *
 * Removes a factory's marketplace listing. Does not touch factory_repos
 * (the verified repo binding remains, the factory is simply not advertised).
 *
 * Body: { factoryId: string }
 * Returns: { ok: true }
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

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { factoryId?: string };
    const factoryId = body.factoryId?.trim();
    if (!factoryId) return NextResponse.json({ error: "factoryId is required" }, { status: 400 });

    const { sb, factory } = await assertFactoryAdmin(req, factoryId);

    const { data: repo } = await sb
      .from("factory_repos")
      .select("id")
      .eq("factory_id", factory.id)
      .eq("purpose", "marketplace")
      .maybeSingle();
    if (!repo) return NextResponse.json({ ok: true });

    const { error } = await sb
      .from("marketplace_listings")
      .delete()
      .eq("factory_repo_id", repo.id);
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
