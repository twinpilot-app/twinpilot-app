/**
 * POST /api/notifications/read-all — mark all unread notifications as read
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { NotificationsTenantOpSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { tenantId } = await parseBody(req, NotificationsTenantOpSchema);
    const { user, sb } = await getOperatorUser(req);

    const { data: member } = await sb
      .from("tenant_members").select("id")
      .eq("tenant_id", tenantId).eq("user_id", user.id).maybeSingle();
    if (!member) throw new ForbiddenError("Caller is not a member of this tenant");

    const { error } = await sb.from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .is("read_at", null);
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
