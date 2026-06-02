/**
 * Shared Zod schemas for API-route input validation.
 *
 * Per-class size caps live HERE so every consumer of the same field
 * (e.g. `briefing` in /api/projects, /api/projects/[id], /api/projects/[id]/run)
 * agrees on the limit. Bumping a cap means changing one constant.
 *
 * Caps come from the 2026-05-04 audit (project_audit_2026_05_04.md debt #6):
 *   - briefing             16 KB (operator-typed pitch)
 *   - PRD                  64 KB (structured spec — generous)
 *   - run note             2 KB (per-sprint operator note)
 *   - agent instruction    8 KB (per-step text injection)
 *   - backlog description  32 KB (per-item; titles stay <= 200 chars)
 *
 * Above each cap, requests fail with 400 + a path-specific error message.
 * Above the global 1 MB body cap (api-helpers.ts), the request is rejected
 * with 413 before parsing.
 */
import { z } from "zod";

/* ──────── Size caps (as bytes — Zod's .max measures characters, not
 * bytes, so for ASCII-heavy text these are essentially equivalent.
 * Multi-byte content that fits the char cap will fit the body cap.) ──── */

export const SIZE_BRIEFING            = 16 * 1024;
export const SIZE_PRD                 = 64 * 1024;
export const SIZE_RUN_NOTE            = 2  * 1024;
export const SIZE_AGENT_INSTRUCTION   = 8  * 1024;
export const SIZE_BACKLOG_DESCRIPTION = 32 * 1024;
export const SIZE_BACKLOG_TITLE       = 200;
export const SIZE_PROJECT_NAME        = 200;
export const SIZE_REPO_URL            = 1024;
export const SIZE_GUIDELINES          = 16 * 1024;
export const SIZE_PROTOCOL_OVERRIDE   = 16 * 1024;

/* ──────── Reusable field schemas ──────── */

/** A non-empty string with a name field cap. Trims whitespace. */
export const projectNameField = z.string().trim().min(1).max(SIZE_PROJECT_NAME);

/** A briefing or null. Empty string maps to null at write time downstream. */
export const briefingField = z.string().max(SIZE_BRIEFING, `Briefing capped at ${SIZE_BRIEFING / 1024} KB`).nullable().optional();

export const prdField = z.string().max(SIZE_PRD, `PRD capped at ${SIZE_PRD / 1024} KB`).nullable().optional();

export const runNoteField = z.string().max(SIZE_RUN_NOTE, `Run note capped at ${SIZE_RUN_NOTE / 1024} KB`).optional();

export const agentInstructionField = z.object({
  text:     z.string().max(SIZE_AGENT_INSTRUCTION, `Agent instruction capped at ${SIZE_AGENT_INSTRUCTION / 1024} KB`),
  override: z.boolean(),
});

export const backlogTitleField = z.string().trim().min(1).max(SIZE_BACKLOG_TITLE);

export const backlogDescriptionField = z.string().max(SIZE_BACKLOG_DESCRIPTION, `Backlog description capped at ${SIZE_BACKLOG_DESCRIPTION / 1024} KB`).nullable().optional();

export const repoUrlField = z.string().trim().max(SIZE_REPO_URL).nullable().optional();

export const guidelinesField = z.string().max(SIZE_GUIDELINES, `Guidelines capped at ${SIZE_GUIDELINES / 1024} KB`).optional();

export const protocolOverrideField = z.string().max(SIZE_PROTOCOL_OVERRIDE, `Protocol override capped at ${SIZE_PROTOCOL_OVERRIDE / 1024} KB`).optional();

/** UUID string. Project / agent / sprint / etc. ids. */
export const uuidField = z.string().uuid();

/** Sprint intent enum (mig 169). */
export const sprintIntentField = z.enum(["discovery", "planning", "execution", "review"]);

/** Planning sub-mode (mig 169). */
export const planningSubmodeField = z.enum(["initiation", "grooming", "sprint-backlog"]);

/** CLI execution mode tri-modal. */
export const cliExecutionModeField = z.enum(["cloud", "local", "local-git"]);

/** Trigger source attribution. Must match the CHECK constraint on
 *  sprints.trigger_source (mig 116, extended in mig 169 / 183). */
export const triggerSourceField = z.enum([
  "manual", "cli", "api", "webhook", "auto_drain", "cron_discovery",
]);

/* ──────── Composite schemas ──────── */

/**
 * PATCH /api/projects/[id] body. Most fields are optional — the route
 * applies whichever ones are present. The composite shape here is the
 * source of truth for what the endpoint accepts.
 */
export const ProjectPatchSchema = z.object({
  // identity / state
  name:                     projectNameField.optional(),
  status:                   z.enum(["idle","queued","running","locked","ready","draft","paused","cancelled"]).optional(),
  archived_at:              z.string().nullable().optional(),
  locked:                   z.boolean().optional(),

  // execution config
  execution_mode:           z.enum(["manual", "kanban_manual", "kanban_auto"]).optional(),
  use_operator_git_auth:    z.boolean().optional(),
  repo_url:                 repoUrlField,
  working_destination_id:   z.string().nullable().optional(),

  // intent + pipelines
  pipeline_id:              z.string().nullable().optional(),
  discovery_pipeline_id:    z.string().nullable().optional(),
  planning_pipeline_id:     z.string().nullable().optional(),
  execution_pipeline_id:    z.string().nullable().optional(),
  review_pipeline_id:       z.string().nullable().optional(),
  heuristic_intent:         z.boolean().optional(),

  // text fields with caps
  intake_brief:             briefingField,
  prd_md:                   prdField,

  // budget — narrow validated shape downstream in the route
  budget: z.object({
    enabled:         z.boolean().optional(),
    scope:           z.enum(["api_only", "all"]).optional(),
    monthly_usd_cap: z.number().nonnegative().nullable().optional(),
    daily_usd_cap:   z.number().nonnegative().nullable().optional(),
    action:          z.enum(["warn", "halt"]).optional(),
  }).optional(),

  // arbitrary settings JSONB — bounded only by the global body cap.
  // The route is responsible for accepting only known keys.
  settings: z.unknown().optional(),
}).strict();
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;

