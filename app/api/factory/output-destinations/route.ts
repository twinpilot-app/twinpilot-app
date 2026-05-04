/**
 * GET  /api/factory/output-destinations?factoryId=…
 * POST /api/factory/output-destinations
 *
 * Manages per-factory GitHub destinations. A destination is a named
 * (owner, PAT) pair — projects inside the factory pick one or more of
 * these to receive committed sprint artifacts.
 *
 * Reading: any tenant member can list (tokens are masked — only the
 * last 4 chars are returned).
 * Writing: restricted to owner/admin roles.
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

async function loadFactory(sb: ReturnType<typeof serviceClient>, factoryId: string) {
  const { data: factory } = await sb
    .from("factories")
    .select("id, tenant_id")
    .eq("id", factoryId)
    .maybeSingle();
  if (!factory) throw new Error("NotFound");
  return factory;
}

async function assertMember(sb: ReturnType<typeof serviceClient>, userId: string, tenantId: string) {
  const { data } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
  return data.role as string;
}

function maskToken(t: string): string {
  const s = t.trim();
  if (s.length < 6) return "●●●●";
  return `…${s.slice(-4)}`;
}

/* ── GET: list factory's destinations ──────────────────────────────── */

export async function GET(req: NextRequest) {
  const factoryId = req.nextUrl.searchParams.get("factoryId");
  if (!factoryId) return NextResponse.json({ error: "factoryId required" }, { status: 400 });

  try {
    const { sb, user } = await requireAuth(req);
    const factory = await loadFactory(sb, factoryId);
    await assertMember(sb, user.id, factory.tenant_id);

    const { data, error } = await sb
      .from("factory_output_destinations")
      .select("id, name, owner, token, branch, created_at, updated_at")
      .eq("factory_id", factoryId)
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);

    const destinations = (data ?? []).map((row) => ({
      id:        row.id as string,
      name:      row.name as string,
      owner:     row.owner as string,
      tokenMask: maskToken(row.token as string),
      branch:    (row.branch as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }));

    return NextResponse.json({ destinations });
  } catch (e: unknown) {
    return mapError(e);
  }
}

/* ── POST: create a destination ────────────────────────────────────── */

export async function POST(req: NextRequest) {
  try {
    const { sb, user } = await requireAuth(req);
    const body = (await req.json()) as {
      factoryId?: string;
      name?: string;
      owner?: string;
      token?: string;
      branch?: string;
    };
    if (!body.factoryId || !body.name || !body.owner || !body.token) {
      return NextResponse.json({ error: "factoryId, name, owner and token are required" }, { status: 400 });
    }
    const factory = await loadFactory(sb, body.factoryId);
    const role = await assertMember(sb, user.id, factory.tenant_id);
    if (!["platform_admin", "admin"].includes(role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Normalise owner: strip https://github.com/ if pasted in.
    const owner = body.owner.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").trim();

    const { data, error } = await sb
      .from("factory_output_destinations")
      .insert({
        tenant_id:  factory.tenant_id,
        factory_id: body.factoryId,
        name:       body.name.trim(),
        owner,
        token:      body.token.trim(),
        branch:     body.branch?.trim() || null,
      })
      .select("id, name, owner, token, branch, created_at, updated_at")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: `A destination named "${body.name}" already exists on this factory.` }, { status: 409 });
      }
      throw new Error(error.message);
    }

    return NextResponse.json({
      destination: {
        id:        data.id as string,
        name:      data.name as string,
        owner:     data.owner as string,
        tokenMask: maskToken(data.token as string),
        branch:    (data.branch as string | null) ?? null,
        createdAt: data.created_at as string,
        updatedAt: data.updated_at as string,
      },
    }, { status: 201 });
  } catch (e: unknown) {
    return mapError(e);
  }
}

function mapError(e: unknown): NextResponse {
  const msg = (e as Error).message;
  if (msg === "Unauthorized") return NextResponse.json({ error: msg }, { status: 401 });
  if (msg === "Forbidden")    return NextResponse.json({ error: msg }, { status: 403 });
  if (msg === "NotFound")     return NextResponse.json({ error: msg }, { status: 404 });
  return NextResponse.json({ error: msg }, { status: 500 });
}
