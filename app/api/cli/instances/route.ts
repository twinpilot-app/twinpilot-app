/**
 * GET    /api/cli/instances?tenantId=… — list registered CLI instances
 * DELETE /api/cli/instances?id=…&tenantId=… — forget a registration
 *
 * Unlike the other /api/cli/* endpoints this one authenticates via the
 * user's Supabase session (Bearer access_token), because it's read from
 * the Command Center UI rather than from the CLI itself.
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

async function assertMember(sb: ReturnType<typeof serviceClient>, token: string, tenantId: string) {
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data } = await sb.from("tenant_members").select("role").eq("tenant_id", tenantId).eq("user_id", user.id).single();
  if (!data) throw new Error("Forbidden");
}

export async function GET(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = req.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

  const sb = serviceClient();
  try { await assertMember(sb, token, tenantId); } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }

  const { data: instances } = await sb
    .from("cli_instances")
    .select("id, factory_id, hostname, os_username, platform, arch, node_version, cli_version, email, created_at, last_seen_at")
    .eq("tenant_id", tenantId)
    .order("last_seen_at", { ascending: false });

  // Attach factory name for readability
  const factoryIds = Array.from(new Set((instances ?? []).map((i) => i.factory_id).filter((x): x is string => !!x)));
  let factoryNames: Record<string, string> = {};
  if (factoryIds.length > 0) {
    const { data: factories } = await sb.from("factories").select("id, name").in("id", factoryIds);
    factoryNames = Object.fromEntries((factories ?? []).map((f) => [f.id, f.name]));
  }

  return NextResponse.json({
    instances: (instances ?? []).map((i) => ({
      ...i,
      factory_name: i.factory_id ? (factoryNames[i.factory_id] ?? null) : null,
    })),
  });
}

export async function DELETE(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id       = req.nextUrl.searchParams.get("id");
  const tenantId = req.nextUrl.searchParams.get("tenantId");
  if (!id || !tenantId) return NextResponse.json({ error: "id and tenantId required" }, { status: 400 });

  const sb = serviceClient();
  try { await assertMember(sb, token, tenantId); } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }

  const { error } = await sb.from("cli_instances").delete().eq("id", id).eq("tenant_id", tenantId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