/**
 * POST /api/projects/[id]/run body. Heavy surface — many optional knobs
 * the Start Sprint Modal sets per-dispatch.
 */
export const ProjectRunSchema = z.object({
  planId:               uuidField.optional(),
  briefing:             briefingField,
  bypassGates:          z.boolean().optional(),
  provider:             z.string().max(64).optional(),
  model:                z.string().max(128).optional(),
  cliExecutionMode:     cliExecutionModeField.optional(),
  contextSprintIds:     z.array(uuidField).max(50).optional(),
  contextCategories:    z.array(z.enum(["specs", "docs"])).max(2).optional(),
  startFromStep:        z.number().int().min(1).max(100).optional(),
  agentInstructions:    z.record(z.string(), agentInstructionField).optional(),
  stepRoutingOverrides: z.record(z.string(), z.unknown()).optional(),
  runNote:              runNoteField,
  backlogItemIds:       z.array(uuidField).max(50).optional(),
  triggerSource:        triggerSourceField.optional(),
  intent:               sprintIntentField.optional(),
  planningSubmode:      planningSubmodeField.optional(),
  autoClose:            z.boolean().optional(),
  runMode:              z.enum(["execute", "pack-only"]).optional(),
}).strict();
export type ProjectRun = z.infer<typeof ProjectRunSchema>;

/** Backlog item source — manual operator, wizard generation, agent emission, external trigger. */
export const backlogSourceField = z.enum(["manual", "wizard-gen", "trigger", "agent"]);

/**
 * POST /api/projects/[id]/backlog body — adding a new backlog item.
 *
 * Accepts the manual UI shape AND the ingester shape (source_url +
 * source_metadata for items created by GitHub / Jira / agent imports).
 */
