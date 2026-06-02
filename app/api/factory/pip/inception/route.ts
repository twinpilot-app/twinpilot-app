/**
 * POST /api/factory/pip/inception
 *
 * Run Inception. Creates a TEMPORARY project (status idle, marked
 * `settings.kind = 'pip-inception'`) plus dispatches the
 * pip-reverse-engineering pipeline against it. The pipeline scans the
 * operator-supplied source, produces briefing + PRD + architecture +
 * backlog draft + recommendations, and (since mig 194) calls apply_pip
 * inline to materialise the real project + every component atomically.
 * Sprint terminates on apply_pip success.
 *
 * Three input modes (decided 2026-05-06):
 *   1. clone:      clone a remote URL into TwinPilot's tmp dir for
 *                  scanning; after import, the new project's permanent
 *                  workdir is canonical (BASE/TwinPilotProjects/...).
 *   2. use-local:  point at an existing-git path on the operator's
 *                  machine; that path becomes the project's permanent
 *                  workdir verbatim (via projects.workdir_override).
 *   3. init-local: point at a non-git path on the operator's machine;
 *                  same workdir semantics as use-local, plus optional
 *                  git init at apply_pip post-import bootstrap.
 *
 * Cloud-mode dispatch only supports `clone` (operator's filesystem isn't
 * reachable from Trigger.dev's hosted env). use-local / init-local force
 * local-git dispatch — caller must have `tp workers dev` running.
 *
 * Auth: getUser + assertMember(platform_admin | admin) on factory.
 *
 * Response 201: { projectId, projectSlug, sprintId, triggerRunId }
 * Response 4xx/5xx: { error, code?, hint? } with cleanup of any
 *   half-created temp project.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getUser, assertMember,
} from "@/lib/api-helpers";
import { dispatchSprint } from "@/lib/sprint-dispatcher";

export const dynamic = "force-dynamic";

const PIP_PIPELINE_SLUG = "pip-reverse-engineering";

/* ─── Input schemas ────────────────────────────────────────────────── */

const RefSchema = z.object({
  name:        z.string().min(1).max(120),
  source:      z.string().min(1).max(2000),
  description: z.string().max(2000).optional(),
}).strict();

const SourceSchema = z.object({
  /** Absolute path on the operator's machine. The worker copies the
   *  contents into the inception tmp dir for scanning; after apply,
   *  projects.workdir_override = this path. The worker auto-inits a
   *  git repo on the new project's first sprint if .git is absent. */
  local_path: z.string().min(1).max(2000),
  /** Optional remote URL — persisted to projects.repo_url at apply.
   *  Operator can also set later via Project Settings. */
  remote_url: z.string().url().optional(),
}).strict();

const InceptionRequestSchema = z.object({
  factoryId:   z.string().uuid("factoryId must be a UUID"),
  source:      SourceSchema,
  projectName: z.string().min(1).max(200).optional(),
  refs:        z.array(RefSchema).max(20).optional(),
  /** Per-inception auto-apply override. Default false (operator
   *  reviews the JSON in PIP > Browse before clicking Apply). */
  autoApply:   z.boolean().optional(),
}).strict();

type InceptionRequest = z.infer<typeof InceptionRequestSchema>;
type InceptionSource  = InceptionRequest["source"];

/* ─── Helpers ──────────────────────────────────────────────────────── */

