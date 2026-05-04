import { NextRequest, NextResponse } from "next/server";

const BYPASS_COOKIE = "tirsa_maint_bypass";
const CACHE_TTL_MS  = 30_000; // 30 seconds per Edge instance

// Module-level cache — shared across requests within the same Edge invocation context.
// Different Edge nodes may have slightly stale data, which is acceptable for maintenance mode.
let cached: {
  maintenanceMode: boolean;
  bypassToken:     string | null;
  ts:              number;
} = { maintenanceMode: false, bypassToken: null, ts: 0 };

async function getMaintenanceStatus(): Promise<{ maintenanceMode: boolean; bypassToken: string | null }> {
  const now = Date.now();
  if (now - cached.ts < CACHE_TTL_MS) {
    return { maintenanceMode: cached.maintenanceMode, bypassToken: cached.bypassToken };
  }

  try {
    // Use service role key so bypass_token is readable (not limited by RLS)
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/platform_config?id=eq.singleton&select=maintenance_mode,bypass_token`,
      {
        headers: {
          apikey:        process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
          "Content-Type": "application/json",
        },
        cache: "no-store",
      },
    );

    if (res.ok) {
      const rows = await res.json() as Array<{ maintenance_mode: boolean; bypass_token: string | null }>;
      const row  = rows[0];
      cached = {
        maintenanceMode: row?.maintenance_mode ?? false,
        bypassToken:     row?.bypass_token     ?? null,
        ts:              now,
      };
    }
  } catch {
    // On fetch error, keep serving cached value (fail open — don't block everyone)
  }

  return { maintenanceMode: cached.maintenanceMode, bypassToken: cached.bypassToken };
}

// Paths that are always reachable even during maintenance
const ALWAYS_ALLOWED = [
  "/maintenance",
  "/login",
  "/api/admin/maintenance", // so the owner can disable it
  "/_next",
  "/favicon",
  "/brand",
];

function isAlwaysAllowed(pathname: string): boolean {
  return ALWAYS_ALLOWED.some((p) => pathname.startsWith(p));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isAlwaysAllowed(pathname)) return NextResponse.next();

  const { maintenanceMode, bypassToken } = await getMaintenanceStatus();

  if (!maintenanceMode) return NextResponse.next();

  // Maintenance is ON — check if this request has the owner bypass cookie
  const bypass = request.cookies.get(BYPASS_COOKIE)?.value;
  if (bypass && bypassToken && bypass === bypassToken) {
    return NextResponse.next(); // owner passes through
  }

  // Everyone else → maintenance page
  const url = request.nextUrl.clone();
  url.pathname = "/maintenance";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Match all routes except static assets and Next internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
