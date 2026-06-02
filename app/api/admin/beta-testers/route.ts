/**
 * GET   /api/admin/beta-testers — list applications, newest first.
 * PATCH /api/admin/beta-testers — update status by id.
 *
 * Admin-only (app_metadata.role === "admin").
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody, serviceClient,
} from "@/lib/api-helpers";
import { AdminBetaTesterPatchSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

async function assertPlatformAdmin(req: NextRequest) {
  const { user } = await getOperatorUser(req);
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") {
    throw new ForbiddenError("Caller is not a platform admin");
  }
  return user;
}

export async function GET(req: NextRequest) {
  try {
    await assertPlatformAdmin(req);
    const sb = serviceClient();
    const { data, error } = await sb
      .from("beta_testers")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return NextResponse.json({ applications: data });
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
    const body = await parseBody(req, AdminBetaTesterPatchSchema);
    const user = await assertPlatformAdmin(req);

    const sb = serviceClient();
    const update: Record<string, unknown> = {
      status:     body.status,
      updated_at: new Date().toISOString(),
    };
    if (body.status === "approved") {
      update.approved_at = new Date().toISOString();
      update.approved_by = user.id;
    }

    const { error } = await sb
      .from("beta_testers")
      .update(update)
      .eq("id", body.id);
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
