/**
 * GET  /api/notifications/preferences?tenantId=... — get preference matrix
 * PUT  /api/notifications/preferences — upsert a single preference
 *   Body: { tenantId, eventType, channel, enabled }
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

    const { data, error } = await s.from("notification_preferences")
      .select("event_type, channel, enabled")
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);

    return NextResponse.json({ preferences: data ?? [] });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { user, s } = await getUser(req);
    const body = await req.json() as { tenantId?: string; eventType?: string; channel?: string; enabled?: boolean };
    if (!body.tenantId || !body.eventType || !body.channel || body.enabled === undefined) {
      return NextResponse.json({ error: "tenantId, eventType, channel, enabled required" }, { status: 400 });
    }

    const { data: member } = await s.from("tenant_members").select("role").eq("tenant_id", body.tenantId).eq("user_id", user.id).single();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await s.from("notification_preferences").upsert({
      tenant_id: body.tenantId,
      event_type: body.eventType,
      channel: body.channel,
      enabled: body.enabled,
      updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,event_type,channel" });

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}
