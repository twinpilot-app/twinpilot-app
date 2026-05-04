import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Validate at startup so the error is obvious — not a silent 406.
// NEXT_PUBLIC_* vars are inlined at *build time*. If they're undefined here, the
// .env.local file was absent when `next build` ran (or the platform env vars weren't set).
if (typeof window !== "undefined" && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
  console.error(
    "[supabase] NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is undefined.\n" +
    "These are inlined at build time — ensure they are present in .env.local before\n" +
    "`next build`, or set them in the host platform's environment variables."
  );
}

/**
 * Supabase's auth client treats an HTTP 429 (rate-limit) as a terminal failure
 * and immediately fires SIGNED_OUT, logging the user out.  This wrapper retries
 * once with a short back-off so a transient rate-limit doesn't destroy the session.
 *
 * IMPORTANT: keep total delay well under the 5 000 ms navigator.locks timeout used
 * by gotrue-js.  If the lock is held longer than 5 s, other callers force-acquire it
 * and each fires its own refresh — causing a 429 cascade.
 * Budget: 1 retry × 300 ms ≈ 300 ms total, safely inside the 5 s threshold.
 */
const resilientFetch: typeof fetch = async (input, init) => {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (networkErr) {
    // Network-level failure (no connectivity, CORS preflight blocked, DNS error).
    // Retry once after a short back-off instead of immediately surfacing the error.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    return fetch(input, init);
  }
  if (response.status !== 429) return response;
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  return fetch(input, init); // one retry only
};

// Singleton — prevents multiple client instances during Next.js Fast Refresh in dev.
// Each recreation triggers a token refresh attempt, which causes 429 rate limits.
function getClient() {
  const CACHE_KEY = "__supabase_client";
  if (typeof window !== "undefined") {
    const cached = (window as unknown as Record<string, unknown>)[CACHE_KEY];
    if (cached) return cached as ReturnType<typeof createClient>;
  }

  const client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    global: { fetch: resilientFetch },
  });

  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>)[CACHE_KEY] = client;
  }
  return client;
}

export const supabase = getClient();
