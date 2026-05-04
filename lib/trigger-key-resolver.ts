import type { SupabaseClient } from "@supabase/supabase-js";

export type TriggerExecutionMode = "cloud" | "local";

/**
 * Resolve the trigger.dev secret key for a tenant, honoring the dev/prod split.
 *
 * Lookup order:
 *   1. tenant_integrations.trigger.TRIGGER_DEV_SECRET_KEY (when mode === "local")
 *      or TRIGGER_PROD_SECRET_KEY (otherwise / undefined mode)
 *   2. tenant_integrations.trigger.TRIGGER_SECRET_KEY (legacy, mode-agnostic)
 *   3. process.env.TRIGGER_SECRET_KEY
 *
 * Returns undefined if no key is configured — callers treat that as
 * "degrade gracefully to CLI instructions".
 */
export async function resolveTriggerKey(
  sb: SupabaseClient,
  tenantId: string,
  mode?: TriggerExecutionMode,
): Promise<string | undefined> {
  const modeVarName =
    mode === "local" ? "TRIGGER_DEV_SECRET_KEY" : "TRIGGER_PROD_SECRET_KEY";

  const modeKey = await readIntegration(sb, tenantId, modeVarName);
  if (modeKey) return modeKey;

  const legacyKey = await readIntegration(sb, tenantId, "TRIGGER_SECRET_KEY");
  if (legacyKey) return legacyKey;

  return process.env.TRIGGER_SECRET_KEY;
}

async function readIntegration(
  sb: SupabaseClient,
  tenantId: string,
  varName: string,
): Promise<string | undefined> {
  const { data } = await sb
    .from("tenant_integrations")
    .select("secret_value")
    .eq("tenant_id", tenantId)
    .eq("service_id", "trigger")
    .eq("var_name", varName)
    .maybeSingle();
  return (data?.secret_value as string | null) ?? undefined;
}