export const BacklogAddSchema = z.object({
  title:           backlogTitleField,
  description:     backlogDescriptionField,
  status:          z.enum(["todo", "doing", "done", "cancelled"]).optional(),
  source:          backlogSourceField.optional(),
  order_index:     z.number().int().min(0).max(1_000_000).optional(),
  source_url:      z.string().max(1000).optional(),
  source_metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type BacklogAdd = z.infer<typeof BacklogAddSchema>;

/**
 * PATCH /api/projects/[id]/backlog/[itemId] body — updating an existing item.
 * Allows changing title/description/status/order/sprint_id. All optional —
 * the route rejects an empty patch.
 */
export const BacklogPatchSchema = z.object({
  title:       backlogTitleField.optional(),
  description: backlogDescriptionField,
  status:      z.enum(["todo", "doing", "done", "cancelled"]).optional(),
  order_index: z.number().int().min(0).max(1_000_000).optional(),
  sprint_id:   uuidField.nullable().optional(),
}).strict();
export type BacklogPatch = z.infer<typeof BacklogPatchSchema>;

/**
 * One pipeline step — mirrors the PipelineStep contract every consumer
 * expects (services/control-plane/orchestrator/run-pipeline.ts:19) AND
 * the DB CHECK from mig 185. Catching malformed steps at the API
 * boundary gives a cleaner error than the constraint violation Zod-less
 * inserts would surface.
 */
export const PipelineStepSchema = z.object({
  step:      z.number().int().min(1),
  agent:     z.string().min(1).max(100),
  gate:      z.union([z.literal("human"), z.null()]),
  phase:     z.union([z.number().int().min(1), z.null()]),
  phaseName: z.string().min(1).max(100),
}).passthrough();    // tolerate extra fields the worker doesn't read (descriptions, ui hints)
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

/**
 * POST /api/pipelines body — creating a tenant-custom pipeline.
 */
export const PipelineCreateSchema = z.object({
  tenantId:    uuidField,
  slug:        z.string().trim().min(1).max(100),
  name:        z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  category:    z.string().max(64).optional(),
  steps:       z.array(PipelineStepSchema).min(1).max(50),
  factoryId:   uuidField.optional(),
  /** mig 191 — when set, pipeline is project-scoped instead of factory-scoped. */
  projectId:   uuidField.nullable().optional(),
  mode:        z.string().max(32).optional(),
  intent:      sprintIntentField.optional(),
}).strict();
export type PipelineCreate = z.infer<typeof PipelineCreateSchema>;

/**
 * PATCH /api/pipelines/[id] body — updating an existing custom pipeline.
 * All fields optional; the route applies whichever are present.
 */
export const PipelinePatchSchema = z.object({
  name:        z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category:    z.string().max(64).optional(),
  steps:       z.array(PipelineStepSchema).min(1).max(50).optional(),
  is_active:   z.boolean().optional(),
  mode:        z.string().max(32).optional(),
  intent:      sprintIntentField.optional(),
  /** mig 191 — operator can move a pipeline between factory and project scopes. */
  projectId:   uuidField.nullable().optional(),
}).strict();
export type PipelinePatch = z.infer<typeof PipelinePatchSchema>;

/**
 * POST /api/knowledge body — create a knowledge instance.
 */
export const KnowledgeCreateSchema = z.object({
  tenantId:    uuidField,
  name:        z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
}).strict();
export type KnowledgeCreate = z.infer<typeof KnowledgeCreateSchema>;

/**
 * PATCH /api/knowledge/[instanceId] body — update name / description.
 */
export const KnowledgePatchSchema = z.object({
  name:        z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
}).strict();
export type KnowledgePatch = z.infer<typeof KnowledgePatchSchema>;

/**
 * POST /api/knowledge/[instanceId]/sources body — add a source.
 *
 * Source `type` is one of the four indexer kinds (url / document /
 * github / slack). `config` is freeform per-type — the indexer
 * dispatches by type and validates the config shape downstream.
 * `autoIndex` triggers a Trigger.dev dispatch right after insert.
 */
export const KnowledgeSourceAddSchema = z.object({
  type:      z.enum(["url", "document", "github", "slack"]),
  name:      z.string().trim().min(1).max(200),
  config:    z.record(z.string(), z.unknown()).optional(),
  autoIndex: z.boolean().optional(),
  indexEnv:  z.enum(["prod", "dev"]).optional(),
  // Accepted-but-route-ignored — UI's knowledge add form sends both for
  // pre-flight UX (limits drive client-side warnings) and historical
  // reasons (tenantId is already resolved from the URL-scoped instance,
  // but the form still includes it). Listing them here keeps .strict()
  // happy without forcing a UI refactor.
  tenantId:  uuidField.optional(),
  limits:    z.record(z.string(), z.unknown()).optional(),
}).strict();
export type KnowledgeSourceAdd = z.infer<typeof KnowledgeSourceAddSchema>;

/**
 * PATCH /api/admin/tenants/[id] body — admin tenant config update.
 * Sensitive surface: only `app_metadata.role==='admin'` users can call
 * (route enforces). Two distinct sub-shapes:
 *   - plan/suspended update (general fields)
 *   - resetPassword for a tenant member (uid + new password)
 * Both shapes accepted; the route dispatches by which fields are present.
 */
export const AdminTenantPatchSchema = z.object({
  plan:      z.string().trim().min(1).max(64).optional(),
  suspended: z.boolean().optional(),
  resetPassword: z.object({
    userId:      uuidField,
    newPassword: z.string().min(8, "Password must be at least 8 characters").max(128, "Password capped at 128 characters"),
  }).optional(),
}).strict();
export type AdminTenantPatch = z.infer<typeof AdminTenantPatchSchema>;

/**
 * POST /api/factory/output-destinations body — register a new GitHub
 * destination (owner + PAT) on a factory. Tokens are sensitive — the
 * route masks them on read; here we cap the string length so a giant
 * payload can't slip through. Owner is normalised post-validation
 * (strip https://github.com/ etc.).
 */
export const FactoryDestinationCreateSchema = z.object({
  factoryId: uuidField,
  name:      z.string().trim().min(1).max(100),
  owner:     z.string().trim().min(1).max(200),
  token:     z.string().trim().min(1).max(500),
  branch:    z.string().trim().max(100).nullable().optional(),
}).strict();
export type FactoryDestinationCreate = z.infer<typeof FactoryDestinationCreateSchema>;

/**
 * PATCH /api/factory/output-destinations/[id] body — update a
 * destination. Owner / token / branch each optional; the route applies
 * whichever are present. Same caps as create.
 */
export const FactoryDestinationPatchSchema = z.object({
  name:   z.string().trim().min(1).max(100).optional(),
  owner:  z.string().trim().min(1).max(200).optional(),
  token:  z.string().trim().min(1).max(500).optional(),
  branch: z.string().trim().max(100).nullable().optional(),
}).strict();
export type FactoryDestinationPatch = z.infer<typeof FactoryDestinationPatchSchema>;

/**
 * POST /api/cli/gates/[runId] body — operator's verdict on a paused
 * agent run (human gate). Action enum approve/reject. `comment` is
 * a short note recorded on the audit event; `instructions` is free
 * text fed back to the agent on the next dispatch — bounded by the
 * agent-instruction cap (8 KB) since the worker threads it into the
 * agent's input.
 */
export const CliGateDecisionSchema = z.object({
  action:       z.enum(["approve", "reject"]),
  comment:      z.string().max(SIZE_AGENT_INSTRUCTION).optional(),
  instructions: z.string().max(SIZE_AGENT_INSTRUCTION).optional(),
}).strict();
export type CliGateDecision = z.infer<typeof CliGateDecisionSchema>;

/**
 * POST /api/projects/[id]/sprints/[sprintId]/review body — operator's
 * verdict on a sprint. Verdict enum + reason; reason is the human
 * explanation the dashboard surfaces, capped at the agent-instruction
 * size.
 */
export const SprintReviewSchema = z.object({
  verdict: z.enum(["approve", "reject", "needs_changes"]),
  reason:  z.string().max(SIZE_AGENT_INSTRUCTION).optional(),
  notes:   z.string().max(SIZE_AGENT_INSTRUCTION).optional(),
}).strict();
export type SprintReview = z.infer<typeof SprintReviewSchema>;

/**
 * POST /api/marketplace/skills/publish body — publish a tenant's skill
 * to the marketplace. Operator can override the skill's name +
 * description for the listing (defaults: skill row's own values).
 * Pricing in cents; non-negative, capped at the price of a small
 * apartment so we don't accept Number.MAX_VALUE.
 */
export const MarketplaceSkillsPublishSchema = z.object({
  skill_id:    uuidField,
  name:        z.string().trim().min(1).max(200).optional(),
  description: z.string().max(8000).optional(),
  price_cents: z.number().int().min(0).max(1_000_000_000).optional(),
}).strict();
export type MarketplaceSkillsPublish = z.infer<typeof MarketplaceSkillsPublishSchema>;

/** Agent spec YAML — operator-supplied import body. Structured parse +
 *  shape validation happen DOWNSTREAM in the route after js-yaml runs.
 *  Here we only enforce the byte cap (256 KB) so a bad upload fails
 *  fast before paying for parse + DB scan. */
export const SIZE_AGENT_YAML = 256 * 1024;

/**
 * POST /api/agents/import body — YAML upsert into agent_definitions.
 * The route parses the YAML, validates it has slug + name, and upserts
 * with origin='import'. Schema only caps the inputs at the boundary.
 */
export const AgentImportSchema = z.object({
  tenantId:  uuidField,
  factoryId: uuidField.optional(),
  yaml:      z.string().min(1).max(SIZE_AGENT_YAML, `Agent YAML capped at ${SIZE_AGENT_YAML / 1024} KB`),
}).strict();
export type AgentImport = z.infer<typeof AgentImportSchema>;

/**
 * POST /api/marketplace/install body — install a marketplace listing for
 * the current tenant. Behaviour depends on the listing_type loaded from
 * the listing row (factory / agent / skill / pipeline). The route does
 * dispatch + conflict resolution; this schema only validates inputs.
 *
 * `mode` (mig 171): "install" creates a marketplace_installs ref against
 * the canonical row (default for pipeline / agent); "clone" copies the
 * canonical into the tenant's table.
 *
 * `onConflict` (BL-26 / Discovery Slice 3): caller's response to the 409
 * the route returns when a slug clash is detected.
 */
export const MarketplaceInstallSchema = z.object({
  listingId:       uuidField,
  targetFactoryId: uuidField.optional(),
  targetProjectId: uuidField.optional(),
  onConflict:      z.enum(["replace", "cancel"]).optional(),
  mode:            z.enum(["install", "clone"]).optional(),
}).strict();
export type MarketplaceInstall = z.infer<typeof MarketplaceInstallSchema>;

/**
 * POST /api/projects/[id]/sprints/[sprintId]/save body — finalise a
 * pending-save sprint (push to GH, download as ZIP, discard, close,
 * etc.). Action enum is the union of every supported finalise verb.
 * Optional `targets` narrows export sub-targets; optional `destinations`
 * narrows GitHub push to a subset of factory_output_destinations.
 */
export const SprintSaveSchema = z.object({
  action:       z.enum(["export", "discard", "close", "github", "download", "save"]),
  targets:      z.array(z.string().max(64)).max(20).optional(),
  destinations: z.array(z.string().max(64)).max(20).optional(),
}).strict();
export type SprintSave = z.infer<typeof SprintSaveSchema>;

/**
 * POST /api/onboard/create-tenant body — full onboarding (auth user +
 * tenant + member). Two flows distinguished by the invite code; same
 * input shape. Tenant slug is required and must match the invite's
 * intent (the route enforces).
 */
export const OnboardCreateTenantSchema = z.object({
  tenantName: z.string().trim().min(1).max(SIZE_PROJECT_NAME).optional(),
  tenantSlug: z.string().trim().min(1).max(100),
  email:      z.string().trim().email("Invalid email").max(320),
  password:   z.string().min(8, "Password must be at least 8 characters").max(128, "Password capped at 128 characters"),
  inviteCode: z.string().trim().min(1).max(64),
}).strict();
export type OnboardCreateTenant = z.infer<typeof OnboardCreateTenantSchema>;

/**
 * POST /api/auth/signup body — Supabase Auth user creation via service-role.
 * Uppercase password length floor matches Supabase's own minimum (8 chars).
 * Email cap (320) is the RFC 5321 hard limit; we don't try to validate
 * format beyond Zod's email regex — Supabase rejects malformed addresses
 * downstream with its own error.
 */
export const AuthSignupSchema = z.object({
  email:    z.string().trim().email("Invalid email").max(320),
  password: z.string().min(8, "Password must be at least 8 characters").max(128, "Password capped at 128 characters"),
}).strict();
export type AuthSignup = z.infer<typeof AuthSignupSchema>;

/**
 * POST /api/projects body — creating a new project. Field names follow
 * the existing route's contract (camelCase factoryId, mode "new"|"adopt")
 * for backwards compat; UI clients already serialise to that shape.
 */
export const ProjectCreateSchema = z.object({
  name:                 projectNameField,
  factoryId:            uuidField,
  slug:                 z.string().trim().min(1).max(100).optional(),
  intake_brief:         z.string().min(1, "intake_brief required").max(SIZE_BRIEFING, `Briefing capped at ${SIZE_BRIEFING / 1024} KB`),
  pipeline_id:          z.string().nullable().optional(),
  mode:                 z.enum(["new", "adopt"]).optional(),
  repo_url:             repoUrlField,
  storage_backend_name: z.string().max(64).optional(),
}).strict();
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;

/* ──────── Factory repos (verification flow) ──────── */

/** Allowed `purpose` values for the factory ↔ repo binding. */
export const factoryRepoPurposeField = z.enum(["marketplace", "storage"]);

/** GitHub-style identifier — alphanumeric + dot/hyphen/underscore.
 *  Mirrors the legacy NAME_RE used in factory/repo/* routes. */
const githubIdentifier = z.string().trim().min(1).max(200)
  .regex(/^[a-zA-Z0-9_.-]+$/, "must match [a-zA-Z0-9_.-]+");

/** Branch name — same charset as GitHub plus forward slash. */
const githubBranch = z.string().trim().min(1).max(100)
  .regex(/^[a-zA-Z0-9_.\-/]+$/, "must match [a-zA-Z0-9_.-/]+");

/** Common ref to a factory_repos row: factoryId + purpose. */
export const FactoryRepoBindingRefSchema = z.object({
  factoryId: uuidField,
  purpose:   factoryRepoPurposeField,
}).strict();
export type FactoryRepoBindingRef = z.infer<typeof FactoryRepoBindingRefSchema>;

/** POST /api/factory/repo/configure body. */
export const FactoryRepoConfigureSchema = z.object({
  factoryId: uuidField,
  purpose:   factoryRepoPurposeField,
  owner:     githubIdentifier,
  repo:      githubIdentifier,
  branch:    githubBranch.optional(),
}).strict();
export type FactoryRepoConfigure = z.infer<typeof FactoryRepoConfigureSchema>;

/** POST /api/factory/output-destinations/verify body. Two valid shapes:
 *  - { id }                     — verify an existing destination row
 *  - { factoryId, owner, token } — verify-before-save (UI workflow) */
export const FactoryOutputDestinationVerifySchema = z.union([
  z.object({ id: uuidField }).strict(),
  z.object({
    factoryId: uuidField,
    owner:     z.string().trim().min(1).max(200),
    token:     z.string().trim().min(1).max(500),
  }).strict(),
]);
export type FactoryOutputDestinationVerify = z.infer<typeof FactoryOutputDestinationVerifySchema>;

/* ──────── Tenant integrations + storage backends ──────── */

/** POST /api/settings/integrations body — save a tenant integration's
 *  secret keys. `keys` is a record of secret-name → value, capped at
 *  64 KB total because some integrations need long PATs / certs but
 *  not unbounded blobs. */
export const SettingsIntegrationsSaveSchema = z.object({
  tenantId:  uuidField,
  serviceId: z.string().trim().min(1).max(100),
  keys:      z.record(z.string().max(200), z.string().max(16 * 1024)).default({}),
}).strict();
export type SettingsIntegrationsSave = z.infer<typeof SettingsIntegrationsSaveSchema>;

/** POST /api/settings/integrations/test body. */
export const SettingsIntegrationsTestSchema = z.object({
  tenantId:  uuidField,
  serviceId: z.string().trim().min(1).max(100),
}).strict();
export type SettingsIntegrationsTest = z.infer<typeof SettingsIntegrationsTestSchema>;

/** POST /api/settings/integrations/github-test body. */
export const SettingsIntegrationsGithubTestSchema = z.object({
  tenantId: uuidField,
}).strict();
export type SettingsIntegrationsGithubTest = z.infer<typeof SettingsIntegrationsGithubTestSchema>;

/** POST /api/settings/storage body — save a tenant storage backend.
 *  Field-level structure validated downstream; here we cap raw inputs.
 *  `gitMode` is the StorageBackendConfig enum ("none" | "clone" | "existing"),
 *  not a boolean — the schema accepts both forms during the transition
 *  period and the route normalises. */
export const SettingsStorageSaveSchema = z.object({
  type:       z.enum(["supabase", "local"]),
  name:       z.string().trim().min(1).max(100),
  url:        z.string().max(2000).optional(),
  key:        z.string().max(4 * 1024).optional(),
  basePath:   z.string().max(1000).optional(),
  gitMode:    z.union([z.boolean(), z.enum(["none", "clone", "existing"])]).optional(),
  verified:   z.boolean().optional(),
  verifiedAt: z.string().max(64).optional(),
}).strict();
export type SettingsStorageSave = z.infer<typeof SettingsStorageSaveSchema>;

/** POST /api/settings/storage/test body. Same field set as Save —
 *  the route exercises the connection without persisting. */
export const SettingsStorageTestSchema = z.object({
  name:     z.string().trim().min(1).max(100),
  type:     z.enum(["supabase", "local", "github"]).optional(),
  url:      z.string().max(2000).optional(),
  key:      z.string().max(4 * 1024).optional(),
  basePath: z.string().max(1000).optional(),
}).strict();
export type SettingsStorageTest = z.infer<typeof SettingsStorageTestSchema>;

/** POST /api/settings/apikey body — mint a tenant API key.
 *  factoryId optional: scopes the key to a specific factory. */
export const SettingsApiKeyCreateSchema = z.object({
  tenantId:  uuidField,
  factoryId: uuidField.nullable().optional(),
  name:      z.string().trim().min(1).max(120).nullable().optional(),
}).strict();
export type SettingsApiKeyCreate = z.infer<typeof SettingsApiKeyCreateSchema>;

/* ──────── CLI surface ──────── */

/** POST /api/cli/register body — `tp` daemon registers its install. */
export const CliRegisterSchema = z.object({
  hostname:     z.string().trim().min(1).max(255),
  os_username:  z.string().trim().min(1).max(255),
  platform:     z.string().trim().min(1).max(32),
  arch:         z.string().trim().max(32).optional(),
  node_version: z.string().trim().min(1).max(64),
  cli_version:  z.string().trim().min(1).max(64),
  email:        z.string().trim().max(320).optional(),
}).strict();
export type CliRegister = z.infer<typeof CliRegisterSchema>;

/** POST /api/cli/token body — exchanges a Supabase JWT for a CLI API key. */
export const CliTokenExchangeSchema = z.object({
  tenantId:    uuidField,
  factorySlug: z.string().trim().min(1).max(120),
}).strict();
export type CliTokenExchange = z.infer<typeof CliTokenExchangeSchema>;

/** POST /api/cli/mint-run-token body — exchanges API key for tenant JWT. */
export const CliMintRunTokenSchema = z.object({
  factoryId:  uuidField.optional(),
  ttlSeconds: z.number().int().min(60).max(60 * 60 * 24).optional(),
}).strict();
export type CliMintRunToken = z.infer<typeof CliMintRunTokenSchema>;

/** POST /api/cli/projects body — CLI creates a project from a briefing
 *  + dispatches its pipeline. Slug auto-derived from the briefing's
 *  first sentence when not provided. */
export const CliProjectCreateSchema = z.object({
  briefing:     z.string().trim().min(5, "briefing is required (min 5 chars)").max(SIZE_BRIEFING),
  slug:         z.string().trim().min(1).max(100).optional(),
  domain:       z.string().trim().max(64).optional(),
  pipelineSlug: z.string().trim().max(120).optional(),
  factoryId:    uuidField.optional(),
}).strict();
export type CliProjectCreate = z.infer<typeof CliProjectCreateSchema>;

/** POST /api/cli/projects/[slug]/continue body — resume a paused sprint. */
export const CliProjectContinueSchema = z.object({
  fromStep: z.number().int().min(1).max(100).optional(),
}).strict();
export type CliProjectContinue = z.infer<typeof CliProjectContinueSchema>;

/** POST /api/cli/projects/[slug]/evolve body — start a sustentation cycle. */
export const CliProjectEvolveSchema = z.object({
  type:        z.enum(["fix", "feature", "improvement"]),
  description: z.string().trim().min(5, "description is required (min 5 chars)").max(SIZE_BRIEFING),
}).strict();
export type CliProjectEvolve = z.infer<typeof CliProjectEvolveSchema>;

/** PUT /api/cli/config/[projectId] body — CLI updates the per-project
 *  cli_agents config. Object structure validated downstream. */
export const CliConfigPutSchema = z.object({
  config: z.record(z.string(), z.unknown()),
}).strict();
export type CliConfigPut = z.infer<typeof CliConfigPutSchema>;

/** POST /api/cli/providers body — save a single CLI provider env var
 *  (one var per call). Value is capped because PATs can be long but
 *  not unbounded. */
export const CliProvidersSaveSchema = z.object({
  tenantId: uuidField,
  varName:  z.string().trim().min(1).max(64),
  value:    z.string().trim().min(1).max(16 * 1024),
}).strict();
export type CliProvidersSave = z.infer<typeof CliProvidersSaveSchema>;

/** DELETE /api/cli/providers body — remove a single env var. */
export const CliProvidersDeleteSchema = z.object({
  tenantId: uuidField,
  varName:  z.string().trim().min(1).max(64),
}).strict();
export type CliProvidersDelete = z.infer<typeof CliProvidersDeleteSchema>;

/* ──────── Admin surface ──────── */

/** PUT /api/admin/config body — upsert a known admin config key. The
 *  route validates `key` against the in-file allowlist; here we only
 *  cap the value so giant secrets fail fast. */
export const AdminConfigPutSchema = z.object({
  key:   z.string().trim().min(1).max(64),
  value: z.string().max(8 * 1024),
}).strict();
export type AdminConfigPut = z.infer<typeof AdminConfigPutSchema>;

/** POST /api/admin/promote body — escalate a user to platform_admin
 *  via the bootstrap secret. Email + secret are required; password is
 *  optional (only present on the very first promotion that also creates
 *  the auth user). */
export const AdminPromoteSchema = z.object({
  email:    z.string().trim().email().max(320),
  secret:   z.string().min(1).max(512),
  password: z.string().min(8).max(128).optional(),
}).strict();
export type AdminPromote = z.infer<typeof AdminPromoteSchema>;

/** POST /api/admin/maintenance body — toggle global maintenance mode. */
export const AdminMaintenanceSchema = z.object({
  action: z.enum(["enable", "disable"]),
}).strict();
export type AdminMaintenance = z.infer<typeof AdminMaintenanceSchema>;

/** PATCH /api/admin/beta-testers body — update a beta-tester row. */
export const AdminBetaTesterPatchSchema = z.object({
  id:     uuidField,
  status: z.enum(["applied", "approved", "rejected", "active", "churned"]),
}).strict();
export type AdminBetaTesterPatch = z.infer<typeof AdminBetaTesterPatchSchema>;

/** PATCH /api/admin/notifications body — toggle a notification event. */
export const AdminNotificationsPatchSchema = z.object({
  eventType: z.string().trim().min(1).max(120),
  enabled:   z.boolean(),
}).strict();
export type AdminNotificationsPatch = z.infer<typeof AdminNotificationsPatchSchema>;

/** POST /api/admin/invites body — create a tenant invite. */
export const AdminInviteCreateSchema = z.object({
  plan:          z.string().trim().min(1).max(64).optional(),
  email:         z.string().trim().email().max(320).optional(),
  tenantSlug:    z.string().trim().max(100).optional(),
  tenantName:    z.string().trim().max(SIZE_PROJECT_NAME).optional(),
  role:          z.string().trim().max(64).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  maxUses:       z.number().int().min(1).max(10000).optional(),
}).strict();
export type AdminInviteCreate = z.infer<typeof AdminInviteCreateSchema>;

/** POST /api/admin/curated-repos body — register a curated repo entry. */
export const AdminCuratedRepoCreateSchema = z.object({
  slug:           z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case"),
  name:           z.string().trim().min(1).max(200),
  description:    z.string().max(2000).optional(),
  repo_owner:     z.string().trim().min(1).max(200),
  repo_name:      z.string().trim().min(1).max(200),
  default_branch: z.string().trim().max(100).nullable().optional(),
  paths:          z.record(z.string().max(100), z.string().max(2000)).optional(),
  homepage_url:   z.string().max(2000).nullable().optional(),
  enabled:        z.boolean().optional(),
}).strict();
export type AdminCuratedRepoCreate = z.infer<typeof AdminCuratedRepoCreateSchema>;

/** PATCH /api/admin/curated-repos/[id] body. */
export const AdminCuratedRepoPatchSchema = z.object({
  slug:           z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  name:           z.string().trim().min(1).max(200).optional(),
  description:    z.string().max(2000).optional(),
  repo_owner:     z.string().trim().min(1).max(200).optional(),
  repo_name:      z.string().trim().min(1).max(200).optional(),
  default_branch: z.string().trim().max(100).nullable().optional(),
  paths:          z.record(z.string().max(100), z.string().max(2000)).optional(),
  homepage_url:   z.string().max(2000).nullable().optional(),
  enabled:        z.boolean().optional(),
}).strict();
export type AdminCuratedRepoPatch = z.infer<typeof AdminCuratedRepoPatchSchema>;

/* ──────── Curated-index / GitHub-import ──────── */

/** Body shape shared by every preview-from-URL route (skills, commands,
 *  hooks). The route post-processes `url` after Zod validation. */
export const UrlPreviewSchema = z.object({
  url: z.string().trim().min(1).max(2000),
}).strict();
export type UrlPreview = z.infer<typeof UrlPreviewSchema>;

/** Body for POST /api/skills/github-import. */
export const SkillsGithubImportSchema = z.object({
  url:                       z.string().trim().min(1).max(2000),
  factory_id:                uuidField,
  project_id:                uuidField.nullable().optional(),
  slug:                      z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/),
  name:                      z.string().trim().min(1).max(200),
  description:               z.string().min(1).max(8000),
  category:                  z.enum(["guideline", "playbook", "reference"]),
  allowed_tools:             z.array(z.string().max(120)).max(50).optional(),
  disable_model_invocation:  z.boolean().optional(),
}).strict();
export type SkillsGithubImport = z.infer<typeof SkillsGithubImportSchema>;

/** Body for POST /api/commands/github-import. */
export const CommandsGithubImportSchema = z.object({
  url:         z.string().trim().min(1).max(2000),
  factory_id:  uuidField,
  project_id:  uuidField.nullable().optional(),
  slug:        z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/),
  name:        z.string().trim().min(1).max(200),
  description: z.string().max(8000).optional(),
  body:        z.string().max(64 * 1024).optional(),
}).strict();
export type CommandsGithubImport = z.infer<typeof CommandsGithubImportSchema>;

