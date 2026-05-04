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
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORG_MIN = 1;
const ORG_MAX = 120;
const NAME_MIN = 1;
const NAME_MAX = 80;
const EMAIL_MAX = 254;
const RATE_LIMIT_WINDOW_MINUTES = 10;
/** Soft marketing cap. See migration 104 for rationale. */
const WAITLIST_CAP = 50;

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      organization?: string;
      name?: string;
      email?: string;
    };

    const organization = body.organization?.trim() ?? "";
    const name = body.name?.trim() ?? "";
    const email = body.email?.trim().toLowerCase() ?? "";

    if (organization.length < ORG_MIN || organization.length > ORG_MAX) {
      return NextResponse.json({ error: "Organization is required" }, { status: 400 });
    }
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (email.length === 0 || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
    }

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
    console.error("[waiting-list] unexpected error", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
