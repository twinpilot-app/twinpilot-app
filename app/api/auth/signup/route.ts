/**
 * POST /api/auth/signup
 * Creates a Supabase Auth user with email_confirm: true (no confirmation email).
 * Uses service_role — must stay server-side.
 *
 * Validation: email format + length (≤320), password 8-128 chars. Body cap
 * 1MB applies via api-helpers.parseBody. No auth gate — this IS the signup
 * surface; rate limiting at the perimeter (future trilho) is the right
 * mitigation for abuse, not auth.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseBody, errorResponse } from "@/lib/api-helpers";
import { AuthSignupSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await parseBody(req, AuthSignupSchema);

    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    );

    const { data, error } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,   // ← skip confirmation email entirely
    });

    if (error) {
      // Supabase already returns clean error messages — surface verbatim
      // so the client can show "email already registered" / etc. directly.
      return NextResponse.json({ error: error.message, code: "SIGNUP_REJECTED" }, { status: 400 });
    }

    return NextResponse.json({ userId: data.user.id });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