function deriveProjectName(source: InceptionSource): string {
  const last = source.local_path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (!last) return "Inception";
  return last
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function deriveSlug(name: string): string {
  const base = name.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `pip-inception-${base || "repo"}-${suffix}`;
}

function describeSource(source: InceptionSource): string {
  return `local path \`${source.local_path}\``
    + (source.remote_url ? ` (remote \`${source.remote_url}\`)` : "");
}

function composeBriefing(source: InceptionSource, refs: { name: string; source: string; description?: string }[]): string {
  const lines: string[] = [];
  lines.push("# PIP Reverse-Engineering — anchoring");
  lines.push("");
  lines.push("> Read this carefully. The single most common failure mode in this pipeline is agents describing the wrong thing.");
  lines.push("");
  lines.push("## Target vs. subject");
  lines.push("");
  lines.push("**Target** (what you describe, observe, scan, output ABOUT): the existing codebase staged in your **workdir**. That repository is the real project the operator wants TwinPilot to onboard.");
  lines.push("");
  lines.push("**Subject** (the sprint you are running in): a throwaway scratchpad project named `pip-inception-...`. It exists only to host this Reverse-Engineering sprint. **Never describe it.** Never reference its name, slug, briefing, or settings in your outputs. It will be deleted after `apply_pip` materialises the real project.");
  lines.push("");
  lines.push("Concretely:");
  lines.push("- `briefing.md` describes the target repo (not \"this is a temporary project\").");
  lines.push("- `prd-rationale.md` / persisted PRD describe the target product.");
  lines.push("- `architecture.md` describes the target architecture.");
  lines.push("- `backlog-draft.md` lists work items found in the target.");
  lines.push("- `recommendations.md` recommends components for the target.");
  lines.push("- `pip.json` describes the future real project (derived from the target).");
  lines.push("");
  lines.push(`**Source of the target:** ${describeSource(source)}`);
  lines.push("");
  lines.push("`repo-scout` has staged the target's contents in your workdir. Use `list_project_files` / `read_project_file` against the workdir to inspect it. Do not query DB tables to learn about the target — the workdir is the source of truth.");
  lines.push("");
  if (refs.length > 0) {
    lines.push("## Operator-supplied references (about the target)");
    lines.push("");
    lines.push("Authoritative additional context the operator provided about the target repo. Treat as ground truth where it conflicts with what you'd infer from code alone:");
    lines.push("");
    for (const r of refs) {
      lines.push(`- **${r.name}** — \`${r.source}\``);
      if (r.description) lines.push(`  ${r.description}`);
    }
    lines.push("");
  }
  lines.push("## Outputs you produce");
  lines.push("");
  lines.push("All written via `write_sprint_audit` (the temp sprint's audit space) plus `write_project_prd` for the PRD. Final step (`pip-composer`) emits `pip.json` and calls `apply_pip` to create the real project + components in the operator's tenant.");
  return lines.join("\n");
}

/** Build the workdir_setup directive stored on the temp project's
 *  settings.pip_inception. The apply route reads this and uses it as
 *  the source of truth for the new project's workdir_override +
 *  repo_url. Mirrors PipWorkdirSetupSchema in pip-spec.ts. */
function buildWorkdirSetup(source: InceptionSource): Record<string, unknown> {
  return {
    local_path: source.local_path,
    ...(source.remote_url ? { remote_url: source.remote_url } : {}),
  };
}

/* ─── Route ────────────────────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  let createdProjectId: string | null = null;
  let createdSprintId:  string | null = null;

  try {
    const { user, sb } = await getUser(req);

    const raw = await req.text();
    let parsed: unknown;
    try { parsed = raw.length === 0 ? {} : JSON.parse(raw); }
    catch (e) { throw new ValidationError(`Invalid JSON: ${(e as Error).message}`, []); }
    const result = InceptionRequestSchema.safeParse(parsed);
    if (!result.success) {
      const details = result.error.issues.map((iss) => ({
        path:    iss.path.map((p) => String(p)),
        message: iss.message,
      }));
      throw new ValidationError("Inception request failed validation", details);
    }
    const { factoryId, source, projectName, refs = [], autoApply } = result.data;

    const { tenantId } = await assertMember(sb, user.id, factoryId, ["platform_admin", "admin"]);

    // Workdir-override collision check — the operator's local_path
    // becomes the new project's workdir_override at apply time. Bail
    // if anything else already claims it (would lead to two projects
    // writing to the same filesystem location).
    {
      const { data: clash } = await sb
        .from("projects")
        .select("id, slug, name")
        .eq("workdir_override", source.local_path)
        .maybeSingle();
      if (clash) {
        return NextResponse.json({
          error: `Local path "${source.local_path}" is already the workdir of project "${clash.name}" (${clash.slug}). Pick a different path or remove the other project first.`,
          code:  "workdir-clash",
        }, { status: 409 });
      }
    }

    const finalName = projectName?.trim() || deriveProjectName(source);

    // Resolve the canonical pip-reverse-engineering pipeline. Pull its
    // steps too so we can copy them into the sprint row — run-pipeline
    // uses sprint.steps as source-of-truth and falls back to
    // project.pipeline (which we don't populate on temp projects).
    const { data: pipelineRow } = await sb
      .from("pipelines")
      .select("id, steps")
      .eq("slug", PIP_PIPELINE_SLUG)
      .is("tenant_id", null)
      .maybeSingle();
    if (!pipelineRow) {
      return NextResponse.json({
        error: "PIP inception isn't available in this deployment yet — contact your platform administrator.",
        code:  "PIP_NOT_PROVISIONED",
      }, { status: 503 });
    }
    const pipelineId    = pipelineRow.id    as string;
    const pipelineSteps = pipelineRow.steps as unknown[];
    if (!Array.isArray(pipelineSteps) || pipelineSteps.length === 0) {
      return NextResponse.json({
        error: "PIP inception isn't fully configured in this deployment — contact your platform administrator.",
        code:  "PIP_PIPELINE_INVALID",
      }, { status: 503 });
    }

    const tempSlug    = deriveSlug(finalName);
    const briefing    = composeBriefing(source, refs);
    const workdirSetup = buildWorkdirSetup(source);

    // Single source mode (Local) → always local-git dispatch. The
    // worker auto-inits a git repo in the new project's workdir if
    // .git is absent at the first sprint dispatch.
    const dispatchMode:   "cloud" | "local"     = "local";
    const payloadCliMode: "cloud" | "local-git" = "local-git";

    // Resolve cli_agents for the temp inception sprint. Source priority:
    //   1. factories.config.pip.cli_config — operator's PIP-specific
    //      preference (CLI / model / effort, plus per-RE-agent overrides)
    //      set via PIP > Settings.
    //   2. The most recent project on this factory whose settings.cli_agents
    //      is enabled — fallback when no PIP-specific config exists.
    //   3. Hardcoded default (claude-code + oauth/api-key based on mode).
    //
    // Without ANY source, the temp project would have undefined
    // cli_agents → run-pipeline takes the SDK provider path → Anthropic
    // SDK can't auth on local-git workers (no ANTHROPIC_API_KEY). The
    // fallback chain prevents that.
    interface CliAgentsConfigShape {
      enabled?:           boolean;
      default_cli?:       string;
      authMode?:          string;
      execution_backend?: string;
      local_base_path?:   string;
      orchestration_mode?: string;
      default_model?:     string;
      default_effort?:    string;
      agent_overrides?:   Record<string, Record<string, unknown>>;
      [k: string]:        unknown;
    }

    // (1) PIP-specific config from factories.config.pip.cli_config.
    const { data: factoryRow } = await sb
      .from("factories")
      .select("config")
      .eq("id", factoryId)
      .maybeSingle();
    const factoryCfg = ((factoryRow?.config ?? {}) as Record<string, unknown>);
    const pipCfg     = ((factoryCfg.pip   ?? {}) as Record<string, unknown>);
    const pipCliCfg  = (pipCfg.cli_config as CliAgentsConfigShape | undefined);

    // (2) Inheritance fallback — recent projects with cli_agents enabled.
    let inheritedCliCfg: CliAgentsConfigShape | undefined = pipCliCfg;
    if (!inheritedCliCfg) {
      const { data: refProject } = await sb
        .from("projects")
        .select("settings")
        .eq("factory_id", factoryId)
        .order("created_at", { ascending: false })
        .limit(20);
      for (const row of refProject ?? []) {
        const s = (row as { settings?: Record<string, unknown> }).settings ?? {};
        const c = s.cli_agents as CliAgentsConfigShape | undefined;
        if (c?.enabled) { inheritedCliCfg = c; break; }
      }
    }

    // Mig 200's 5 RE agent slugs. Used to seed agent_overrides on the
    // temp inception's cli_agents config so each step takes the CLI
    // (claude-code etc.) path instead of the SDK provider path.
    const RE_AGENT_SLUGS = [
      "pip-scout",
      "pip-product-manager",
      "pip-architect",
      "pip-components-builder",
      "pip-composer",
    ];
    const defaultCli      = inheritedCliCfg?.default_cli ?? "claude-code";
    const defaultAuthMode = inheritedCliCfg?.authMode
                           ?? (payloadCliMode === "local-git" ? "oauth" : "api-key");
    const defaultModel    = inheritedCliCfg?.default_model;
    const defaultEffort   = inheritedCliCfg?.default_effort;

    const baseOverride: Record<string, unknown> = {
      enabled:  true,
      cli:      defaultCli,
      authMode: defaultAuthMode,
      ...(defaultModel  ? { model:  defaultModel  } : {}),
      ...(defaultEffort ? { effort: defaultEffort } : {}),
    };
    const inceptionAgentOverrides: Record<string, Record<string, unknown>> = {
      ...(inheritedCliCfg?.agent_overrides ?? {}),
    };
    for (const slug of RE_AGENT_SLUGS) {
      // PIP-config per-agent overrides (when set) merge OVER the base
      // — model + effort the operator picked specifically for that
      // RE agent stays. enabled is forced true so dispatch hits the
      // CLI path even if the operator forgot to set it.
      const operatorOverride = inceptionAgentOverrides[slug];
      if (operatorOverride) {
        inceptionAgentOverrides[slug] = {
          ...baseOverride,
          ...operatorOverride,
          enabled: true,
        };
      } else {
        inceptionAgentOverrides[slug] = baseOverride;
      }
    }
    const inceptionCliCfg: CliAgentsConfigShape = {
      ...(inheritedCliCfg ?? {}),
      enabled:           true,
      default_cli:       defaultCli,
      authMode:          defaultAuthMode,
      execution_backend: inheritedCliCfg?.execution_backend
        ?? (payloadCliMode === "local-git" ? "local" : "supabase"),
      orchestration_mode: payloadCliMode,
      ...(defaultModel  ? { default_model:  defaultModel  } : {}),
      ...(defaultEffort ? { default_effort: defaultEffort } : {}),
      agent_overrides: inceptionAgentOverrides,
    };

    // Temp project. settings.pip_inception.workdir_setup is the source
    // of truth — apply route reads it (ignoring whatever the LLM puts
    // in pip.json.project.workdir_setup) and sets repo_url +
    // workdir_override on the new project from there.
    const { data: tempProject, error: projErr } = await sb
      .from("projects")
      .insert({
        factory_id:            factoryId,
        slug:                  tempSlug,
        name:                  finalName,
        intake_brief:          briefing,
        repo_url:              source.remote_url ?? null,
        status:                "idle",
        discovery_pipeline_id: pipelineId,
        pipeline_id:           pipelineId,
        heuristic_intent:      false,
        settings: {
          kind: "pip-inception",
          pip_inception: {
            input_mode:    "local",
            workdir_setup: workdirSetup,
            project_name:  finalName,
            refs,
            started_at:    new Date().toISOString(),
            ...(autoApply !== undefined ? { auto_apply: autoApply } : {}),
          },
          cli_agents:      inceptionCliCfg,
        },
      })
      .select("id, slug")
      .single();
    if (projErr || !tempProject) {
      return NextResponse.json({
        error: `Failed to create temp project: ${projErr?.message ?? "unknown"}`,
      }, { status: 500 });
    }
    createdProjectId = tempProject.id as string;

    const { data: sprint, error: sprintErr } = await sb
      .from("sprints")
      .insert({
        project_id:     createdProjectId,
        sprint_num:     1,
        pipeline_id:    pipelineId,
        steps:          pipelineSteps,  // copy from canonical pipeline (run-pipeline reads sprint.steps)
        status:         "queued",
        briefing,
        base_ref:       "unversioned",
        trigger_source: "manual",
        intent:         "discovery",
      })
      .select("id")
      .single();
    if (sprintErr || !sprint) {
      await sb.from("projects").delete().eq("id", createdProjectId);
      return NextResponse.json({
        error: `Failed to create inception sprint: ${sprintErr?.message ?? "unknown"}`,
      }, { status: 500 });
    }
    createdSprintId = sprint.id as string;

    const dispatch = await dispatchSprint({
      sb,
      projectId:        createdProjectId,
      factoryId,
      tenantId,
      projectSlug:      tempSlug,
      sprintId:         createdSprintId,
      cliExecutionMode: dispatchMode,
      payload: {
        signal:           briefing,
        sprintId:         createdSprintId,
        sprintNum:        1,
        intent:           "discovery",
        cliExecutionMode: payloadCliMode,
      },
    });

    if (!dispatch.ok) {
      await sb.from("sprints").delete().eq("id", createdSprintId);
      await sb.from("projects").delete().eq("id", createdProjectId);
      return NextResponse.json({
        error: `Inception dispatch failed: ${dispatch.reason}`,
        code:  dispatch.reason,
        hint:  dispatch.detail
          ?? (payloadCliMode === "local-git"
              ? "Caso use-local / init-local need a local worker — run `tp workers dev` and retry."
              : undefined),
      }, { status: 502 });
    }

    return NextResponse.json({
      projectId:    createdProjectId,
      projectSlug:  tempSlug,
      sprintId:     createdSprintId,
      triggerRunId: dispatch.triggerRunId,
    }, { status: 201 });
  } catch (e) {
    if (createdSprintId  || createdProjectId) {
      try {
        const { sb } = await getUser(req);
        if (createdSprintId)  await sb.from("sprints").delete().eq("id", createdSprintId);
        if (createdProjectId) await sb.from("projects").delete().eq("id", createdProjectId);
      } catch { /* ignore */ }
    }
    if (e instanceof AuthError)      return NextResponse.json({ error: e.message }, { status: 401 });
    if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof NotFoundError)  return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message, details: e.details }, { status: 400 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
