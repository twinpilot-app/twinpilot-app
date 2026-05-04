/**
 * PATCH  /api/admin/invites/:id — toggle active field
 * DELETE /api/admin/invites/:id — delete invite code
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

async function assertAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") throw new Error("Forbidden");
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertAdmin(req);
    const { id } = await params;
    const sb = serviceClient();

    // Get current state
    const { data: current, error: fetchErr } = await sb
      .from("invite_codes")
      .select("active")
      .eq("id", id)
      .single();
    if (fetchErr || !current) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { error } = await sb
      .from("invite_codes")
      .update({ active: !current.active })
      .eq("id", id);
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, active: !current.active });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertAdmin(req);
    const { id } = await params;
    const sb = serviceClient();
    const { error } = await sb.from("invite_codes").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}
