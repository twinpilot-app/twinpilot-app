/**
 * GET   /api/admin/notifications — list platform notification config
 * PATCH /api/admin/notifications — toggle event enabled/disabled
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody, serviceClient,
} from "@/lib/api-helpers";
import { AdminNotificationsPatchSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

async function assertPlatformAdmin(req: NextRequest) {
  const { user, sb } = await getOperatorUser(req);
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") {
    throw new ForbiddenError("Caller is not a platform admin");
  }
  return { sb };
}

export async function GET(req: NextRequest) {
  try {
    await assertPlatformAdmin(req);
    const sb = serviceClient();
    const { data, error } = await sb.from("platform_notification_config")
      .select("*")
      .order("display_order");
    if (error) throw new Error(error.message);
    return NextResponse.json({ events: data ?? [] });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await parseBody(req, AdminNotificationsPatchSchema);
    const { sb } = await assertPlatformAdmin(req);

    const { error } = await sb.from("platform_notification_config")
      .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
      .eq("event_type", body.eventType);
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
