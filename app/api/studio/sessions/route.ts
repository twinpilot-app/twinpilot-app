/**
 * GET /api/studio/sessions?factoryId={id}&status={draft|confirmed|all}&limit={n}
 *
 * Returns the caller's Studio Wizard sessions for a factory, with summary
 * fields suitable for the drafts page header (resumable draft) and the
 * audit panel (recent confirmations).
 *
 * - status=draft     → only the active draft (at most one — partial unique
 *                      index on (user_id, factory_id) WHERE status='draft').
 * - status=confirmed → confirmed history, newest first.
 * - status=all (default) → drafts first, then confirmed history.
 *
 * Discarded sessions are not returned (operator chose to drop them — no
 * audit value). Auto-expire of stale drafts to status=discarded is run
 * opportunistically here (W3c) so this endpoint doubles as a sweeper —
 * no cron required.
 *
 * Response: { sessions: SessionSummary[] }
 *
 * Authorization: caller must be a tenant member of the factory's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { StudioPlan, StagedId } from "@/lib/studio-plan-types";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT  = 20;
const MAX_LIMIT      = 100;
const DRAFT_EXPIRY_DAYS = 30;

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

interface SessionSummary {
  id:           string;
  status:       "draft" | "confirmed" | "discarded";
  created_at:   string;
  updated_at:   string;
  confirmed_at: string | null;
  counts: {
    agents:     number;
    pipelines:  number;
    projects:   number;
    operations: number;
  };
  /** Only present for confirmed sessions — synthetic→real id mapping. */
  committed?: {
    agents:    Record<StagedId, string>;
    pipelines: Record<StagedId, string>;
    projects:  Record<StagedId, string>;
  };
}

export async function GET(req: NextRequest) {
  try {
    const { sb, user } = await assertAuth(req);
    const factoryId = req.nextUrl.searchParams.get("factoryId");
    if (!factoryId) return NextResponse.json({ error: "factoryId is required" }, { status: 400 });

    const statusParam = (req.nextUrl.searchParams.get("status") ?? "all") as "draft" | "confirmed" | "all";
    const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT, 1), MAX_LIMIT);

    // Tenant membership check.
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

    // ── Auto-expire stale drafts (W3c) ─────────────────────────────────
    // Opportunistic — runs whenever someone lists sessions, no cron. The
    // partial unique index allows multiple discarded rows so the writes
    // never conflict.
    const cutoff = new Date(Date.now() - DRAFT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await sb
      .from("studio_sessions")
      .update({ status: "discarded", discarded_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("factory_id", factoryId)
      .eq("status", "draft")
      .lt("updated_at", cutoff);

    // ── Fetch sessions for this user/factory ──────────────────────────
    const wantStatuses: ("draft" | "confirmed")[] =
      statusParam === "draft"     ? ["draft"]
      : statusParam === "confirmed" ? ["confirmed"]
      : ["draft", "confirmed"];
    const { data: rows } = await sb
      .from("studio_sessions")
      .select("id, status, plan, created_at, updated_at, confirmed_at")
      .eq("user_id", user.id)
      .eq("factory_id", factoryId)
      .in("status", wantStatuses)
      .order("status", { ascending: true })  // 'confirmed' < 'draft' lexicographically; flip below
      .order("created_at", { ascending: false })
      .limit(limit);

    const sessions: SessionSummary[] = (rows ?? []).map((r) => {
      const plan = (r.plan as StudioPlan | null) ?? null;
      return {
        id:           r.id as string,
        status:       r.status as "draft" | "confirmed" | "discarded",
        created_at:   r.created_at as string,
        updated_at:   r.updated_at as string,
        confirmed_at: (r.confirmed_at as string | null) ?? null,
        counts: {
          agents:     plan?.agents?.length     ?? 0,
          pipelines:  plan?.pipelines?.length  ?? 0,
          projects:   plan?.projects?.length   ?? 0,
          operations: plan?.operations?.length ?? 0,
        },
        committed: plan?.committed
          ? {
              agents:    plan.committed.agents    ?? {},
              pipelines: plan.committed.pipelines ?? {},
              projects:  plan.committed.projects  ?? {},
            }
          : undefined,
      };
    });

    // Drafts always first regardless of status sort (helps the resume UX);
    // confirmed sessions follow newest-first.
    sessions.sort((a, b) => {
      if (a.status === "draft" && b.status !== "draft") return -1;
      if (a.status !== "draft" && b.status === "draft") return 1;
      return (b.created_at || "").localeCompare(a.created_at || "");
    });

    return NextResponse.json({ sessions });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}
