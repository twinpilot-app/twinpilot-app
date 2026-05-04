/**
 * POST /api/factory/repo/verify
 *
 * Fetches `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/factories/{slug}/.twinpilot-verify`
 * for the (factory, purpose) binding and compares content with the stored
 * token. On match, stamps `verified_at = now()` on that binding. Idempotent.
 *
 * Body: { factoryId: string; purpose: 'marketplace' | 'storage' }
 * Returns: { verified: true; verifiedAt: string } or { verified: false; reason }
 *
 * Authorization: caller must be owner/admin of the factory's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const ALLOWED_PURPOSES = new Set(["marketplace", "storage"]);

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertFactoryAdmin(req: NextRequest, factoryId: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: factory } = await sb.from("factories").select("id, slug, tenant_id").eq("id", factoryId).maybeSingle();
  if (!factory) throw new Error("NotFound");
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", factory.tenant_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || !["platform_admin", "admin"].includes(member.role)) throw new Error("Forbidden");
  return { sb, factory };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { factoryId?: string; purpose?: string };
    const factoryId = body.factoryId?.trim();
    const purpose = body.purpose?.trim().toLowerCase() ?? "";
    if (!factoryId) return NextResponse.json({ error: "factoryId is required" }, { status: 400 });
    if (!ALLOWED_PURPOSES.has(purpose)) {
      return NextResponse.json({ error: "Invalid purpose" }, { status: 400 });
    }

    const { sb, factory } = await assertFactoryAdmin(req, factoryId);

    const { data: binding } = await sb
      .from("factory_repos")
      .select("owner, name, branch, verify_token")
      .eq("factory_id", factory.id)
      .eq("purpose", purpose)
      .maybeSingle();

    if (!binding || !binding.verify_token) {
      return NextResponse.json({ verified: false, reason: "Repository not configured" }, { status: 400 });
    }

    const url = `https://raw.githubusercontent.com/${binding.owner}/${binding.name}/${binding.branch}/factories/${factory.slug}/.twinpilot-verify`;

    let fetched: string;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 404) {
        return NextResponse.json({
          verified: false,
          reason: `File not found. Expected at ${url}`,
        });
      }
      if (!res.ok) {
        return NextResponse.json({
          verified: false,
          reason: `GitHub returned ${res.status} fetching ${url}`,
        });
      }
      fetched = (await res.text()).trim();
    } catch (err) {
      return NextResponse.json({
        verified: false,
        reason: `Network error fetching ${url}: ${(err as Error).message}`,
      });
    }

    if (fetched !== binding.verify_token) {
      return NextResponse.json({
        verified: false,
        reason: "Token in repo does not match. Make sure the file contains only the verification token and no extra whitespace or newlines.",
      });
    }

    const now = new Date().toISOString();
    const { error } = await sb
      .from("factory_repos")
      .update({ verified_at: now, updated_at: now })
      .eq("factory_id", factory.id)
      .eq("purpose", purpose);
    if (error) throw new Error(error.message);

    return NextResponse.json({ verified: true, verifiedAt: now });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
