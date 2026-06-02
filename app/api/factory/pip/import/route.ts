/**
 * POST /api/factory/pip/import
 *
 * Imports a PIP JSON into the target factory, creating a brand-new
 * project + every project-scoped component as DB rows. PIP carries
 * inline components only; references to canonical platform components
 * live as plain agent slugs inside pipeline.steps[].agent and resolve
 * at sprint dispatch via the worker's project > factory > tenant >
 * built-in priority order.
 *
 * All-or-nothing: the entire import runs inside the pip_import SQL
 * function (mig 206). Any error (constraint violation, slug clash,
 * required field missing) raises and the transaction rolls back —
 * no partial project is left behind.
 *
 * Body shape:
 * {
 *   factoryId: string,        // target factory; caller must be member
 *   pip:       Pip            // validated against lib/pip-spec.ts
 * }
 *
 * Auth: getUser + assertMember(platform_admin | admin) on the factory.
 *
 * Response 200: { project_id, project_slug, factory_id, tenant_id, inserted: { ... } }
 * Response 4xx: { error, code?, hint? }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError, PayloadTooLargeError,
  getUser, assertMember,
} from "@/lib/api-helpers";
import { PipSchema, PipWorkdirSetupSchema } from "@/lib/pip-spec";

export const dynamic = "force-dynamic";

/** PIP can run large with inline bodies (multiple long-form skill /
 *  output-style markdown blocks). 5MB cap is generous without exposing
 *  the route to obvious abuse. */
const MAX_PIP_BYTES = 5 * 1024 * 1024;

const ImportRequestSchema = z.object({
  factoryId: z.string().uuid("factoryId must be a UUID"),
  pip:       PipSchema,
}).strict();

interface PipImportReport {
  project_id:    string;
  project_slug:  string;
  factory_id:    string;
  tenant_id:     string;
  inserted: {
    agents:           number;
    pipelines:        number;
    skills:           number;
    commands:         number;
    hooks:            number;
    output_styles:    number;
    permission_rules: number;
  };
}

export async function POST(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);

    // Parse manually — parseBody's cap is 1MB, but PIPs can be larger
    // when inline bodies stack up. Schema-validate before touching DB.
    const raw = await req.text();
    if (raw.length > MAX_PIP_BYTES) {
      throw new PayloadTooLargeError(
        `PIP request body is ${raw.length} bytes; max is ${MAX_PIP_BYTES}.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw);
    } catch (e) {
      throw new ValidationError(`Invalid JSON: ${(e as Error).message}`, []);
    }
    const result = ImportRequestSchema.safeParse(parsed);
    if (!result.success) {
      const details = result.error.issues.map((iss) => ({
        path:    iss.path.map((p) => String(p)),
        message: iss.message,
      }));
      throw new ValidationError("PIP failed schema validation", details);
    }
    const { factoryId, pip } = result.data;

    // Membership gate. Imports are write-heavy → admin-or-above.
    await assertMember(sb, user.id, factoryId, ["platform_admin", "admin"]);

    // Hand off to the all-or-nothing SQL function (mig 206). RLS still
    // applies (SECURITY INVOKER) so the user's JWT scopes the writes.
    //
    // workdir_setup is permissive in PipSchema (z.unknown). Validate it
    // here with the strict discriminated union — it's the only field
    // where we DO need shape-checking on the import path (the apply
    // path overrides from the temp inception's stored value, but
    // imports have no temp).
    let projectMeta: Record<string, unknown> = pip.project as Record<string, unknown>;
    if (projectMeta.workdir_setup !== undefined) {
      const wdParsed = PipWorkdirSetupSchema.safeParse(projectMeta.workdir_setup);
      if (!wdParsed.success) {
        const issue = wdParsed.error.issues[0];
        throw new ValidationError(
          `project.workdir_setup is invalid: ${issue?.path.join(".")} — ${issue?.message}`,
          wdParsed.error.issues.map((i) => ({ path: ["project", "workdir_setup", ...i.path.map(String)], message: i.message })),
        );
      }
      projectMeta = { ...projectMeta, workdir_setup: wdParsed.data };
    }

    const { data, error } = await sb.rpc("pip_import", {
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

    if (error) {
      // Postgres error shapes flow through here verbatim. Common cases:
      //   23505 — slug clash (project / component duplicate)
      //   22023 — required field missing
      const code = (error as { code?: string }).code;
      const status =
        code === "23505" ? 409 :
        code === "22023" ? 400 :
        500;
      return NextResponse.json({
        error: error.message,
        code:  code ?? undefined,
        hint:  status === 409
          ? "A slug already exists in the target scope. Rename in the PIP JSON or remove the duplicate."
          : undefined,
      }, { status });
    }

    return NextResponse.json(data as PipImportReport, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError)             return NextResponse.json({ error: e.message }, { status: 401 });
    if (e instanceof ForbiddenError)        return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof NotFoundError)         return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof PayloadTooLargeError)  return NextResponse.json({ error: e.message }, { status: 413 });
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message, details: e.details }, { status: 400 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