/** Body for POST /api/hooks/github-import. */
export const HooksGithubImportSchema = z.object({
  url:         z.string().trim().min(1).max(2000),
  factory_id:  uuidField,
  project_id:  uuidField.nullable().optional(),
  hook_id:     z.string().trim().min(1).max(120),
  slug:        z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9-]*$/),
  name:        z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
}).strict();
export type HooksGithubImport = z.infer<typeof HooksGithubImportSchema>;

/** Body for POST /api/skills/built-in/install. */
export const SkillsBuiltInInstallSchema = z.object({
  built_in_skill_id: z.string().trim().min(1).max(120),
  factory_id:        uuidField,
  project_id:        uuidField.nullable().optional(),
}).strict();
export type SkillsBuiltInInstall = z.infer<typeof SkillsBuiltInInstallSchema>;

/** Body for POST /api/skills/updates/check. */
export const SkillsUpdatesCheckSchema = z.object({
  factory_id: uuidField,
  project_id: uuidField.nullable().optional(),
}).strict();
export type SkillsUpdatesCheck = z.infer<typeof SkillsUpdatesCheckSchema>;

/** Body for POST /api/skills/updates/apply. */
export const SkillsUpdatesApplySchema = z.object({
  skill_id: uuidField,
}).strict();
export type SkillsUpdatesApply = z.infer<typeof SkillsUpdatesApplySchema>;

