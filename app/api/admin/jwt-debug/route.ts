/**
 * GET /api/admin/jwt-debug
 *
 * Diagnostic for worker JWT signing. Admin-only.
 *
 * Mints a throwaway JWT using the same path as the sprint dispatcher,
 * decodes the header, fetches the Supabase JWKS, and attempts a live
 * REST call with the token so you can see exactly why Supabase is
 * (or isn't) accepting it.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { mintWorkerToken } from "@/lib/worker-jwt";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") throw new Error("Forbidden");
  return user;
}

function decodeJwtHeader(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[0], "base64").toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    await assertAdmin(req);

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey     = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const config = {
      SUPABASE_URL_set:         !!supabaseUrl,
      SUPABASE_ANON_KEY_set:    !!anonKey,
      SUPABASE_JWT_PRIVATE_KEY_set: !!process.env.SUPABASE_JWT_PRIVATE_KEY,
      SUPABASE_JWT_KID_set:     !!process.env.SUPABASE_JWT_KID,
      SUPABASE_JWT_KID_value:   process.env.SUPABASE_JWT_KID ?? null,
      SUPABASE_JWT_SECRET_set:  !!process.env.SUPABASE_JWT_SECRET,
      chosen_alg:               process.env.SUPABASE_JWT_PRIVATE_KEY ? "ES256" : process.env.SUPABASE_JWT_SECRET ? "HS256" : "none",
    };

    // Mint a throwaway token (probe tenant id — no RLS row will match).
    let token: string | null = null;
    let mintError: string | null = null;
    let header: Record<string, unknown> | null = null;
    try {
      const minted = mintWorkerToken({
        tenantId: "00000000-0000-0000-0000-000000000001",
        factoryId: "00000000-0000-0000-0000-000000000002",
        ttlSeconds: 60,
      });
      token = minted.token;
      header = decodeJwtHeader(token);
    } catch (e) {
      mintError = (e as Error).message;
    }

    // Fetch Supabase's JWKS so we can compare kids.
    let jwks: { keys: Array<Record<string, unknown>> } | null = null;
    let jwksError: string | null = null;
    if (supabaseUrl) {
      try {
        const res = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, {
          headers: anonKey ? { apikey: anonKey } : {},
          cache: "no-store",
        });
        if (!res.ok) {
          jwksError = `JWKS ${res.status}: ${(await res.text()).slice(0, 200)}`;
        } else {
          jwks = await res.json() as { keys: Array<Record<string, unknown>> };
        }
      } catch (e) {
        jwksError = (e as Error).message;
      }
    }

    const jwksKids = jwks?.keys?.map((k) => ({
      kid: k.kid as string | undefined,
      alg: k.alg as string | undefined,
      kty: k.kty as string | undefined,
      crv: k.crv as string | undefined,
      use: k.use as string | undefined,
    })) ?? [];

    const headerKid = header?.kid as string | undefined;
    const kidMatch = headerKid ? jwksKids.some((k) => k.kid === headerKid) : null;

    // Live probe — hit Supabase REST with the minted token.
    let probe: { status: number | null; body: string | null; error: string | null } = { status: null, body: null, error: null };
    if (token && supabaseUrl && anonKey) {
      try {
        const res = await fetch(`${supabaseUrl}/rest/v1/`, {
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${token}`,
          },
        });
        probe = { status: res.status, body: (await res.text()).slice(0, 500), error: null };
      } catch (e) {
        probe = { status: null, body: null, error: (e as Error).message };
      }
    }

    return NextResponse.json({
      config,
      mint: {
        ok: !!token,
        error: mintError,
        header,
      },
      jwks: {
        error: jwksError,
        kids: jwksKids,
      },
      verdict: {
        headerKid: headerKid ?? null,
        kidMatchesJwks: kidMatch,
        advice: advise({ headerKid, kidMatch, probe, jwksKids, config }),
      },
      probe,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized" || msg === "Forbidden") {
      return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function advise(ctx: {
  headerKid: string | undefined;
  kidMatch: boolean | null;
  probe: { status: number | null };
  jwksKids: Array<{ kid?: string; alg?: string }>;
  config: { chosen_alg: string };
}): string {
  if (ctx.config.chosen_alg === "none") {
    return "Neither SUPABASE_JWT_PRIVATE_KEY nor SUPABASE_JWT_SECRET is set. Configure one in Vercel.";
  }
  if (!ctx.headerKid && ctx.config.chosen_alg === "ES256") {
    return "Token has no `kid` header. Set SUPABASE_JWT_KID in Vercel to the kid Supabase assigned to your public key.";
  }
  if (ctx.headerKid && ctx.kidMatch === false) {
    const available = ctx.jwksKids.map((k) => k.kid).filter(Boolean).join(", ") || "(none)";
    return `Token kid "${ctx.headerKid}" is NOT in the Supabase JWKS. Available kids: ${available}. Update SUPABASE_JWT_KID in Vercel to one of those, or add your public key to Supabase → Auth → JWT Keys.`;
  }
  if (ctx.probe.status === 401) {
    return "Kid matches JWKS but Supabase still returned 401 — check that the public key in Supabase matches the private key in Vercel (same P-256 pair), and that the key is not revoked.";
  }
  if (ctx.probe.status && ctx.probe.status < 400) {
    return "Token accepted by Supabase. Signing is healthy.";
  }
  return "Inconclusive — inspect the `probe` field for the raw Supabase response.";
}
