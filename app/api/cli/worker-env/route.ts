/**
 * GET /api/cli/worker-env
 * Auth: Bearer <API key>
 *
 * Returns the env vars the worker needs at runtime (Supabase public URL
 * + anon key) and the credentials `trigger.dev dev|deploy` needs to
 * connect to the tenant's own Trigger.dev project. The CLI writes these
 * into .env + configures the extracted worker-source/ directory.
 *
 * Never returns SUPABASE_SERVICE_ROLE_KEY or SUPABASE_JWT_SECRET — the
 * worker authenticates as the tenant via the per-run JWT minted by
 * sprint-dispatcher. See Stage 5.
 */
import { NextRequest, NextResponse } from "next/server";
import { SupabaseClient } from "@supabase/supabase-js";
import { authCli } from "@/lib/cli-api-auth";

export const dynamic = "force-dynamic";

async function getSecret(sb: SupabaseClient, tenantId: string, serviceId: string, varName: string): Promise<string | null> {
  const { data } = await sb
    .from("tenant_integrations")
    .select("secret_value")
    .eq("tenant_id", tenantId)
    .eq("service_id", serviceId)
    .eq("var_name", varName)
    .maybeSingle();
  return (data as { secret_value?: string } | null)?.secret_value ?? null;
}

export async function GET(req: NextRequest) {
  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;

  const sb = auth.sb;
  const tenantId = auth.tenantId;

  /* ── Trigger.dev credentials (required for workers dev/deploy) ── */
  const triggerProjectId = await getSecret(sb, tenantId, "trigger", "TRIGGER_PROJECT_ID");
  const triggerDevKey    = await getSecret(sb, tenantId, "trigger", "TRIGGER_DEV_SECRET_KEY");
  const triggerProdKey   =
    await getSecret(sb, tenantId, "trigger", "TRIGGER_PROD_SECRET_KEY") ??
    await getSecret(sb, tenantId, "trigger", "TRIGGER_SECRET_KEY");
  const triggerAccessToken = await getSecret(sb, tenantId, "trigger", "TRIGGER_ACCESS_TOKEN");

  if (!triggerProjectId) {
    return NextResponse.json(
      { error: "Trigger.dev is not configured for this tenant. Configure TRIGGER_PROJECT_ID in the Command Center (Integrations → Processing) before running `workers` commands." },
      { status: 400 },
    );
  }

  /* ── Env vars the worker needs at runtime ── */
  const env: Record<string, string> = {};

  // Supabase — URL + anon key only. The worker authenticates per-run
  // with the JWT dispatched in the run payload.
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  }
  if (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    env.SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  }

  // Tenant slug + factory slug (optional — some helpers use them)
  const { data: tenantRow } = await sb.from("tenants").select("slug").eq("id", tenantId).maybeSingle();
  if (tenantRow?.slug) env.TIRSA_TENANT_SLUG = tenantRow.slug as string;
  if (auth.factoryId) {
    const { data: factoryRow } = await sb.from("factories").select("slug").eq("id", auth.factoryId).maybeSingle();
    if (factoryRow?.slug) env.TIRSA_FACTORY_SLUG = factoryRow.slug as string;
  }

  // LLM provider keys — pulled from the tenant's encrypted provider keys.
  // The worker fetches these at runtime via Supabase RLS too, but
  // `trigger.dev deploy` needs them baked into the project env so
  // server-hosted tasks can read process.env.*.
  const { data: providers } = await sb
    .from("provider_keys")
    .select("provider_id, var_name, value")
    .eq("tenant_id", tenantId);
  for (const row of providers ?? []) {
    const varName = (row.var_name as string | null) ?? null;
    const value   = (row.value as string | null) ?? null;
    if (varName && value) env[varName] = value;
  }

  // GitHub integration (if configured)
  const githubToken = await getSecret(sb, tenantId, "github", "GITHUB_TOKEN");
  const githubOwner = await getSecret(sb, tenantId, "github", "GITHUB_OWNER");
  if (githubToken) env.GITHUB_TOKEN = githubToken;
  if (githubOwner) env.GITHUB_OWNER = githubOwner;

  return NextResponse.json({
    env,
    trigger: {
      projectId:   triggerProjectId,
      devKey:      triggerDevKey,
      prodKey:     triggerProdKey,
      accessToken: triggerAccessToken,
    },
    // Identity needed by the CLI's Realtime presence tracker so the
    // dispatcher's pre-flight check can locate the right channel
    // (worker-presence:{tenantId}:{factoryId}). The worker version
    // and the connect timestamp travel as the presence payload itself.
    presence: {
      tenantId,
      factoryId: auth.factoryId ?? null,
    },
  });
}
