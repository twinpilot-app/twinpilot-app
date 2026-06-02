/**
 * pip-spec.ts — Project Inception Pack (PIP) JSON spec.
 *
 * Single source of truth for the PIP exchange format. Minimal
 * templates with fixed fields per component type. Every component is
 * created INLINE, project-scoped — there's no source.kind discriminator
 * and no metadata grab-bag. References to canonical platform
 * components live as plain slugs in `pipeline.steps[].agent`; the
 * worker resolver (project > factory > tenant > built-in) handles
 * fall-through at sprint dispatch.
 *
 * The schema enforces required core fields strictly. Anything beyond
 * the documented fields is silently dropped at parse time.
 *
 * Used by:
 *   - GET  /api/projects/[id]/pip/export       (emits PIP from DB)
 *   - POST /api/factories/[id]/pip/import      (validates + applies)
 *   - POST /api/factory/pip/inception/apply    (operator-driven apply)
 *   - pip-composer Platform Agent              (emits PIP at end of pip-reverse-engineering sprint)
 *   - pip_import SQL function (mig 206)        (atomic DB inserts)
 */
import { z } from "zod";

export const PIP_SCHEMA_VERSION = "1.0" as const;

const SlugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case (a-z0-9 + hyphen, must start with a letter or digit)");

/* ─────────────────────────────────────────────────────────────────
 * Workdir setup — single Local source mode (operator passes the
 * directory; worker creates the git repo when missing). Clone /
 * init-local were retired — operators clone externally and pass the
 * directory; auto-init handles non-git paths transparently.
 * ───────────────────────────────────────────────────────────────── */

export const PipWorkdirSetupSchema = z.object({
  /** Absolute path on the operator's machine. The new project's
   *  workdir_override is set to this; worker auto-inits a git repo
   *  on the first sprint if .git is absent. */
  local_path: z.string().min(1).max(2000),
  /** Optional remote URL — persisted to projects.repo_url. Operator
   *  can add later via Project Settings if not known at apply time. */
  remote_url: z.string().url().nullable().optional(),
});

/* ─────────────────────────────────────────────────────────────────
 * Component templates — minimal fixed fields. Every component is
 * created inline at apply time; refs to canonicals appear only as
 * slugs inside pipeline.steps[].agent.
 * ───────────────────────────────────────────────────────────────── */

/**
 * Forgiveness policy: only fields with NO sensible default (slugs,
 * project.name, enums that drive behaviour like intent/category/event/
 * decision) are strictly required. Everything else is optional with
 * a default — Zod fills the gap silently when the LLM omits a field.
 * The pip_import RPC also COALESCEs server-side as a second defence.
 *
 * Rationale: required+typed schemas were creating an endless ratchet
 * of "missing field" failures. Operators don't care about
 * `agent.description` being null — they want the agent inserted with
 * an empty description if that's what the LLM produced.
 */

export const PipProjectSchema = z.object({
  /** Operator-facing name. Required — drives slug + project.name at apply. */
  name:          z.string().min(1).max(200),
  briefing:      z.string().default(""),
  prd_md:        z.string().default(""),
  /** Workdir bootstrap directive. Permissive in the schema (z.unknown)
   *  because the operator's choice at dispatch time is the source of
   *  truth — the LLM round-tripping it adds zero value and lots of
   *  failure modes (missing local_path, wrong kind, etc). The apply
   *  route IGNORES whatever the LLM wrote here and reads from the
   *  temp inception's settings.pip_inception.workdir_setup. The
   *  import route (operator-uploaded pip.json, no temp) validates
   *  this field separately via PipWorkdirSetupSchema before use. */
  workdir_setup: z.unknown().optional(),
});

export const PipAgentSchema = z.object({
  slug:        SlugSchema,
  name:        z.string().max(200).default(""),
  description: z.string().default(""),
  tools:       z.array(z.string()).default([]),
});

