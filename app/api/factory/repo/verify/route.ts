/**
 * POST /api/factory/repo/verify
 *
 * Fetches `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/factories/{slug}/.twinpilot-verify`
 * for the (factory, purpose) binding and compares content with the stored
 * token. On match, stamps `verified_at = now()` on that binding. Idempotent.
 *
 * Body: validated by FactoryRepoBindingRefSchema (factoryId + purpose).
 * Returns: { verified: true; verifiedAt: string } or { verified: false; reason }
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

    const { data: binding } = await sb
      .from("factory_repos")
      .select("owner, name, branch, verify_token")
      .eq("factory_id", factory.id)
      .eq("purpose", body.purpose)
      .maybeSingle();
    if (!binding || !binding.verify_token) {
      return NextResponse.json({ verified: false, reason: "Repository not configured" }, { status: 400 });
    }

    const url = `https://raw.githubusercontent.com/${binding.owner as string}/${binding.name as string}/${binding.branch as string}/factories/${factory.slug as string}/.twinpilot-verify`;

    let fetched: string;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 404) {
        return NextResponse.json({
          verified: false,
          reason:   `File not found. Expected at ${url}`,
        });
      }
      if (!res.ok) {
        return NextResponse.json({
          verified: false,
          reason:   `GitHub returned ${res.status} fetching ${url}`,
        });
      }
      fetched = (await res.text()).trim();
    } catch (err) {
      return NextResponse.json({
        verified: false,
        reason:   `Network error fetching ${url}: ${(err as Error).message}`,
      });
    }

    if (fetched !== binding.verify_token) {
      return NextResponse.json({
        verified: false,
        reason:   "Token in repo does not match. Make sure the file contains only the verification token and no extra whitespace or newlines.",
      });
    }

    const now = new Date().toISOString();
    const { error } = await sb
      .from("factory_repos")
      .update({ verified_at: now, updated_at: now })
      .eq("factory_id", factory.id)
      .eq("purpose", body.purpose);
    if (error) throw new Error(error.message);

    return NextResponse.json({ verified: true, verifiedAt: now });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
