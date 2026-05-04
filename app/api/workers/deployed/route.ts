/**
 * POST /api/workers/deployed
 * Auth: Bearer <CLI API key>
 * Body: { env: "prod" | "dev", cliVersion: string }
 *
 * Called by the CLI after `workers deploy` succeeds. Records which
 * CLI version is live on Trigger.dev for this factory/env so the
 * /status page can flag an outdated worker by comparing with the
 * latest CLI version on npm.
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli } from "@/lib/cli-api-auth";

export const dynamic = "force-dynamic";

interface Body {
  env?:        "prod" | "dev";
  cliVersion?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Body;
  if (body.env !== "prod" && body.env !== "dev") {
    return NextResponse.json({ error: "env must be 'prod' or 'dev'" }, { status: 400 });
  }
  if (!body.cliVersion || typeof body.cliVersion !== "string") {
    return NextResponse.json({ error: "cliVersion is required" }, { status: 400 });
  }

  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;

  // Factory-scoped deploys only. A tenant-wide CLI key doesn't know
  // which factory the worker belongs to — the user needs a scoped key.
  if (!auth.factoryId) {
    return NextResponse.json({
      error: "A factory-scoped CLI key is required to record deploys.",
    }, { status: 400 });
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

  if (error) {
    return NextResponse.json({ error: `Failed to record deploy: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
