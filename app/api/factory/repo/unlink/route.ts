/**
 * POST /api/factory/repo/unlink
 *
 * Deletes the (factory, purpose) repo binding. Used to disconnect or re-bind
 * to a different repo.
 *
 * Body: validated by FactoryRepoBindingRefSchema (factoryId + purpose).
 * Returns: { ok: true }
 *
 * Authorization: caller must be platform_admin/admin of the factory's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { FactoryRepoBindingRefSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, FactoryRepoBindingRefSchema);
    const { user, sb } = await getOperatorUser(req);

    const { data: factory } = await sb
      .from("factories")
      .select("id, tenant_id")
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

    const { error } = await sb
      .from("factory_repos")
      .delete()
      .eq("factory_id", factory.id)
      .eq("purpose", body.purpose);
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
