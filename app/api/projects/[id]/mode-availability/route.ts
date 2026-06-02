/**
 * GET /api/projects/[id]/mode-availability
 *
 * Resolves whether each orchestration mode (cloud / local / local-git) can
 * run for this project, given the tenant's configured storage and
 * destinations. The Project Settings and Start Sprint modals call this to
 * disable buttons for unavailable modes; the /run route re-evaluates server
 * side so the gating can't be bypassed via direct API call.
 *
 * Auth: Bearer {supabase access_token}
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { evaluateModeAvailability } from "@/lib/mode-availability";

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

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { sb } = await getUser(req);
    const { id: projectId } = await params;

    const { data: project, error } = await sb
      .from("projects")
      .select("settings, factory_id, factories!inner(id, tenant_id)")
      .eq("id", projectId)
      .single();
    if (error || !project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const factories = project.factories as unknown as { id: string; tenant_id: string };
    const projCli   = ((project.settings as { cli_agents?: { local_base_path?: string } } | null)?.cli_agents) ?? {};

    const availability = await evaluateModeAvailability({
      sb,
      tenantId:    factories.tenant_id,
      factoryId:   factories.id,
      projectPath: projCli.local_base_path,
    });

    return NextResponse.json(availability);
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
