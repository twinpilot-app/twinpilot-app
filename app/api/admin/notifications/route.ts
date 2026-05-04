/**
 * GET  /api/admin/notifications — list platform notification config
 * PATCH /api/admin/notifications — toggle event enabled/disabled
 *   Body: { eventType, enabled }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function sb() { return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }); }

async function assertAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const s = sb();
  const { data: { user }, error } = await s.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") throw new Error("Forbidden");
  return s;
}

export async function GET(req: NextRequest) {
  try {
    const s = await assertAdmin(req);
    const { data, error } = await s.from("platform_notification_config")
      .select("*")
      .order("display_order");
    if (error) throw new Error(error.message);
    return NextResponse.json({ events: data ?? [] });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const s = await assertAdmin(req);
    const body = await req.json() as { eventType?: string; enabled?: boolean };
    if (!body.eventType || body.enabled === undefined) {
      return NextResponse.json({ error: "eventType and enabled required" }, { status: 400 });
    }
    const { error } = await s.from("platform_notification_config")
      .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
      .eq("event_type", body.eventType);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}
