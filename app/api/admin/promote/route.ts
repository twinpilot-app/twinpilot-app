import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { email: string; secret: string; password?: string };

    if (!process.env.ADMIN_PROMOTE_SECRET || body.secret !== process.env.ADMIN_PROMOTE_SECRET) {
      return NextResponse.json({ error: "Invalid secret" }, { status: 403 });
    }

    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );

    const { data: { users }, error: listErr } = await sb.auth.admin.listUsers();
    if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });

    const user = users.find((u) => u.email === body.email);
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: any = { app_metadata: { ...user.app_metadata, role: "admin" } };
    if (body.password) update.password = body.password;

    const { error } = await sb.auth.admin.updateUserById(user.id, update);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, email: body.email });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
