/**
 * Admin configuration stored in Supabase (admin_config table).
 * Only readable/writable via service role key.
 * Falls back to environment variables for values not yet in DB.
 */
import { createClient } from "@supabase/supabase-js";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

/** Known admin config keys */
export type AdminConfigKey =
  | "VERCEL_TOKEN"
  | "VERCEL_PROJECT_ID"
  | "VERCEL_TEAM_ID"
  | "VERCEL_DEPLOY_HOOK_URL"
  | "GITHUB_ADMIN_TOKEN"
  /**
   * Boolean toggle ("true" / anything else). When "true", the sprint
   * push flow (save/route.ts action="github" | "export" with github
   * target) enqueues a push-sprint Trigger.dev task instead of running
   * inline. Useful on Vercel Hobby where the 10s function limit kills
   * large sprint pushes. The worker has a 30-minute budget.
   */
  | "PUSH_VIA_TRIGGER";

/**
 * Read a single config value.
 * Priority: DB → env var → undefined
 */
export async function getAdminConfig(key: AdminConfigKey): Promise<string | undefined> {
  const sb = serviceClient();
  const { data } = await sb
    .from("admin_config")
    .select("value")
    .eq("key", key)
    .single();
  if (data?.value) return data.value;
  return process.env[key] ?? undefined;
}

/**
 * Read multiple config values in one query.
 * Priority: DB → env var → undefined
 */
export async function getAdminConfigs(keys: AdminConfigKey[]): Promise<Record<AdminConfigKey, string | undefined>> {
  const sb = serviceClient();
  const { data } = await sb
    .from("admin_config")
    .select("key, value")
    .in("key", keys);

  const fromDb: Partial<Record<AdminConfigKey, string>> = {};
  for (const row of data ?? []) {
    fromDb[row.key as AdminConfigKey] = row.value;
  }

  const result = {} as Record<AdminConfigKey, string | undefined>;
  for (const key of keys) {
    result[key] = fromDb[key] ?? process.env[key] ?? undefined;
  }
  return result;
}

/**
 * Upsert a config value.
 */
export async function setAdminConfig(
  key: AdminConfigKey,
  value: string,
  userId?: string,
): Promise<void> {
  const sb = serviceClient();
  await sb.from("admin_config").upsert(
    { key, value, updated_at: new Date().toISOString(), updated_by: userId ?? null },
    { onConflict: "key" },
  );
}

/**
 * Delete a config value (revert to env var fallback).
 */
export async function deleteAdminConfig(key: AdminConfigKey): Promise<void> {
  const sb = serviceClient();
  await sb.from("admin_config").delete().eq("key", key);
}

/** Returns a masked preview of a secret value */
export function maskSecret(val: string | undefined): string | undefined {
  if (!val) return undefined;
  return val.length > 8 ? `${val.slice(0, 8)}…` : "••••••••";
}
