/**
 * project-blueprint.ts — Phase A.5 foundation.
 *
 * Today the worker hardcodes `_workspace`, `_docs`, `_audit`, `staging/sprint-{N}`
 * across paths.ts, mcp-server.ts, run-pipeline.ts, prepare-workspace.ts, and
 * git-helpers.ts. Operators can't reshape the project layout to match an
 * existing repo or a domain-specific convention.
 *
 * Phase A.5 introduces a Project Blueprint: an operator-configurable mapping
 * stored in `projects.settings.blueprint`. The default blueprint matches the
 * current hardcoded layout exactly, so reading is backwards-compatible — every
 * existing project continues to behave as before until an operator overrides.
 *
 * Source modes:
 *   - "preset"   — picked from a known catalog (Web App, CLI Tool, Library, …)
 *   - "agent"    — derived/proposed by an adoption agent (PIP repo-scout)
 *   - "template" — from a stored template (operator-published or built-in)
 *
 * This module is foundation-only: it defines the schema, the default, and the
 * read helper. Worker callsite refactors come in subsequent commits, gated on
 * worker:build + CLI bump.
 */
import { z } from "zod";

const slugLikeName = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, "must be a slug-like path component");

export const ProjectBlueprintLayoutSchema = z.object({
  workspace_dir:  slugLikeName,
  docs_dir:       slugLikeName,
  audit_dir:      slugLikeName,
  staging_dir:    slugLikeName,
  sprint_prefix:  slugLikeName,
}).strict();

export const ProjectBlueprintSchema = z.object({
  source: z.enum(["preset", "agent", "template"]),
  preset_id:   z.string().min(1).max(64).optional(),
  template_id: z.string().uuid().optional(),
  agent_slug:  z.string().min(1).max(120).optional(),
  layout: ProjectBlueprintLayoutSchema,
}).strict();

export type ProjectBlueprintLayout = z.infer<typeof ProjectBlueprintLayoutSchema>;
export type ProjectBlueprint       = z.infer<typeof ProjectBlueprintSchema>;

/**
 * Default blueprint — matches the hardcoded paths that have shipped since
 * paths.ts was introduced. Operators with no `settings.blueprint` set get
 * exactly the legacy behavior. `source = "preset"` + `preset_id = "default"`
 * marks this as the catalog-default rather than an agent- or template-derived
 * choice.
 */
export const DEFAULT_PROJECT_BLUEPRINT: ProjectBlueprint = {
  source:    "preset",
  preset_id: "default",
  layout: {
    workspace_dir: "_workspace",
    docs_dir:      "_docs",
    audit_dir:     "_audit",
    staging_dir:   "staging",
    sprint_prefix: "sprint-",
  },
};

/**
 * Resolve the effective blueprint for a project. Reads `settings.blueprint`
 * if present and valid; otherwise returns the legacy default. Validation
 * failures fall back to the default rather than throwing — a malformed
 * blueprint shouldn't break the runtime; the operator will see warnings in
 * the Studio editor when we ship the UI.
 */
export function getProjectBlueprint(project: { settings?: unknown } | null | undefined): ProjectBlueprint {
  const settings = (project?.settings ?? {}) as Record<string, unknown>;
  const raw = settings.blueprint;
  if (!raw) return DEFAULT_PROJECT_BLUEPRINT;
  const parsed = ProjectBlueprintSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_PROJECT_BLUEPRINT;
}
