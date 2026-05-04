/**
 * GET  /api/settings/integrations/trigger-sync?tenantId=...
 *   List env vars currently set in the Trigger.dev project + suggested values.
 *
 * POST /api/settings/integrations/trigger-sync
 *   Import env vars into Trigger.dev environments (dev + prod).
 *   Body: { tenantId, variables: Record<string, string | null> }
 *   - string value = set the variable
 *   - null value   = unset (delete) the variable
 *
 * Uses the correct Trigger.dev API:
 *   POST /api/v1/projects/{ref}/envvars/{env}/import
 *   where {env} is "dev" or "prod", authenticated with the matching secret key.
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

async function getSecret(tenantId: string, serviceId: string, varName: string): Promise<string | null> {
  const sb = serviceClient();
  const { data } = await sb
    .from("tenant_integrations")
    .select("secret_value")
    .eq("tenant_id", tenantId)
    .eq("service_id", serviceId)
    .eq("var_name", varName)
    .single();
  return (data as { secret_value?: string } | null)?.secret_value ?? null;
}

async function getTriggerCredentials(tenantId: string) {
  const projectId = await getSecret(tenantId, "trigger", "TRIGGER_PROJECT_ID");
  const devKey = await getSecret(tenantId, "trigger", "TRIGGER_DEV_SECRET_KEY");
  const prodKey =
    await getSecret(tenantId, "trigger", "TRIGGER_PROD_SECRET_KEY") ??
    await getSecret(tenantId, "trigger", "TRIGGER_SECRET_KEY");
  return { projectId, devKey, prodKey };
}

/** Build suggested variables from platform config / env vars */
async function getSuggestedVars(tenantId: string): Promise<Record<string, string>> {
  const sb = serviceClient();
  const suggested: Record<string, string> = {};

  // Supabase from storage backend
  const { data: storageRow } = await sb
    .from("tenant_integrations")
    .select("secret_value")
    .eq("tenant_id", tenantId)
    .eq("service_id", "storage")
    .eq("var_name", "default")
    .single();

  if (storageRow?.secret_value) {
    try {
      const cfg = JSON.parse((storageRow as { secret_value: string }).secret_value);
      if (cfg.type === "supabase" && cfg.url) suggested.SUPABASE_URL = cfg.url;
      // SUPABASE_SERVICE_ROLE_KEY is intentionally NOT suggested here.
      // The worker authenticates as the tenant via the JWT dispatched in
      // every run payload (mintWorkerToken); never with the service role.
      // lib/supabase.ts refuses to start if that key is present.
    } catch { /* ignore */ }
  }

  // Fallback to command-center's own env vars (URL + anon key are safe to push)
  if (!suggested.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    suggested.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  }
  if (!suggested.SUPABASE_ANON_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    suggested.SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  }

  return suggested;
}

async function assertMember(req: NextRequest, tenantId: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: member } = await sb.from("tenant_members").select("id").eq("tenant_id", tenantId).eq("user_id", user.id).single();
  if (!member) throw new Error("Forbidden");
}

/* ─── GET — list current env vars + suggested ──────────────────────────────── */

export async function GET(req: NextRequest) {
  const tenantId = req.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

  try {
    await assertMember(req, tenantId);
    const { projectId, devKey, prodKey } = await getTriggerCredentials(tenantId);
    const anyKey = prodKey ?? devKey;

    if (!anyKey || !projectId) {
      return NextResponse.json({
        remote: {},
        suggested: await getSuggestedVars(tenantId),
        error: "Trigger.dev credentials not configured",
      });
    }

    const res = await fetch(`https://api.trigger.dev/api/v1/projects/${projectId}/envvars`, {
      headers: { Authorization: `Bearer ${anyKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    let remote: Record<string, string> = {};
    if (res.ok) {
      const body = await res.json() as { variables?: Record<string, string> };
      remote = body.variables ?? {};
    }

    return NextResponse.json({ remote, suggested: await getSuggestedVars(tenantId) });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/* ─── POST — import env vars into Trigger.dev ──────────────────────────────── */

export async function POST(req: NextRequest) {
  let body: { tenantId: string; variables: Record<string, string | null> };
  try {
    body = await req.json() as { tenantId: string; variables: Record<string, string | null> };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tenantId, variables } = body;
  if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

  try { await assertMember(req, tenantId); } catch (e) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
  if (!variables || typeof variables !== "object") {
    return NextResponse.json({ error: "variables object required" }, { status: 400 });
  }

  try {
    const { projectId, devKey, prodKey } = await getTriggerCredentials(tenantId);

    if (!projectId) {
      return NextResponse.json(
        { ok: false, error: "Configure Trigger.dev Project ref first" },
        { status: 400 },
      );
    }
    if (!devKey && !prodKey) {
      return NextResponse.json(
        { ok: false, error: "Configure at least one Trigger.dev Secret Key" },
        { status: 400 },
      );
    }

    // Block SUPABASE_SERVICE_ROLE_KEY from ever reaching the worker env.
    // Workers authenticate as the tenant via the JWT minted per run by
    // sprint-dispatcher (see lib/supabase.ts — the worker refuses to start
    // if this key is present). Pushing it to Trigger.dev would re-open
    // the cross-tenant bypass we closed in Stage 5.
    const BLOCKED = new Set(["SUPABASE_SERVICE_ROLE_KEY"]);
    const blocked = Object.keys(variables).filter((k) => BLOCKED.has(k));
    if (blocked.length > 0) {
      return NextResponse.json(
        { ok: false, error: `These variables must not be synced to the worker: ${blocked.join(", ")}. The worker uses a tenant-scoped JWT instead.` },
        { status: 400 },
      );
    }

    // Only set non-null values
    const toSet: Record<string, string> = {};
    for (const [key, value] of Object.entries(variables)) {
      if (value !== null) toSet[key] = value;
    }

    if (Object.keys(toSet).length === 0) {
      return NextResponse.json({ ok: true, set: [], environments: [] });
    }

    const results: { env: string; ok: boolean; error?: string }[] = [];

    // Import into each environment that has a key
    for (const [env, key] of [["dev", devKey], ["prod", prodKey]] as const) {
      if (!key) continue;
      try {
        const res = await fetch(
          `https://api.trigger.dev/api/v1/projects/${projectId}/envvars/${env}/import`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ variables: toSet, override: true }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (res.ok) {
          results.push({ env, ok: true });
        } else {
          const detail = await res.text().catch(() => "");
          results.push({ env, ok: false, error: `HTTP ${res.status}: ${detail}` });
        }
      } catch (e: unknown) {
        results.push({ env, ok: false, error: (e as Error).message });
      }
    }

    const allOk = results.every((r) => r.ok);
    return NextResponse.json({
      ok: allOk,
      set: Object.keys(toSet),
      environments: results,
    });
  } catch (e: unknown) {
    console.error("[trigger-sync] POST error:", e);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
