/**
 * GET /api/notifications/preferences?tenantId=... — get preference matrix
 * PUT /api/notifications/preferences — upsert a single preference
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { NotificationsPreferencesPatchSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId required", code: "VALIDATION_ERROR" }, { status: 400 });
    }
    const { user, sb } = await getOperatorUser(req);

    const { data: member } = await sb.from("tenant_members").select("role")
      .eq("tenant_id", tenantId).eq("user_id", user.id).maybeSingle();
    if (!member) throw new ForbiddenError("Caller is not a member of this tenant");

    const { data, error } = await sb.from("notification_preferences")
      .select("event_type, channel, enabled")
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);

    return NextResponse.json({ preferences: data ?? [] });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await parseBody(req, NotificationsPreferencesPatchSchema);
    const { user, sb } = await getOperatorUser(req);

    const { data: member } = await sb.from("tenant_members").select("role")
      .eq("tenant_id", body.tenantId).eq("user_id", user.id).maybeSingle();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      throw new ForbiddenError("Caller is not an admin of this tenant");
    }

    const { error } = await sb.from("notification_preferences").upsert({
      tenant_id:  body.tenantId,
      event_type: body.eventType,
      channel:    body.channel,
      enabled:    body.enabled,
      updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,event_type,channel" });

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
