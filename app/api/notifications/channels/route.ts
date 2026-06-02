/**
 * GET    /api/notifications/channels?tenantId=... — get channel configs
 * PUT    /api/notifications/channels — insert channel config
 * DELETE /api/notifications/channels?tenantId=...&id=... — drop channel
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { NotificationsChannelUpsertSchema } from "@/lib/api-schemas";

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

    const { data, error } = await sb.from("notification_channel_config")
      .select("id, channel, name, config, enabled, integration_type")
      .eq("tenant_id", tenantId);
    if (error) throw new Error(error.message);

    return NextResponse.json({ channels: data ?? [] });
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
    const body = await parseBody(req, NotificationsChannelUpsertSchema);
    const { user, sb } = await getOperatorUser(req);

    const { data: member } = await sb.from("tenant_members").select("role")
      .eq("tenant_id", body.tenantId).eq("user_id", user.id).maybeSingle();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      throw new ForbiddenError("Caller is not an admin of this tenant");
    }

    const { error } = await sb.from("notification_channel_config").insert({
      tenant_id:        body.tenantId,
      channel:          body.channel,
      name:             body.name ?? null,
      config:           body.config ?? {},
      enabled:          body.enabled ?? false,
      integration_type: body.integration_type ?? "custom",
      updated_at:       new Date().toISOString(),
    });

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

export async function DELETE(req: NextRequest) {
  try {
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    const id       = req.nextUrl.searchParams.get("id");
    if (!tenantId || !id) {
      return NextResponse.json({ error: "tenantId and id required", code: "VALIDATION_ERROR" }, { status: 400 });
    }
    const { user, sb } = await getOperatorUser(req);

    const { data: member } = await sb.from("tenant_members").select("role")
      .eq("tenant_id", tenantId).eq("user_id", user.id).maybeSingle();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      throw new ForbiddenError("Caller is not an admin of this tenant");
    }

    const { error } = await sb.from("notification_channel_config").delete().eq("id", id).eq("tenant_id", tenantId);
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
