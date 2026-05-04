/**
 * GET   /api/admin/beta-testers — list applications, newest first.
 * PATCH /api/admin/beta-testers — { id, status, approved_by? } update status.
 *
 * Admin-only (app_metadata.role === "admin").
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const ALLOWED_STATUS = new Set(["applied", "approved", "rejected", "active", "churned"]);

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

export async function GET(req: NextRequest) {
  try {
    await assertAdmin(req);
    const sb = serviceClient();
    const { data, error } = await sb
      .from("beta_testers")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return NextResponse.json({ applications: data });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: msg }, { status: 401 });
    if (msg === "Forbidden")    return NextResponse.json({ error: msg }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await assertAdmin(req);
    const body = (await req.json().catch(() => ({}))) as { id?: string; status?: string };
    if (!body.id)     return NextResponse.json({ error: "id is required" }, { status: 400 });
    if (!body.status || !ALLOWED_STATUS.has(body.status)) {
      return NextResponse.json({ error: `status must be one of ${[...ALLOWED_STATUS].join(", ")}` }, { status: 400 });
    }

    const sb = serviceClient();
    const update: Record<string, unknown> = {
      status:     body.status,
      updated_at: new Date().toISOString(),
    };
    if (body.status === "approved") {
      update.approved_at = new Date().toISOString();
      update.approved_by = user.id;
    }

    const { error } = await sb
      .from("beta_testers")
      .update(update)
      .eq("id", body.id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: msg }, { status: 401 });
    if (msg === "Forbidden")    return NextResponse.json({ error: msg }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
