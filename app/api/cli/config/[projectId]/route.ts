/**
 * GET  /api/cli/config/[projectId]  — read CLI agents config for a project
 * PUT  /api/cli/config/[projectId]  — save CLI agents config for a project
 *
 * Config is stored inside projects.settings.cli_agents (JSONB — no migration needed).
 * Auth: Bearer {supabase access_token}
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { CliAgentsConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function getUser(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { user, sb };
}

/** Verify the user belongs to the project's factory tenant */
async function verifyAccess(sb: ReturnType<typeof serviceClient>, userId: string, projectId: string) {
  const { data: project } = await sb
    .from("projects")
    .select("id, settings, factories!inner(tenant_id)")
    .eq("id", projectId)
    .single();

  if (!project) return null;

  const tenantId = (project.factories as { tenant_id?: string } | null)?.tenant_id;
  if (!tenantId) return null;

  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .single();

  if (!member) return null;
  return { project, tenantId };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { projectId } = await params;
    const access = await verifyAccess(sb, user.id, projectId);
    if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const settings = (access.project.settings ?? {}) as { cli_agents?: CliAgentsConfig };
    return NextResponse.json({ config: settings.cli_agents ?? {} });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { projectId } = await params;
    const access = await verifyAccess(sb, user.id, projectId);
    if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json() as { config: CliAgentsConfig };
    if (!body.config || typeof body.config !== "object") {
      return NextResponse.json({ error: "config object required" }, { status: 400 });
    }

    // Merge cli_agents into existing settings (preserve other settings fields)
    const currentSettings = (access.project.settings ?? {}) as Record<string, unknown>;
    const newSettings = { ...currentSettings, cli_agents: body.config };

    const { error } = await sb
      .from("projects")
      .update({ settings: newSettings })
      .eq("id", projectId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
