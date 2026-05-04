/**
 * GET /api/studio/session?factoryId={id}
 *
 * Returns the active Studio Wizard draft for the calling user in the
 * specified factory. Returns `{ session: null }` when no draft exists yet
 * (the chat tools lazy-create on first stage operation, so the UI doesn't
 * need to POST anything to bootstrap).
 *
 * Returns: { session: StudioSessionRow | null, pendingCount: number }
 *
 * Authorization: Bearer {supabase access_token}; caller must be a member
 * of the factory's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getActiveSession } from "@/lib/studio-session";
import { studioPlanPendingCount } from "@/lib/studio-plan-types";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertAuth(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { sb, user };
}

export async function GET(req: NextRequest) {
  try {
    const { sb, user } = await assertAuth(req);
    const factoryId = req.nextUrl.searchParams.get("factoryId");
    if (!factoryId) return NextResponse.json({ error: "factoryId is required" }, { status: 400 });

    // Confirm caller is in the factory's tenant before reading the session.
    const { data: factory } = await sb
      .from("factories")
      .select("tenant_id")
      .eq("id", factoryId)
      .maybeSingle();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", factory.tenant_id as string)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const session = await getActiveSession(sb, user.id, factoryId);
    return NextResponse.json({
      session,
      pendingCount: session ? studioPlanPendingCount(session.plan) : 0,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}
