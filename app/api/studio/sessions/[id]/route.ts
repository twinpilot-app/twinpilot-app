/**
 * GET    /api/studio/sessions/:id
 * DELETE /api/studio/sessions/:id    (discard the draft)
 *
 * GET returns the full session row + a pendingCount convenience field.
 * DELETE flips status='discarded' (soft — row stays for audit). Does NOT
 * touch already-confirmed sessions.
 *
 * Authorization: Bearer {supabase access_token}. Caller must own the
 * session (session.user_id === auth.uid()) AND be owner/admin of the
 * tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSessionById, discardSession } from "@/lib/studio-session";
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

async function loadAndAuthorise(req: NextRequest, sessionId: string) {
  const { sb, user } = await assertAuth(req);
  const session = await getSessionById(sb, sessionId);
  if (!session) throw new Error("NotFound");
  if (session.user_id !== user.id) throw new Error("Forbidden");
  // Belt-and-braces — session.user_id should already imply tenant membership,
  // but tenant_members role might have been revoked since the draft was
  // created. Block writes when the role no longer permits it.
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", session.tenant_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || !["platform_admin", "admin"].includes(member.role)) throw new Error("Forbidden");
  return { sb, session };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { session } = await loadAndAuthorise(req, id);
    return NextResponse.json({
      session,
      pendingCount: studioPlanPendingCount(session.plan),
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { sb, session } = await loadAndAuthorise(req, id);
    if (session.status !== "draft") {
      // Can't discard a confirmed session (it's already committed) or a
      // discarded one (already done). Return a clear error so the UI can
      // refresh and update its state.
      return NextResponse.json({
        error: `Session is ${session.status}, not draft — nothing to discard.`,
      }, { status: 409 });
    }
    await discardSession(sb, id);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
