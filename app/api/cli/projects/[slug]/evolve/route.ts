/**
 * POST /api/cli/projects/[slug]/evolve
 * Body: { type: "fix"|"feature"|"improvement", description: string }
 *
 * Starts a sustentation cycle against an existing (non-running) project,
 * using the shorter evolve pipeline (9 steps). The previous project
 * artifacts are left in place — the pipeline reads them.
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli, requireFactoryId } from "@/lib/cli-api-auth";
import { dispatchSprint } from "@/lib/sprint-dispatcher";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  errorResponse, parseBody,
} from "@/lib/api-helpers";
import { CliProjectEvolveSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

const EVOLVE_PIPELINE = [
  { step: 1,  agent: "product-owner",  gate: null,    phase: 1,  phaseName: "analysis" },
  { step: 2,  agent: "architect",      gate: null,    phase: 1,  phaseName: "analysis" },
  { step: 3,  agent: "spec",           gate: "human", phase: 2,  phaseName: "spec" },
  { step: 4,  agent: "security",       gate: null,    phase: 2,  phaseName: "spec" },
  { step: 5,  agent: "developer",      gate: null,    phase: 3,  phaseName: "build" },
  { step: 6,  agent: "qa",             gate: null,    phase: 3,  phaseName: "build" },
  { step: 7,  agent: "docs",           gate: null,    phase: 3,  phaseName: "build" },
  { step: 8,  agent: "review",         gate: "human", phase: 4,  phaseName: "review" },
  { step: 9,  agent: "devops",         gate: "human", phase: 5,  phaseName: "deploy" },
];

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const body = await parseBody(req, CliProjectEvolveSchema);

    const auth = await authCli(req);
    if (auth instanceof NextResponse) return auth;
    const factory = await requireFactoryId(auth);
    if (factory instanceof NextResponse) return factory;

    const { slug } = await ctx.params;

    const { data: project } = await auth.sb
      .from("projects")
      .select("id, name, status")
      .eq("slug", slug)
      .eq("factory_id", factory.factoryId)
      .maybeSingle();
    if (!project) throw new NotFoundError("Project not found");
    if (project.status === "running") {
      return NextResponse.json({ error: "Project is still running — wait for it to finish", code: "CONFLICT" }, { status: 409 });
    }

    const signal = `# ${body.type.toUpperCase()} REQUEST for "${project.name as string}"

## Type: ${body.type}
## Description: ${body.description}`;

    await auth.sb.from("projects").update({
      status: "queued",
      pipeline: EVOLVE_PIPELINE,
      current_phase: null,
      current_phase_name: null,
    }).eq("id", project.id);

    const dispatch = await dispatchSprint({
      sb: auth.sb,
      projectId: project.id as string,
      factoryId: factory.factoryId,
      tenantId: auth.tenantId,
      projectSlug: slug,
      payload: { signal },
    });

    if (!dispatch.ok) {
      return NextResponse.json(
        { error: `Dispatch failed: ${dispatch.reason}${dispatch.detail ? ` — ${dispatch.detail}` : ""}`, code: "DISPATCH_FAILED" },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, stepCount: EVOLVE_PIPELINE.length, triggerRunId: dispatch.triggerRunId });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