/* ──────── Marketplace ──────── */

/** POST /api/marketplace/import body — install an agent/pipeline listing. */
export const MarketplaceImportSchema = z.object({
  listingId:       uuidField,
  agentSlug:       z.string().trim().min(1).max(120).optional(),
  targetFactoryId: uuidField.optional(),
  onConflict:      z.enum(["replace", "cancel"]).optional(),
}).strict();
export type MarketplaceImport = z.infer<typeof MarketplaceImportSchema>;

/** POST /api/marketplace/import-skill body. */
export const MarketplaceImportSkillSchema = z.object({
  listingId:       uuidField,
  skillSlug:       z.string().trim().min(1).max(120).optional(),
  targetFactoryId: uuidField.optional(),
  mode:            z.enum(["install", "clone"]).optional(),
  onConflict:      z.enum(["replace", "cancel"]).optional(),
}).strict();
export type MarketplaceImportSkill = z.infer<typeof MarketplaceImportSkillSchema>;

/** POST /api/marketplace/uninstall body. */
export const MarketplaceUninstallSchema = z.object({
  listingId:       uuidField.optional(),
  agentSlug:       z.string().trim().min(1).max(120).optional(),
  skillSlug:       z.string().trim().min(1).max(120).optional(),
  targetFactoryId: uuidField.optional(),
  kind:            z.enum(["agent", "pipeline", "skill"]).optional(),
}).strict();
export type MarketplaceUninstall = z.infer<typeof MarketplaceUninstallSchema>;

