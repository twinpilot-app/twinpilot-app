/**
 * GET  /api/admin/curated-repos          — list (incl. disabled)
 * POST /api/admin/curated-repos          — create
 *
 * Admin-only mirror of /api/curated-repos. Returns disabled rows so
 * the admin UI can re-enable / edit them.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody, serviceClient,
} from "@/lib/api-helpers";
import { AdminCuratedRepoCreateSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

async function assertPlatformAdmin(req: NextRequest) {
  const { user } = await getOperatorUser(req);
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") {
    throw new ForbiddenError("Caller is not a platform admin");
  }
}

export async function GET(req: NextRequest) {
  try {
    await assertPlatformAdmin(req);
    const sb = serviceClient();
    const { data, error } = await sb
      .from("curated_repos")
      .select("*")
      .order("name");
    if (error) throw new Error(error.message);
    return NextResponse.json({ repos: data ?? [] });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, AdminCuratedRepoCreateSchema);
    await assertPlatformAdmin(req);
    const sb = serviceClient();

    const { data, error } = await sb
      .from("curated_repos")
      .insert({
        slug:           body.slug,
        name:           body.name,
        description:    body.description ?? "",
        repo_owner:     body.repo_owner,
        repo_name:      body.repo_name,
        default_branch: body.default_branch ?? null,
        paths:          body.paths ?? {},
        homepage_url:   body.homepage_url ?? null,
        enabled:        body.enabled ?? true,
      })
      .select("*")
      .single();
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json(
          { error: `A curated repo with slug "${body.slug}" already exists.`, code: "CONFLICT" },
          { status: 409 },
        );
      }
      throw new Error(error.message);
    }
    return NextResponse.json({ repo: data }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
