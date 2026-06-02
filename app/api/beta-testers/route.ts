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
import {
  ValidationError, errorResponse, parseBody, serviceClient,
} from "@/lib/api-helpers";
import { WaitingListCreateSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

const USE_CASE_MAX = 500;
const BETA_CAP = 50;
const RATE_LIMIT_WINDOW_MINUTES = 10;

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, WaitingListCreateSchema);

    const organization = body.organization?.trim() ?? "";
    const name         = body.name.trim();
    const email        = body.email.trim().toLowerCase();
    const useCase      = body.use_case?.trim().slice(0, USE_CASE_MAX) ?? "";

    if (!organization) throw new ValidationError("Organization is required", []);

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
    if (err instanceof ValidationError) return errorResponse(err);
    console.error("[beta-testers] unexpected error", err);
    return errorResponse(err);
  }
}