/** POST /api/marketplace/publish + /unpublish body. */
export const MarketplaceFactoryPublishSchema = z.object({
  factoryId: uuidField,
}).strict();
export type MarketplaceFactoryPublish = z.infer<typeof MarketplaceFactoryPublishSchema>;

/** PATCH /api/marketplace/listings/[id] body. */
export const MarketplaceListingPatchSchema = z.object({
  visibility: z.enum(["public", "private"]),
}).strict();
export type MarketplaceListingPatch = z.infer<typeof MarketplaceListingPatchSchema>;

/* ──────── Project lifecycle ──────── */

/** POST /api/projects/[id]/approve body. */
export const ProjectApproveSchema = z.object({
  runId:            uuidField,
  instructions:     z.string().max(SIZE_AGENT_INSTRUCTION).optional(),
  cliExecutionMode: cliExecutionModeField.optional(),
}).strict();
export type ProjectApprove = z.infer<typeof ProjectApproveSchema>;

/** POST /api/projects/[id]/continue body. */
export const ProjectContinueSchema = z.object({
  fromStep:         z.number().int().min(1).max(100).optional(),
  toStep:           z.number().int().min(1).max(100).optional(),
  note:             runNoteField,
  bypassGates:      z.boolean().optional(),
  provider:         z.string().max(64).optional(),
  model:            z.string().max(128).optional(),
  cliExecutionMode: cliExecutionModeField.optional(),
}).strict();
export type ProjectContinue = z.infer<typeof ProjectContinueSchema>;

