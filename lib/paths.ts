/**
 * paths.ts — Unified path conventions for TwinPilot artifact storage.
 *
 * Same structure for local filesystem and cloud (Supabase Storage):
 *
 *   TwinPilotProjects/{tenantSlug}/{factorySlug}/{projectSlug}/staging/sprint-{N}/{_audit,_docs,_workspace}
 *
 * Local:  {basePath}/TwinPilotProjects/...
 * Cloud:  Bucket "TwinPilotBucket" → TwinPilotProjects/...
 */

import { join } from "path";

export const TP_BUCKET = "TwinPilotBucket";
export const TP_ROOT   = "TwinPilotProjects";

export const SCAFFOLD_DIRS = ["_audit", "_docs", "_workspace"] as const;
export type ScaffoldDir = typeof SCAFFOLD_DIRS[number];

export function projectRoot(tenantSlug: string, factorySlug: string, projectSlug: string): string {
  return `${TP_ROOT}/${tenantSlug}/${factorySlug}/${projectSlug}`;
}

export function sprintPath(tenantSlug: string, factorySlug: string, projectSlug: string, sprintNum: number): string {
  return `${projectRoot(tenantSlug, factorySlug, projectSlug)}/staging/sprint-${sprintNum}`;
}

export function localProjectRoot(basePath: string, tenantSlug: string, factorySlug: string, projectSlug: string): string {
  return join(basePath, TP_ROOT, tenantSlug, factorySlug, projectSlug);
}

export function localSprintPath(basePath: string, tenantSlug: string, factorySlug: string, projectSlug: string, sprintNum: number): string {
  return join(localProjectRoot(basePath, tenantSlug, factorySlug, projectSlug), "staging", `sprint-${sprintNum}`);
}

export function isWithinBase(resolvedPath: string, basePath: string): boolean {
  const normalized = join(resolvedPath);
  const normalizedBase = join(basePath);
  return normalized.startsWith(normalizedBase);
}
