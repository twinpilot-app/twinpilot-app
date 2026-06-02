/**
 * POST /api/factory/output-destinations/verify
 *
 * Tests a (owner, token) pair against GitHub: is the token valid, does
 * the owner exist, can the token create repos under that owner.
 *
 * Body (two forms):
 *   - { id }                       — verify a saved destination
 *   - { factoryId, owner, token }  — verify inline credentials before
 *                                    saving (used by the Factory Manager
 *                                    form so users know the PAT works
 *                                    without committing a bad row).
 *
 * Returns:
 *   {
 *     ok:         boolean,
 *     tokenUser?: string,              // "octocat" — user the token authenticates as
 *     ownerType?: "User"|"Organization",
 *     canWriteRepo?: boolean,          // heuristic — see logic below
 *     error?:     string,
 *   }
 *
 * This is a read-only probe — it never mutates GitHub state.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { FactoryOutputDestinationVerifySchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function assertMember(
  sb: SupabaseClient,
  userId: string,
  tenantId: string,
  requireAdmin: boolean,
) {
  const { data } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new ForbiddenError("Caller is not a member of this tenant");
  if (requireAdmin && !["platform_admin", "admin"].includes(data.role as string)) {
    throw new ForbiddenError("Caller lacks admin role on this tenant");
  }
}

interface VerifyResult {
  ok:            boolean;
  tokenUser?:    string;
  ownerType?:    "User" | "Organization";
  canWriteRepo?: boolean;
  error?:        string;
}

async function verifyPair(owner: string, token: string): Promise<VerifyResult> {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "twin-pilot",
  };

  // 1. Token validity + identify the authenticating user.
  let tokenUser: string;
  try {
    const res = await fetch("https://api.github.com/user", { headers });
    if (res.status === 401) return { ok: false, error: "Token is invalid or expired." };
    if (!res.ok) return { ok: false, error: `GitHub /user returned ${res.status}.` };
    const body = await res.json() as { login?: string };
    if (!body.login) return { ok: false, error: "Token is valid but GitHub did not return a user login." };
    tokenUser = body.login;
  } catch (e) {
    return { ok: false, error: `Could not reach GitHub: ${(e as Error).message}` };
  }

  // 2. Owner exists + owner type.
  let ownerType: "User" | "Organization";
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(owner)}`, { headers });
    if (res.status === 404) return { ok: false, tokenUser, error: `Owner "${owner}" does not exist on GitHub.` };
    if (!res.ok) return { ok: false, tokenUser, error: `GitHub /users returned ${res.status}.` };
    const body = await res.json() as { type?: string };
    if (body.type !== "User" && body.type !== "Organization") {
      return { ok: false, tokenUser, error: `Unknown owner type returned by GitHub (${body.type}).` };
    }
    ownerType = body.type;
  } catch (e) {
    return { ok: false, tokenUser, error: `Could not check owner: ${(e as Error).message}` };
  }

  // 3. Can the token write under that owner?
  //    - User owner: true iff token.login matches the owner.
  //    - Org owner:  check membership via /orgs/{owner}/members/{tokenUser}.
  //      204 = public member, 302 = private member (follow), 404 = not a
  //      member (or token lacks read:org). We downgrade a 404 to a
  //      warning rather than a hard no — some tokens have write access
  //      to specific repos without org membership visible.
  let canWriteRepo = false;
  let warning: string | undefined;
  if (ownerType === "User") {
    canWriteRepo = tokenUser.toLowerCase() === owner.toLowerCase();
    if (!canWriteRepo) {
      warning = `Token belongs to user "${tokenUser}" which differs from owner "${owner}" — personal repos can only be created by the matching user.`;
    }
  } else {
    try {
      const res = await fetch(
        `https://api.github.com/orgs/${encodeURIComponent(owner)}/members/${encodeURIComponent(tokenUser)}`,
        { headers, redirect: "manual" },
      );
      if (res.status === 204 || res.status === 302) {
        canWriteRepo = true;
      } else {
        warning = `Could not confirm that "${tokenUser}" is a member of "${owner}" (HTTP ${res.status}). Token may still work if it has explicit repo scope.`;
      }
    } catch (e) {
      warning = `Org membership check failed: ${(e as Error).message}`;
    }
  }

  return {
    ok: true,
    tokenUser,
    ownerType,
    canWriteRepo,
    error: canWriteRepo ? undefined : warning,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, FactoryOutputDestinationVerifySchema);
    const { user, sb } = await getOperatorUser(req);

    let owner: string;
    let token: string;

    if ("id" in body) {
      // Saved destination — load owner+token, check caller is a tenant
      // member (read suffices; verify doesn't mutate).
      const { data: row } = await sb
        .from("factory_output_destinations")
        .select("owner, token, tenant_id")
        .eq("id", body.id)
        .maybeSingle();
      if (!row) throw new NotFoundError("Destination not found");
      await assertMember(sb, user.id, row.tenant_id as string, false);
      owner = row.owner as string;
      token = row.token as string;
    } else {
      // Inline credentials — caller must be admin/owner of the tenant
      // that owns the factory (same bar as creating a destination).
      const { data: factory } = await sb
        .from("factories")
        .select("tenant_id")
        .eq("id", body.factoryId)
        .maybeSingle();
      if (!factory) throw new NotFoundError("Factory not found");
      await assertMember(sb, user.id, factory.tenant_id as string, true);
      owner = body.owner;
      token = body.token;
    }

    const ownerNorm = owner.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").trim();
    const result = await verifyPair(ownerNorm, token);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