/** POST /api/projects/[id]/edit-claim body. */
export const ProjectEditClaimSchema = z.object({
  force: z.boolean().optional(),
}).strict();
export type ProjectEditClaim = z.infer<typeof ProjectEditClaimSchema>;

/** PATCH /api/projects/[id]/sprints/[sprintId] body — finalise a stuck sprint. */
export const ProjectSprintFinalizeSchema = z.object({
  status: z.string().trim().min(1).max(64),
  note:   z.string().max(SIZE_AGENT_INSTRUCTION).optional(),
}).strict();
export type ProjectSprintFinalize = z.infer<typeof ProjectSprintFinalizeSchema>;

/** POST /api/projects/[id]/knowledge body — enable/disable knowledge instances. */
export const ProjectKnowledgePatchSchema = z.object({
  instances: z.array(z.object({
    id:      uuidField,
    enabled: z.boolean(),
  })).max(50),
}).strict();
export type ProjectKnowledgePatch = z.infer<typeof ProjectKnowledgePatchSchema>;

/** PATCH /api/projects/[id]/memory/[entryId] body. */
export const ProjectMemoryPatchSchema = z.object({
  status:           z.enum(["approved", "rejected", "archived"]).optional(),
  rejection_reason: z.string().max(2000).nullable().optional(),
}).strict();
export type ProjectMemoryPatch = z.infer<typeof ProjectMemoryPatchSchema>;

