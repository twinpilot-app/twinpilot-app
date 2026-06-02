/**
 * POST /api/factory/pip/inception/apply
 *
 * Operator-driven apply path. Reads the pip.json that pip-composer
 * stashed into sprints.outcome.pip_json, validates it against the
 * minimal-template PIP schema (lib/pip-spec.ts), calls the pip_import
 * RPC (mig 206) to atomically materialise the real project +
 * project-scoped components, then deletes the temp inception project.
 *
 * pip_import handles the workdir bootstrap hints (repo_url +
 * workdir_override) on the new projects row; actual git clone / init
 * happens on the operator's machine at the new project's first
 * sprint dispatch (cli-executor's prepareSprintWorkspace).
 *
 * Auth: getUser + assertMember(platform_admin | admin) on factory.
 *
 * Response 200: { projectId, projectSlug, inserted, warnings }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getUser, assertMember, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { PipSchema } from "@/lib/pip-spec";

export const dynamic = "force-dynamic";

const ApplySchema = z.object({
  inceptionProjectId: z.string().uuid("inceptionProjectId must be a UUID"),
}).strict();

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, ApplySchema);
    const { sb, user } = await getUser(req);

    // Resolve inception project + its factory.
    const { data: inception } = await sb
      .from("projects")
      .select("id, factory_id, settings")
      .eq("id", body.inceptionProjectId)
      .maybeSingle();
    if (!inception) throw new NotFoundError("Inception project not found");
    const settings = (inception.settings ?? {}) as Record<string, unknown>;
    if (settings.kind !== "pip-inception") {
      throw new ValidationError("Project is not a PIP inception", []);
    }
    const factoryId = inception.factory_id as string;

    await assertMember(sb, user.id, factoryId, ["platform_admin", "admin"]);

    // Pull the latest sprint for this inception that has a stashed
    // pip.json. Inception sprints are typically a single sprint
    // (sprint_num=1) — we query order-desc to be safe in case a
    // resumed/retried sprint produced the JSON last.
    const { data: sprints } = await sb
      .from("sprints")
      .select("id, sprint_num, outcome, status")
      .eq("project_id", body.inceptionProjectId)
      .order("sprint_num", { ascending: false })
      .limit(5);
    const sprintWithPip = (sprints ?? []).find(
      (s) => s.outcome && (s.outcome as Record<string, unknown>).pip_json,
    );
    if (!sprintWithPip) {
      throw new NotFoundError(
        "No pip.json found in any sprint outcome for this inception. " +
        "The pip-composer step must complete before Apply is available.",
      );
    }
    const outcome = sprintWithPip.outcome as Record<string, unknown>;
    const rawPip = outcome.pip_json;

    if (!rawPip || typeof rawPip !== "object") {
      throw new ValidationError("Stashed pip_json is not a JSON object", []);
    }

    // Validate via PipSchema. Strict on required fields, silent on
    // extras (schema strips unknown keys at parse time). Schema fail
    // surfaces the exact field path so the operator sees something
    // actionable rather than a raw DB constraint message.
    const parsed = PipSchema.safeParse(rawPip);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 8).map((i) => ({
        path:    i.path.map(String),
        message: i.message,
      }));
      throw new ValidationError(
        `PIP JSON failed schema validation (${parsed.error.issues.length === 1 ? "1 issue" : `${parsed.error.issues.length} issues`}). First problem: ${issues[0]?.path.join(".")} — ${issues[0]?.message}`,
        issues,
      );
    }
    const pip = parsed.data;

    // workdir_setup is ALWAYS taken from the temp inception's stored
    // settings.pip_inception.workdir_setup — set at dispatch time from
    // the operator's input mode. The LLM's pip.project.workdir_setup
    // (if any) is ignored: the operator already picked the input mode
    // and the LLM round-tripping it just creates failure modes
    // (missing local_path, wrong kind, etc.).
    const tempWorkdirSetup = (settings.pip_inception as Record<string, unknown> | undefined)?.workdir_setup;
    const projectMeta: Record<string, unknown> = {
      ...(pip.project as Record<string, unknown>),
      ...(tempWorkdirSetup && typeof tempWorkdirSetup === "object"
        ? { workdir_setup: tempWorkdirSetup }
        : {}),
    };

    // Atomic import via mig 206's pip_import RPC. The function takes
    // the validated shape, derives slug from project.name, sets
    // repo_url + workdir_override on the new project, and inserts every
    // component with project_id set. All-or-nothing transaction.
    const { data: rpcResult, error: rpcErr } = await sb.rpc("pip_import", {
      _factory_id:       factoryId,
      _project_meta:     projectMeta,
      _agents:           pip.agents,
      _pipelines:        pip.pipelines,
      _skills:           pip.skills,
      _commands:         pip.commands,
      _hooks:            pip.hooks,
      _output_styles:    pip.output_styles,
      _permission_rules: pip.permission_rules,
    });
    if (rpcErr) {
      return NextResponse.json(
        { error: `Apply failed: ${rpcErr.message}`, code: (rpcErr as { code?: string }).code ?? "apply_error" },
        { status: 500 },
      );
    }
    const report = rpcResult as {
      project_id:   string;
      project_slug: string;
      factory_id:   string;
      tenant_id:    string;
      inserted:     Record<string, number>;
    };

    // Workdir-mode warnings — inform the operator what still needs to
    // happen on their machine. pip_import already persisted the hints
    // (repo_url / workdir_override); we just surface the next-step copy.
    const warnings: string[] = [];
    const workdirSetup = projectMeta.workdir_setup as { kind?: string } | undefined;
    const kind = workdirSetup?.kind;
    if (kind === "clone") {
      warnings.push("clone-mode: the actual git clone happens on the next sprint dispatch.");
    } else if (kind === "init-local") {
      warnings.push("init-local: run `git init` on the operator machine if needed; the next sprint will pick up the workdir.");
    } else if (!kind) {
      warnings.push("workdir_setup absent — the new project has no repo_url / workdir_override hint. Set it in Project Settings before the first sprint.");
    }

    // Discard the temp inception project. Cascades to sprints +
    // agent_runs via FKs. The workdir on disk was already cleaned by
    // run-pipeline's finally block.
    const { error: delErr } = await sb
      .from("projects")
      .delete()
      .eq("id", body.inceptionProjectId);
    if (delErr) {
      warnings.push(`Failed to delete temp inception project: ${delErr.message}`);
    }

    return NextResponse.json({
      projectId:    report.project_id,
      projectSlug:  report.project_slug,
      tenantId:     report.tenant_id,
      factoryId:    report.factory_id,
      inserted:     report.inserted,
      warnings,
    });
  } catch (e) {
    if (e instanceof AuthError)      return errorResponse(e);
    if (e instanceof ForbiddenError) return errorResponse(e);
    if (e instanceof NotFoundError)  return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
