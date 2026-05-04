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
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function requireAuth(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { sb, user };
}

async function assertMember(
  sb: ReturnType<typeof serviceClient>,
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
  if (!data) throw new Error("Forbidden");
  if (requireAdmin && !["platform_admin", "admin"].includes(data.role as string)) throw new Error("Forbidden");
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
    const { sb, user } = await requireAuth(req);
    const body = (await req.json()) as {
      id?:        string;
      factoryId?: string;
      owner?:     string;
      token?:     string;
    };

    let owner: string | null = null;
    let token: string | null = null;

    if (body.id) {
      // Saved destination — load owner+token, check caller is a tenant
      // member (read suffices; verify doesn't mutate).
      const { data: row } = await sb
        .from("factory_output_destinations")
        .select("owner, token, tenant_id")
        .eq("id", body.id)
        .maybeSingle();
      if (!row) return NextResponse.json({ error: "NotFound" }, { status: 404 });
      await assertMember(sb, user.id, row.tenant_id as string, false);
      owner = row.owner as string;
      token = row.token as string;
    } else if (body.factoryId && body.owner && body.token) {
      // Inline credentials — caller must be admin/owner of the tenant
      // that owns the factory (same bar as creating a destination).
      const { data: factory } = await sb
        .from("factories")
        .select("tenant_id")
        .eq("id", body.factoryId)
        .maybeSingle();
      if (!factory) return NextResponse.json({ error: "NotFound" }, { status: 404 });
      await assertMember(sb, user.id, factory.tenant_id as string, true);
      owner = body.owner;
      token = body.token;
    } else {
      return NextResponse.json({ error: "Provide either `id` or `factoryId + owner + token`." }, { status: 400 });
    }

    const ownerNorm = owner.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").trim();
    const result = await verifyPair(ownerNorm, token);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: msg }, { status: 401 });
    if (msg === "Forbidden")    return NextResponse.json({ error: msg }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
