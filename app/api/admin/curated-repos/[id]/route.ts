/**
 * PATCH  /api/admin/curated-repos/[id]   — update fields
 * DELETE /api/admin/curated-repos/[id]   — drop the row
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody, serviceClient,
} from "@/lib/api-helpers";
import { AdminCuratedRepoPatchSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

async function assertPlatformAdmin(req: NextRequest) {
  const { user } = await getOperatorUser(req);
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") {
    throw new ForbiddenError("Caller is not a platform admin");
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = await parseBody(req, AdminCuratedRepoPatchSchema);
    await assertPlatformAdmin(req);
    const { id } = await params;
    const sb = serviceClient();

    const patch: Record<string, unknown> = {};
    if (body.slug           !== undefined) patch.slug           = body.slug;
    if (body.name           !== undefined) patch.name           = body.name;
    if (body.description    !== undefined) patch.description    = body.description;
    if (body.repo_owner     !== undefined) patch.repo_owner     = body.repo_owner;
    if (body.repo_name      !== undefined) patch.repo_name      = body.repo_name;
    if (body.default_branch !== undefined) patch.default_branch = body.default_branch;
    if (body.paths          !== undefined) patch.paths          = body.paths;
    if (body.homepage_url   !== undefined) patch.homepage_url   = body.homepage_url;
    if (body.enabled        !== undefined) patch.enabled        = body.enabled;

    if (Object.keys(patch).length === 0) throw new ValidationError("no fields to update", []);

    const { data, error } = await sb
      .from("curated_repos")
      .update(patch)
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return NextResponse.json({ repo: data });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertPlatformAdmin(req);
    const { id } = await params;
    const sb = serviceClient();
    const { error } = await sb.from("curated_repos").delete().eq("id", id);
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
