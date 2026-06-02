/**
 * GET /api/projects/[id]/pip/export
 *
 * Reads a project's row + every project-scoped component and emits a
 * PIP JSON validated against pip-spec.ts. Round-trips through
 * /api/factory/pip/import to recreate the project elsewhere.
 *
 * Export scope:
 *   - Project meta: name, briefing (intake_brief), prd_md,
 *     workdir_setup (derived from repo_url + workdir_override).
 *   - Components: only project-scoped customs (project_id = this).
 *     Factory-default and built-in canonicals are NOT inlined nor
 *     emitted as refs — they're expected to exist in the importing
 *     factory's tenant via canonical fallback.
 *
 * Auth: getUser + assertMember on the project's factory. Allow all
 * three roles (platform_admin, admin, member) — export is read-only.
 *
 * Response: PIP JSON with Content-Disposition for download.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError,
  getUser, assertMember,
} from "@/lib/api-helpers";
import {
  PIP_SCHEMA_VERSION, type Pip,
  type PipAgent, type PipPipeline, type PipPipelineStep,
  type PipSkill, type PipCommand,
  type PipHook, type PipOutputStyle, type PipPermissionRule,
  type PipWorkdirSetup,
} from "@/lib/pip-spec";
import { brand } from "@/lib/brand";

export const dynamic = "force-dynamic";

interface DbProject {
  id:                string;
  slug:              string;
  name:              string;
  factory_id:        string;
  intake_brief:      string | null;
  prd_md:            string | null;
  repo_url:          string | null;
  workdir_override:  string | null;
}

/** Derive a workdir_setup directive from the project row. The PIP
 *  spec collapsed to a single Local source (mig 210) — the only
 *  required field is `local_path`. Operators clone externally if they
 *  need a remote; the worker auto-inits .git on the new project's
 *  first sprint. When workdir_override is absent we emit a placeholder
 *  the operator must edit before re-import. */
function deriveWorkdirSetup(repoUrl: string | null, workdirOverride: string | null): PipWorkdirSetup {
  return {
    local_path: workdirOverride ?? "/path/to/repo",
    ...(repoUrl ? { remote_url: repoUrl } : {}),
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId } = await params;

    const { data: projectRow } = await sb
      .from("projects")
      .select("id, slug, name, factory_id, intake_brief, prd_md, repo_url, workdir_override")
      .eq("id", projectId)
      .maybeSingle();
    if (!projectRow) throw new NotFoundError("Project not found");
    const project = projectRow as unknown as DbProject;

    await assertMember(sb, user.id, project.factory_id, ["platform_admin", "admin", "member"]);

    /* ─────────── Project-scoped components ─────────── */

    // Agents — extract description + tools from spec jsonb.
    const { data: agentRows } = await sb
      .from("agent_definitions")
      .select("slug, name, spec")
      .eq("project_id", projectId)
      .order("slug");
    const agents: PipAgent[] = (agentRows ?? []).map((r) => {
      const spec = (r.spec ?? {}) as Record<string, unknown>;
      return {
        slug:        r.slug as string,
        name:        r.name as string,
        description: typeof spec.description === "string" ? spec.description : "",
        tools:       Array.isArray(spec.tools) ? (spec.tools as string[]) : [],
      };
    });

    // Pipelines.
    const { data: pipelineRows } = await sb
      .from("pipelines")
      .select("slug, name, intent, steps")
      .eq("project_id", projectId)
      .order("slug");
    const pipelines: PipPipeline[] = (pipelineRows ?? []).map((r) => {
      const rawSteps = (r.steps as Array<Record<string, unknown>> | null) ?? [];
      const steps: PipPipelineStep[] = rawSteps
        .filter((s) => typeof s.agent === "string")
        .map((s) => ({
          agent: s.agent as string,
          ...(typeof s.phase === "number" ? { phase: s.phase } : {}),
          ...(s.gate === "human" ? { gate: "human" as const } : {}),
        }));
      return {
        slug:   r.slug   as string,
        name:   r.name   as string,
        intent: (r.intent as PipPipeline["intent"]) ?? "execution",
        steps,
      };
    });

    // Skills.
    const { data: skillRows } = await sb
      .from("factory_skills")
      .select("slug, name, description, body, category, allowed_tools")
      .eq("project_id", projectId)
      .order("slug");
    const skills: PipSkill[] = (skillRows ?? []).map((r) => ({
      slug:          r.slug          as string,
      name:          r.name          as string,
      description:   (r.description  as string | null) ?? "",
      body:          (r.body         as string | null) ?? "",
      category:      r.category      as PipSkill["category"],
      allowed_tools: Array.isArray(r.allowed_tools) ? (r.allowed_tools as string[]) : [],
    }));

    // Commands.
    const { data: cmdRows } = await sb
      .from("factory_slash_commands")
      .select("slug, name, description, body")
      .eq("project_id", projectId)
      .order("slug");
    const commands: PipCommand[] = (cmdRows ?? []).map((r) => ({
      slug:        r.slug        as string,
      name:        r.name        as string,
      description: (r.description as string | null) ?? "",
      body:        (r.body        as string | null) ?? "",
    }));

    // Hooks.
    const { data: hookRows } = await sb
      .from("factory_hooks")
      .select("slug, name, event, matcher, command")
      .eq("project_id", projectId)
      .order("slug");
    const hooks: PipHook[] = (hookRows ?? []).map((r) => ({
      slug:    r.slug    as string,
      name:    (r.name   as string | null) ?? null,
      event:   r.event   as PipHook["event"],
      matcher: (r.matcher as string | null) ?? "",
      command: r.command as string,
    }));

    // Output styles.
    const { data: outRows } = await sb
      .from("factory_output_styles")
      .select("slug, name, body, is_active")
      .eq("project_id", projectId)
      .order("slug");
    const output_styles: PipOutputStyle[] = (outRows ?? []).map((r) => ({
      slug:      r.slug      as string,
      name:      r.name      as string,
      body:      (r.body     as string | null) ?? "",
      is_active: r.is_active === true,
    }));

    // Permission rules.
    const { data: permRows } = await sb
      .from("factory_permission_rules")
      .select("decision, pattern")
      .eq("project_id", projectId)
      .order("decision")
      .order("pattern");
    const permission_rules: PipPermissionRule[] = (permRows ?? []).map((r) => ({
      decision: r.decision as PipPermissionRule["decision"],
      pattern:  r.pattern  as string,
    }));

    const pip: Pip = {
      schema_version: PIP_SCHEMA_VERSION,
      generated: {
        by:  `${brand.shortName} command-center`,
        via: "manual-export",
        at:  new Date().toISOString(),
      },
      project: {
        name:          project.name,
        briefing:      project.intake_brief ?? "",
        prd_md:        project.prd_md       ?? "",
        workdir_setup: deriveWorkdirSetup(project.repo_url, project.workdir_override),
      },
      agents,
      pipelines,
      skills,
      commands,
      hooks,
      output_styles,
      permission_rules,
    };

    const filename = `${project.slug}.pip.json`;
    return new NextResponse(JSON.stringify(pip, null, 2), {
      status: 200,
      headers: {
        "Content-Type":        "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control":       "no-store",
      },
    });
  } catch (e) {
    if (e instanceof AuthError)      return NextResponse.json({ error: e.message }, { status: 401 });
    if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof NotFoundError)  return NextResponse.json({ error: e.message }, { status: 404 });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
