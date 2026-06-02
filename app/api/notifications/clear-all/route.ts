/**
 * POST /api/notifications/clear-all — delete all tenant-scope notifications
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

    // Get all tenant-scope notification IDs
    const { data: notifs } = await sb
      .from("notifications")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("scope", "tenant");

    if (notifs && notifs.length > 0) {
      const ids = notifs.map((n) => n.id as string);
      await sb.from("notification_deliveries").delete().in("notification_id", ids);
      await sb.from("notifications").delete().in("id", ids);
    }

    return NextResponse.json({ ok: true, deleted: notifs?.length ?? 0 });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
