/**
 * POST /api/cli/projects/[slug]/stop
 * Pauses a running project by setting status="paused". The current step
 * runs to completion; no more are dispatched.
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli, requireFactoryId } from "@/lib/cli-api-auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
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

  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (project.status !== "running") {
    return NextResponse.json({ error: `Project is not running (status: ${project.status})` }, { status: 409 });
  }

  // Operator stop: pause the active sprint (the worker exits on the
  // next step boundary), then settle the project to idle so the slot
  // is released for the next dispatch.
  await auth.sb.from("sprints")
    .update({ status: "paused" })
    .eq("project_id", project.id)
    .in("status", ["running", "queued", "waiting"]);
  await auth.sb.from("projects").update({ status: "idle" }).eq("id", project.id);
  return NextResponse.json({ ok: true, name: project.name });
}
