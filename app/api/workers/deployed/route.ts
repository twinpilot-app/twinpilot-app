/**
 * POST /api/workers/deployed
 * Auth: Bearer <CLI API key>
 *
 * Called by the CLI after `workers deploy` succeeds. Records which
 * CLI version is live on Trigger.dev for this factory/env.
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli } from "@/lib/cli-api-auth";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  errorResponse, parseBody,
} from "@/lib/api-helpers";
import { WorkersDeployedSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, WorkersDeployedSchema);
    const auth = await authCli(req);
    if (auth instanceof NextResponse) return auth;

    // Factory-scoped deploys only. A tenant-wide CLI key doesn't know
    // which factory the worker belongs to — the user needs a scoped key.
    if (!auth.factoryId) {
      throw new ValidationError("A factory-scoped CLI key is required to record deploys.", []);
    }

    const { error } = await auth.sb
      .from("worker_deployments")
      .upsert(
        {
          tenant_id:   auth.tenantId,
          factory_id:  auth.factoryId,
          env:         body.env,
          cli_version: body.cliVersion.slice(0, 64),
          deployed_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,factory_id,env" },
      );

    if (error) throw new Error(`Failed to record deploy: ${error.message}`);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
