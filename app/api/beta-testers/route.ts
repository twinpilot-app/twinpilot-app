/**
 * POST /api/beta-testers
 *
 * Public endpoint — no auth. Beta tester application from the landing
 * page. Hard-capped at BETA_CAP entries; once full, the new
 * application is silently redirected to the waiting list and the
 * response tells the UI to show the "moved to waiting list" message.
 *
 * Same privacy / anti-enumeration stance as /api/waiting-list.
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
const USE_CASE_MAX = 500;
const BETA_CAP = 50;
const RATE_LIMIT_WINDOW_MINUTES = 10;

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
      name?:         string;
      email?:        string;
      use_case?:     string;
    };

    const organization = body.organization?.trim() ?? "";
    const name         = body.name?.trim() ?? "";
    const email        = body.email?.trim().toLowerCase() ?? "";
    const useCase      = body.use_case?.trim().slice(0, USE_CASE_MAX) ?? "";

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

    // Rate limit: same email in the last N minutes → silent success.
    const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60_000).toISOString();
    const { data: recent } = await sb
      .from("beta_testers")
      .select("id")
      .eq("email", email)
      .gt("created_at", since)
      .limit(1)
      .maybeSingle();
    if (recent) return NextResponse.json({ ok: true });

    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
      req.headers.get("x-real-ip") ??
      null;
    const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;

    // Cap check — not a race-proof reservation (two concurrent submits
    // at the ceiling can both sneak in), but that's fine: 50 is a
    // marketing cap, not a safety-critical one. Tighten to a trigger
    // + advisory lock if the cap ever becomes non-fungible.
    const { count } = await sb
      .from("beta_testers")
      .select("*", { count: "exact", head: true });

    if ((count ?? 0) >= BETA_CAP) {
      // Overflow → send to the regular waiting list so the user's
      // intent isn't lost. Same rate-limit semantics.
      const { data: wlRecent } = await sb
        .from("waiting_list")
        .select("id")
        .eq("email", email)
        .gt("created_at", since)
        .limit(1)
        .maybeSingle();
      if (!wlRecent) {
        await sb.from("waiting_list").insert({
          organization, name, email,
          ip_address: ip, user_agent: userAgent,
        });
      }
      return NextResponse.json({ ok: true, full: true });
    }

    const { error } = await sb
      .from("beta_testers")
      .insert({
        organization,
        name,
        email,
        use_case:   useCase || null,
        ip_address: ip,
        user_agent: userAgent,
      });

    if (error) {
      console.error("[beta-testers] insert failed", {
        code: error.code, message: error.message, details: error.details,
      });
      return NextResponse.json({ error: "Could not save — please try again" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[beta-testers] unexpected error", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
