/**
 * PATCH  /api/factory/output-destinations/[id]
 * DELETE /api/factory/output-destinations/[id]
 *
 * Update or remove a single destination. Writes require owner/admin
 * on the destination's tenant.
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

async function authAndLoad(req: NextRequest, id: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");

  const { data: row } = await sb
    .from("factory_output_destinations")
    .select("id, tenant_id")
    .eq("id", id)
    .maybeSingle();
  if (!row) throw new Error("NotFound");

  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", row.tenant_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || !["platform_admin", "admin"].includes(member.role)) throw new Error("Forbidden");

  return { sb, row };
}

function maskToken(t: string): string {
  const s = t.trim();
  if (s.length < 6) return "●●●●";
  return `…${s.slice(-4)}`;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { sb } = await authAndLoad(req, id);
    const body = (await req.json()) as {
      name?: string;
      owner?: string;
      token?: string;
      branch?: string | null;
    };

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name  !== undefined) update.name  = body.name.trim();
    if (body.owner !== undefined) update.owner = body.owner.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").trim();
    if (body.token !== undefined) update.token = body.token.trim();
    if (body.branch !== undefined) update.branch = body.branch?.trim() || null;

    const { data, error } = await sb
      .from("factory_output_destinations")
      .update(update)
      .eq("id", id)
      .select("id, name, owner, token, branch, created_at, updated_at")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ error: `A destination with that name already exists.` }, { status: 409 });
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
    });
  } catch (e: unknown) {
    return mapError(e);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { sb } = await authAndLoad(req, id);

    const { error } = await sb
      .from("factory_output_destinations")
      .delete()
      .eq("id", id);
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
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
