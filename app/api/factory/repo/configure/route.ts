/**
 * POST /api/factory/repo/configure
 *
 * Upserts a factory ↔ repo binding (factory_repos row) for a given purpose
 * and rotates its verification token. Invalidates `verified_at` — the user
 * must re-verify after any change.
 *
 * Body: validated by FactoryRepoConfigureSchema in lib/api-schemas.ts.
 *
 * Authorization: caller must be platform_admin/admin of the factory's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { FactoryRepoConfigureSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, FactoryRepoConfigureSchema);
    const { user, sb } = await getOperatorUser(req);

    const { data: factory } = await sb
      .from("factories")
      .select("id, slug, tenant_id")
      .eq("id", body.factoryId)
      .maybeSingle();
    if (!factory) throw new NotFoundError("Factory not found");

    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", factory.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      throw new ForbiddenError("Caller is not an admin of this factory's tenant");
    }

    const branch = body.branch ?? "main";
    const token = randomUUID().replace(/-/g, "");

    const { error } = await sb
      .from("factory_repos")
      .upsert(
        {
          factory_id:   factory.id,
          purpose:      body.purpose,
          provider:     "github",
          owner:        body.owner,
          name:         body.repo,
          branch,
          verify_token: token,
          verified_at:  null,
          updated_at:   new Date().toISOString(),
        },
        { onConflict: "factory_id,purpose" },
      );
    if (error) throw new Error(error.message);

    return NextResponse.json({
      token,
      filePath: `factories/${factory.slug as string}/.twinpilot-verify`,
      purpose:  body.purpose,
    });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
