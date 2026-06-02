/**
 * POST /api/webhooks/health-check
 *
 * Checks health of platform services (Supabase, Vercel, Trigger.dev)
 * and emits notifications for any issues detected.
 *
 * Can be called:
 * - Manually from admin panel
 * - Via cron (e.g. Vercel Cron, external cron service)
 * - Via Trigger.dev scheduled task
 *
 * No auth required for cron — uses a secret token.
 * Query: ?token=<HEALTH_CHECK_SECRET>
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createNotification } from "@/lib/notifications";

export const dynamic = "force-dynamic";

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

interface HealthResult {
  service: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

async function checkSupabase(): Promise<HealthResult> {
  const start = Date.now();
  try {
    const s = sb();
    const { error } = await s.from("tenants").select("id").limit(1);
    const latencyMs = Date.now() - start;
    if (error) return { service: "supabase", ok: false, detail: error.message, latencyMs };
    return { service: "supabase", ok: true, detail: `OK (${latencyMs}ms)`, latencyMs };
  } catch (e: unknown) {
    return { service: "supabase", ok: false, detail: (e as Error).message, latencyMs: Date.now() - start };
  }
}

async function checkVercel(): Promise<HealthResult> {
  const start = Date.now();
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL;
    if (!appUrl) return { service: "vercel", ok: true, detail: "No APP_URL configured — skipped" };
    const url = appUrl.startsWith("http") ? appUrl : `https://${appUrl}`;
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { service: "vercel", ok: false, detail: `HTTP ${res.status}`, latencyMs };
    return { service: "vercel", ok: true, detail: `OK (${latencyMs}ms)`, latencyMs };
  } catch (e: unknown) {
    return { service: "vercel", ok: false, detail: (e as Error).message, latencyMs: Date.now() - start };
  }
}

async function checkTrigger(): Promise<HealthResult> {
  const start = Date.now();
  try {
    const apiUrl = process.env.TRIGGER_API_URL ?? "https://api.trigger.dev";
    const apiKey = process.env.TRIGGER_SECRET_KEY;
    if (!apiKey) return { service: "trigger", ok: true, detail: "No TRIGGER_SECRET_KEY — skipped" };
    const res = await fetch(`${apiUrl}/api/v1/whoami`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) return { service: "trigger", ok: false, detail: `HTTP ${res.status}`, latencyMs };
    return { service: "trigger", ok: true, detail: `OK (${latencyMs}ms)`, latencyMs };
  } catch (e: unknown) {
    return { service: "trigger", ok: false, detail: (e as Error).message, latencyMs: Date.now() - start };
  }
}

export async function POST(req: NextRequest) {
  // Auth: either admin Bearer token or health check secret
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  const secretParam = req.nextUrl.searchParams.get("token");
  const healthSecret = process.env.HEALTH_CHECK_SECRET;

  let authenticated = false;
  if (token) {
    const s = sb();
    const { data: { user } } = await s.auth.getUser(token);
    if (user && (user.app_metadata as Record<string, unknown>)?.role === "admin") authenticated = true;
  }
  if (healthSecret && secretParam === healthSecret) authenticated = true;
  if (!authenticated) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const results = await Promise.all([checkSupabase(), checkVercel(), checkTrigger()]);

  // Find owner tenant
  const s = sb();
  const { data: owner } = await s.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();

  // Emit notifications for failures
  if (owner) {
    for (const r of results) {
      if (!r.ok) {
        const eventMap: Record<string, Parameters<typeof createNotification>[0]["eventType"]> = {
          supabase: "supabase_health",
          vercel: "vercel_health",
          trigger: "trigger_health",
        };
        const eventType = eventMap[r.service];
        if (eventType) {
          await createNotification({
            tenantId: owner.id,
            eventType,
            severity: "critical",
            title: `${r.service} health issue`,
            body: r.detail,
            metadata: { service: r.service, latencyMs: r.latencyMs },
          });
        }
      }
    }
  }

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results });
}

// Also support GET for simple cron pings
export async function GET(req: NextRequest) {
  return POST(req);
}
