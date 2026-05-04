/**
 * Mode availability matrix — single source of truth for whether the operator
 * can pick `cloud`, `local`, or `local-git` for a sprint.
 *
 * Today's rules:
 *   - cloud:     bootstrap Supabase is up (the app itself runs on it; if the
 *                user is logged in, this is true). Reserved as an explicit
 *                check for the future where tenants bring their own Supabase
 *                project — at that point, this is where we'd query
 *                `tenant_integrations` for a `supabase` storage backend.
 *   - local:     `resolveLocalBasePath` always returns a path because of the
 *                homedir fallback, so local is always available. The `source`
 *                of the path is surfaced (homedir-default vs configured) so
 *                the UI can show a "using fallback path" hint.
 *   - local-git: `local` available AND at least one push destination
 *                resolves — either a row in `factory_output_destinations`
 *                for the project's factory, or the legacy tenant
 *                `tenant_integrations` GITHUB_TOKEN + GITHUB_OWNER pair.
 *                Local-git doesn't push today, but we gate on destinations
 *                upfront so Phase 5 (auto-push) doesn't surprise an operator
 *                whose factory has no destinations configured.
 *
 * Both the Project Settings modal and the Start Sprint Modal consume this
 * via /api/projects/[id]/mode-availability, and the /run route re-evaluates
 * server-side as defense in depth.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveLocalBasePath, type ResolvedLocalBasePath } from "./storage-defaults";

export interface EvaluatedMode {
  enabled: boolean;
  /**
   * Short, operator-facing reason. Present whenever `enabled === false`, and
   * also for `enabled === true` when the operator should know about a
   * fallback (e.g. "using homedir default" or "GitHub falls back to tenant
   * legacy token"). Empty when the resolution is fully explicit.
   */
  reason?: string;
  /** Severity tier for the UI: error blocks; warning is informational. */
  severity?: "error" | "warning";
}

export interface ModeAvailability {
  cloud:        EvaluatedMode;
  local:        EvaluatedMode;
  "local-git":  EvaluatedMode;
  /** Resolved path + provenance — surfaced in the Review Modal (Phase C). */
  localPath:    ResolvedLocalBasePath;
  destinations: {
    factoryCount: number;
    tenantLegacy: boolean;
  };
}

export async function evaluateModeAvailability(opts: {
  sb:          SupabaseClient;
  tenantId:    string;
  factoryId:   string;
  projectPath?: string;
}): Promise<ModeAvailability> {
  const { sb, tenantId, factoryId, projectPath } = opts;

  // ── Storage backends (tenant_integrations: service_id = "storage") ──
  let tenantBackendLocalPath: string | undefined;
  let hasSupabaseBackend = false;
  {
    const { data } = await sb
      .from("tenant_integrations")
      .select("secret_value")
      .eq("tenant_id", tenantId)
      .eq("service_id", "storage");
    for (const row of data ?? []) {
      try {
        const cfg = JSON.parse((row as { secret_value: string }).secret_value) as { type?: string; basePath?: string };
        if (cfg.type === "local" && cfg.basePath && !tenantBackendLocalPath) tenantBackendLocalPath = cfg.basePath;
        if (cfg.type === "supabase") hasSupabaseBackend = true;
      } catch { /* ignore malformed rows */ }
    }
  }

  // ── Factory destinations + tenant legacy GitHub fallback ──
  const { data: destRows } = await sb
    .from("factory_output_destinations")
    .select("id")
    .eq("factory_id", factoryId);
  const factoryCount = destRows?.length ?? 0;

  let tenantLegacy = false;
  {
    const { data } = await sb
      .from("tenant_integrations")
      .select("var_name")
      .eq("tenant_id", tenantId)
      .in("var_name", ["GITHUB_TOKEN", "GITHUB_OWNER"]);
    const seen = new Set((data ?? []).map((r) => (r as { var_name: string }).var_name));
    tenantLegacy = seen.has("GITHUB_TOKEN") && seen.has("GITHUB_OWNER");
  }

  // ── local: always available because of the homedir fallback. ──
  const localPath = resolveLocalBasePath({
    projectPath,
    tenantBackendPath: tenantBackendLocalPath,
  });
  const local: EvaluatedMode =
    localPath.source === "homedir-default"
      ? { enabled: true,  severity: "warning",
          reason: `Using homedir fallback (${localPath.path}). Configure storage in Settings → Storage to silence this.` }
      : { enabled: true };

  // ── cloud: bootstrap Supabase is up (placeholder check). ──
  // Once tenants bring their own Supabase, switch to `hasSupabaseBackend`.
  void hasSupabaseBackend;
  const cloud: EvaluatedMode = { enabled: true };

  // ── local-git: needs local + at least one destination resolvable. ──
  let localGit: EvaluatedMode;
  if (!local.enabled) {
    localGit = { enabled: false, severity: "error", reason: "Local mode is unavailable, so Local + Git can't run." };
  } else if (factoryCount === 0 && !tenantLegacy) {
    localGit = {
      enabled:  false,
      severity: "error",
      reason:   "No GitHub destination configured. Add a destination under Factory Settings → Output Destinations, or set GITHUB_TOKEN + GITHUB_OWNER in tenant integrations.",
    };
  } else if (factoryCount === 0 && tenantLegacy) {
    localGit = {
      enabled:  true,
      severity: "warning",
      reason:   "Falling back to the tenant-level GITHUB_TOKEN + GITHUB_OWNER. Add factory destinations to scope per-project.",
    };
  } else {
    localGit = { enabled: true };
  }

  return {
    cloud,
    local,
    "local-git": localGit,
    localPath,
    destinations: { factoryCount, tenantLegacy },
  };
}
