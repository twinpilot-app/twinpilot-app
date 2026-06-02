/**
 * POST /api/waiting-list
 *
 * Public endpoint — no auth. Accepts a waiting-list sign-up from the landing
 * page modal. Writes via service-role client (table has no public INSERT
 * policy).
 *
 * Body: { organization: string; name: string; email: string }
 * Returns: { ok: true } on success, { error: string } on validation/rate limit.
 *
 * Security:
 *   - Input validation (email regex, length bounds)
 *   - Rate limit per email: rejects if same email submitted in the last 10min
 *     (DB-based — no in-memory state). Prevents trivial spam resubmission.
 *   - IP + user-agent captured for admin audit / fraud review.
 *   - Response does NOT disclose whether an email is already on the list
 *     (returns 200 on dedupe and on fresh insert alike, to prevent email
 *     enumeration).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  ValidationError, errorResponse, parseBody, serviceClient,
} from "@/lib/api-helpers";
import { WaitingListCreateSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

const RATE_LIMIT_WINDOW_MINUTES = 10;
/** Soft marketing cap. See migration 104 for rationale. */
const WAITLIST_CAP = 50;

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, WaitingListCreateSchema);

    const organization = body.organization?.trim() ?? "";
    const name = body.name.trim();
    const email = body.email.trim().toLowerCase();

    if (!organization) throw new ValidationError("Organization is required", []);

    const sb = serviceClient();

    // Rate limit: same email in the last N minutes → silent success (no enumeration)
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60_000).toISOString();
    const { data: recent } = await sb
      .from("waiting_list")
      .select("id")
      .eq("email", email)
      .gt("created_at", since)
      .limit(1)
      .maybeSingle();

    if (recent) {
      return NextResponse.json({ ok: true });
    }

    // Cap check. A small number of racy over-inserts is acceptable —
    // 50 is a marketing number, not a safety guarantee.
    const { count } = await sb
      .from("waiting_list")
      .select("*", { count: "exact", head: true });
    if ((count ?? 0) >= WAITLIST_CAP) {
      return NextResponse.json({
        error: "The waiting list is full right now. Please check back soon.",
      }, { status: 409 });
    }

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
      req.headers.get("x-real-ip") ??
      null;
    const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;

    const { error } = await sb
      .from("waiting_list")
      .insert({
        organization,
        name,
        email,
        ip_address: ip,
        user_agent: userAgent,
      });

    if (error) {
      console.error("[waiting-list] insert failed", { code: error.code, message: error.message, details: error.details, hint: error.hint });
      return NextResponse.json({ error: "Could not save — please try again" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ValidationError) return errorResponse(err);
    console.error("[waiting-list] unexpected error", err);
    return errorResponse(err);
  }
}
