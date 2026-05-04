/**
 * DELETE /api/studio/sessions/:id/items?type={squad|agent|pipeline|project|operation}&id={itemId}
 *
 * Soft-discards a single staged entry from the session's plan. The entry is
 * moved to plan.discarded for chat-history continuity (so the LLM can say
 * "you discarded X" if asked); the confirm endpoint filters discarded
 * entries out automatically.
 *
 * For "operation" the `id` is the array index as a string (operations are
 * not addressable by id today).
 *
 * Authorization: caller must own the session AND be owner/admin of the
 * tenant. Same gate as DELETE /api/studio/sessions/:id.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSessionById, discardItem } from "@/lib/studio-session";
import { studioPlanPendingCount, type DiscardedEntry } from "@/lib/studio-plan-types";

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

const VALID_TYPES: ReadonlySet<DiscardedEntry["type"]> = new Set(["agent", "pipeline", "project", "backlog", "operation"]);

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { sb, user } = await assertAuth(req);
    const { id: sessionId } = await params;
    const type = req.nextUrl.searchParams.get("type");
    const itemId = req.nextUrl.searchParams.get("id");
    if (!type || !VALID_TYPES.has(type as DiscardedEntry["type"])) {
      return NextResponse.json({ error: "type must be one of agent|pipeline|project|backlog|operation" }, { status: 400 });
    }
    if (!itemId) return NextResponse.json({ error: "id query param required" }, { status: 400 });

    const session = await getSessionById(sb, sessionId);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (session.user_id !== user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (session.status !== "draft") {
      return NextResponse.json({ error: `Session is ${session.status}, cannot discard items` }, { status: 409 });
    }
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", session.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member || !["platform_admin", "admin"].includes(member.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = await discardItem(sb, sessionId, type as DiscardedEntry["type"], itemId);
    if (!result.ok) {
      return NextResponse.json({ error: `Item ${type}/${itemId} not found in plan` }, { status: 404 });
    }

    // Return the updated counts so the caller doesn't need a follow-up GET
    const refreshed = await getSessionById(sb, sessionId);
    return NextResponse.json({
      ok: true,
      pendingCount: refreshed ? studioPlanPendingCount(refreshed.plan) : 0,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}
