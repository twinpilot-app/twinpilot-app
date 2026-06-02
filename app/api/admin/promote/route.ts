/**
 * POST /api/admin/promote
 *
 * Bootstrap-only escalation: a caller with the ADMIN_PROMOTE_SECRET
 * env var promotes a known email to platform_admin via service_role.
 * Optionally sets a new password (used on the first promotion when the
 * auth user was just created).
 *
 * The secret is the gate — no Bearer auth required. Body is Zod-capped
 * so a giant payload can't slip past the secret check.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  errorResponse, parseBody, serviceClient,
} from "@/lib/api-helpers";
import { AdminPromoteSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, AdminPromoteSchema);

    if (!process.env.ADMIN_PROMOTE_SECRET || body.secret !== process.env.ADMIN_PROMOTE_SECRET) {
      throw new ForbiddenError("Invalid secret");
    }

    const sb = serviceClient();
    const { data: { users }, error: listErr } = await sb.auth.admin.listUsers();
    if (listErr) throw new Error(listErr.message);

    const user = users.find((u) => u.email === body.email);
    if (!user) throw new NotFoundError("User not found");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: any = { app_metadata: { ...user.app_metadata, role: "admin" } };
    if (body.password) update.password = body.password;

    const { error } = await sb.auth.admin.updateUserById(user.id, update);
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, email: body.email });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
