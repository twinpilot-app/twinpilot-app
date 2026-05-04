/**
 * GET  /api/notifications/channels?tenantId=... — get channel configs
 * PUT  /api/notifications/channels — upsert channel config
 *   Body: { tenantId, channel, config, enabled }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function sb() { return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }); }

async function getUser(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const s = sb();
  const { data: { user }, error } = await s.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { user, s };
}

export async function GET(req: NextRequest) {
  try {
    const { user, s } = await getUser(req);
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

    const { data: member } = await s.from("tenant_members").select("role").eq("tenant_id", tenantId).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data, error } = await s.from("notification_channel_config")
      .select("id, channel, name, config, enabled, integration_type")
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);

    return NextResponse.json({ channels: data ?? [] });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { user, s } = await getUser(req);
    const body = await req.json() as { tenantId?: string; channel?: string; name?: string; config?: Record<string, unknown>; enabled?: boolean; integration_type?: string };
    if (!body.tenantId || !body.channel) {
      return NextResponse.json({ error: "tenantId and channel required" }, { status: 400 });
    }

    const { data: member } = await s.from("tenant_members").select("role").eq("tenant_id", body.tenantId).eq("user_id", user.id).single();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await s.from("notification_channel_config").insert({
      tenant_id: body.tenantId,
      channel: body.channel,
      name: body.name ?? null,
      config: body.config ?? {},
      enabled: body.enabled ?? false,
      integration_type: body.integration_type ?? "custom",
      updated_at: new Date().toISOString(),
    });

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { user, s } = await getUser(req);
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    const id = req.nextUrl.searchParams.get("id");
    if (!tenantId || !id) return NextResponse.json({ error: "tenantId and id required" }, { status: 400 });

    const { data: member } = await s.from("tenant_members").select("role").eq("tenant_id", tenantId).eq("user_id", user.id).single();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await s.from("notification_channel_config").delete().eq("id", id).eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}
