/**
 * Cross-platform default for the local storage base path.
 *
 *   Windows → C:\Users\<user>\TwinPilotProjects
 *   macOS   → /Users/<user>/TwinPilotProjects
 *   Linux   → /home/<user>/TwinPilotProjects
 *
 * Mirrors `services/control-plane/lib/storage-defaults.ts` — packages don't
 * share runtime, so the helper is duplicated and the values must agree. The
 * UI gets this value through the `/api/settings/storage` GET response and
 * uses it as both placeholder + auto-fill so a fresh install can run
 * local/local-git without any operator config.
 */
import { homedir } from "os";
import { join } from "path";

export function defaultLocalBasePath(): string {
  return join(homedir(), "TwinPilotProjects");
}

export interface ResolvedLocalBasePath {
  path:   string;
  source: "sprint" | "project" | "tenant" | "homedir-default";
}

/**
 * Apply the standard 4-step priority:
 *   sprint config → project setting → tenant `local` storage backend → homedir.
 * Returns the resolved path AND where it came from, so callers can surface
 * "(homedir fallback — configure storage)" hints in the UI / Review modal.
 */
export function resolveLocalBasePath(opts: {
  sprintConfigPath?:  string;
  projectPath?:       string;
  tenantBackendPath?: string;
}): ResolvedLocalBasePath {
  const sprint  = opts.sprintConfigPath?.trim();
  if (sprint)  return { path: sprint,  source: "sprint" };
  const project = opts.projectPath?.trim();
  if (project) return { path: project, source: "project" };
  const tenant  = opts.tenantBackendPath?.trim();
  if (tenant)  return { path: tenant,  source: "tenant" };
  return { path: defaultLocalBasePath(), source: "homedir-default" };
}