export const PipPipelineStepSchema = z.object({
  /** Agent slug. Resolves at sprint dispatch via project > factory >
   *  tenant > built-in priority. */
  agent: SlugSchema,
  phase: z.number().int().min(1).optional(),
  gate:  z.literal("human").nullable().optional(),
});

export const PipPipelineSchema = z.object({
  slug:   SlugSchema,
  name:   z.string().max(200).default(""),
  /** intent is required — drives the worker's verdict matrix. */
  intent: z.enum(["discovery", "planning", "execution", "review"]),
  steps:  z.array(PipPipelineStepSchema).default([]),
});

export const PipSkillSchema = z.object({
  slug:          SlugSchema,
  name:          z.string().max(200).default(""),
  description:   z.string().default(""),
  body:          z.string().default(""),
  /** category is required — drives where the skill is materialised. */
  category:      z.enum(["guideline", "playbook", "reference"]),
  allowed_tools: z.array(z.string()).default([]),
});

export const PipCommandSchema = z.object({
  slug:        SlugSchema,
  name:        z.string().max(200).default(""),
  description: z.string().default(""),
  body:        z.string().default(""),
});

const HookEventSchema = z.enum([
  "PreToolUse", "PostToolUse", "UserPromptSubmit",
  "Notification", "Stop", "SubagentStop",
  "PreCompact", "SessionStart", "SessionEnd",
]);

export const PipHookSchema = z.object({
  slug:    SlugSchema,
  name:    z.string().nullable().optional(),
  /** event is required — claude-code dispatches by it. */
  event:   HookEventSchema,
  matcher: z.string().default(""),
  command: z.string().default(""),
});

export const PipOutputStyleSchema = z.object({
  slug:      SlugSchema,
  name:      z.string().max(200).default(""),
  body:      z.string().default(""),
  is_active: z.boolean().optional(),
});

export const PipPermissionRuleSchema = z.object({
  /** decision is required — the rule is meaningless without it. */
  decision: z.enum(["allow", "ask", "deny"]),
  /** pattern is required — defines what the rule applies to. */
  pattern:  z.string().min(1).max(512),
});

/* ─────────────────────────────────────────────────────────────────
 * Top-level wrapper.
 * ───────────────────────────────────────────────────────────────── */

export const PipSchema = z.object({
  schema_version:   z.literal(PIP_SCHEMA_VERSION),
  /** Provenance — purely informational; importer ignores. */
  generated:        z.object({
    by:  z.string().optional(),
    via: z.string().optional(),
    at:  z.string().optional(),
  }).optional(),
  project:          PipProjectSchema,
  agents:           z.array(PipAgentSchema).default([]),
  pipelines:        z.array(PipPipelineSchema).default([]),
  skills:           z.array(PipSkillSchema).default([]),
  commands:         z.array(PipCommandSchema).default([]),
  hooks:            z.array(PipHookSchema).default([]),
  output_styles:    z.array(PipOutputStyleSchema).default([]),
  permission_rules: z.array(PipPermissionRuleSchema).default([]),
});

export type PipAgent          = z.infer<typeof PipAgentSchema>;
export type PipPipeline       = z.infer<typeof PipPipelineSchema>;
export type PipPipelineStep   = z.infer<typeof PipPipelineStepSchema>;
export type PipSkill          = z.infer<typeof PipSkillSchema>;
export type PipCommand        = z.infer<typeof PipCommandSchema>;
export type PipHook           = z.infer<typeof PipHookSchema>;
export type PipOutputStyle    = z.infer<typeof PipOutputStyleSchema>;
export type PipPermissionRule = z.infer<typeof PipPermissionRuleSchema>;
export type PipProject        = z.infer<typeof PipProjectSchema>;
export type PipWorkdirSetup   = z.infer<typeof PipWorkdirSetupSchema>;
export type Pip               = z.infer<typeof PipSchema>;

