/**
 * GET /api/admin/infra-status
 *
 * Returns the status of factory-level infrastructure (Supabase env vars + live health check).
 * Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") throw new Error("Forbidden");
  return user;
}

// Mask a string: show first 8 chars + "…"
function mask(val: string | undefined): string | undefined {
  if (!val) return undefined;
  return val.length > 8 ? `${val.slice(0, 8)}…` : "••••••••";
}

export async function GET(req: NextRequest) {
  try {
    await assertAdmin(req);

    const SUPABASE_URL              = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SUPABASE_ANON_KEY         = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const env = [
      { var: "NEXT_PUBLIC_SUPABASE_URL",      label: "Project URL",        set: !!SUPABASE_URL,              preview: SUPABASE_URL ? SUPABASE_URL.replace(/^https?:\/\//, "").slice(0, 28) + "…" : undefined },
      { var: "NEXT_PUBLIC_SUPABASE_ANON_KEY", label: "Anon key (public)",  set: !!SUPABASE_ANON_KEY,         preview: mask(SUPABASE_ANON_KEY) },
      { var: "SUPABASE_SERVICE_ROLE_KEY",     label: "Service role key",   set: !!SUPABASE_SERVICE_ROLE_KEY, preview: mask(SUPABASE_SERVICE_ROLE_KEY) },
    ];

    // Live health check
    let health = { ok: false, latencyMs: null as number | null, error: null as string | null, tenantCount: null as number | null };

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const sb = serviceClient();
      const t0 = Date.now();
      try {
        const { data, error } = await sb.from("tenants").select("id", { count: "exact", head: false }).limit(1);
        const latencyMs = Date.now() - t0;
        if (error) {
          health = { ok: false, latencyMs, error: error.message, tenantCount: null };
        } else {
          const { count } = await sb.from("tenants").select("*", { count: "exact", head: true });
          health = { ok: true, latencyMs, error: null, tenantCount: count ?? (data?.length ?? 0) };
        }
      } catch (e: unknown) {
        health = { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message, tenantCount: null };
      }
    } else {
      health.error = "Supabase env vars not set — cannot connect";
    }

    return NextResponse.json({ env, health });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized" || msg === "Forbidden") {
      return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