/** POST /api/projects/[id]/pack/remove body. */
export const ProjectPackRemoveSchema = z.object({
  cliExecutionMode: cliExecutionModeField.optional(),
}).strict();
export type ProjectPackRemove = z.infer<typeof ProjectPackRemoveSchema>;

/** POST /api/projects/[id]/sprint-plan body — accepts the same shape as
 *  ProjectRunSchema's overrides field. We keep it open via passthrough
 *  because the route forwards directly to the planner. */
export const ProjectSprintPlanSchema = z.object({}).passthrough();
export type ProjectSprintPlan = z.infer<typeof ProjectSprintPlanSchema>;

/* ──────── Knowledge sources ──────── */

/** PATCH /api/knowledge/[instanceId]/sources/[sourceId] body — pause /
 *  unpause / resume / rename / change config / clear error message. */
export const KnowledgeSourcePatchSchema = z.object({
  status:     z.enum(["paused", "pending", "indexed"]).optional(),
  name:       z.string().trim().min(1).max(200).optional(),
  config:     z.record(z.string(), z.unknown()).optional(),
  clearError: z.boolean().optional(),
}).strict();
export type KnowledgeSourcePatch = z.infer<typeof KnowledgeSourcePatchSchema>;

/** POST /api/knowledge/[instanceId]/sources/[sourceId]/reindex body. */
export const KnowledgeSourceReindexSchema = z.object({
  indexEnv: z.enum(["dev", "prod"]).optional(),
}).strict();
export type KnowledgeSourceReindex = z.infer<typeof KnowledgeSourceReindexSchema>;

/** POST /api/knowledge/[instanceId]/search body. */
export const KnowledgeSearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
export type KnowledgeSearch = z.infer<typeof KnowledgeSearchSchema>;

/* ──────── Notifications + misc operator surface ──────── */

/** PATCH /api/notifications/preferences. */
export const NotificationsPreferencesPatchSchema = z.object({
  tenantId:  uuidField,
  eventType: z.string().trim().min(1).max(120),
  channel:   z.string().trim().min(1).max(64),
  enabled:   z.boolean(),
}).strict();
export type NotificationsPreferencesPatch = z.infer<typeof NotificationsPreferencesPatchSchema>;

/** POST /api/notifications/channels. */
export const NotificationsChannelUpsertSchema = z.object({
  tenantId:         uuidField,
  channel:          z.string().trim().min(1).max(64),
  name:             z.string().trim().max(120).optional(),
  config:           z.record(z.string(), z.unknown()).optional(),
  enabled:          z.boolean().optional(),
  integration_type: z.string().trim().max(64).optional(),
}).strict();
export type NotificationsChannelUpsert = z.infer<typeof NotificationsChannelUpsertSchema>;

/** POST /api/notifications/channels/test. Per-channel ad-hoc fields
 *  (bot_token / chat_id for telegram, url / secret for webhook) — kept
 *  permissive via passthrough; the route validates required fields per
 *  channel branch. */
export const NotificationsChannelTestSchema = z.object({
  tenantId:  uuidField,
  channel:   z.string().trim().min(1).max(64),
  url:       z.string().max(2000).optional(),
  secret:    z.string().max(2000).optional(),
  bot_token: z.string().max(500).optional(),
  chat_id:   z.string().max(120).optional(),
}).passthrough();
export type NotificationsChannelTest = z.infer<typeof NotificationsChannelTestSchema>;

/** POST /api/notifications/read-all + /clear-all. */
export const NotificationsTenantOpSchema = z.object({
  tenantId: uuidField,
}).strict();
export type NotificationsTenantOp = z.infer<typeof NotificationsTenantOpSchema>;

/** POST /api/factory/harness-presets — operator-typed harness config. */
export const FactoryHarnessPresetCreateSchema = z.object({
  factoryId:   uuidField,
  name:        z.string().trim().min(1).max(200),
  slug:        z.string().trim().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  config:      z.unknown(),
}).strict();
export type FactoryHarnessPresetCreate = z.infer<typeof FactoryHarnessPresetCreateSchema>;

/** PATCH /api/factory/harness-presets/[id]. */
export const FactoryHarnessPresetPatchSchema = z.object({
  name:        z.string().trim().min(1).max(200).optional(),
  slug:        z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  config:      z.unknown().optional(),
}).strict();
export type FactoryHarnessPresetPatch = z.infer<typeof FactoryHarnessPresetPatchSchema>;

/** POST /api/waiting-list + /beta-testers (public — no auth). */
export const WaitingListCreateSchema = z.object({
  organization: z.string().trim().max(200).optional(),
  name:         z.string().trim().min(1).max(200),
  email:        z.string().trim().email().max(320),
  use_case:     z.string().max(2000).optional(),
}).strict();
export type WaitingListCreate = z.infer<typeof WaitingListCreateSchema>;

/** POST /api/invite/validate (public — checks code before signup). */
export const InviteValidateSchema = z.object({
  code:  z.string().trim().min(1).max(64),
  email: z.string().trim().email().max(320).optional(),
  slug:  z.string().trim().max(100).optional(),
}).strict();
export type InviteValidate = z.infer<typeof InviteValidateSchema>;

/** POST /api/workers/deployed — CLI ping that announces a deployed worker. */
export const WorkersDeployedSchema = z.object({
  env:        z.enum(["prod", "dev"]),
  cliVersion: z.string().trim().min(1).max(64),
  imageRef:   z.string().trim().max(500).optional(),
  branch:     z.string().trim().max(100).optional(),
  notes:      z.string().max(2000).optional(),
}).strict();
export type WorkersDeployed = z.infer<typeof WorkersDeployedSchema>;


/** POST /api/settings/integrations/trigger-sync body — push env vars
 *  into Trigger.dev. Each value capped per-key (PATs / urls). null = unset. */
export const TriggerSyncSchema = z.object({
  tenantId:  uuidField,
  variables: z.record(
    z.string().max(120),
    z.union([z.string().max(16 * 1024), z.null()]),
  ),
}).strict();
export type TriggerSync = z.infer<typeof TriggerSyncSchema>;
