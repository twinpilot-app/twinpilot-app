/**
 * POST /api/projects/[id]/prepare-workspace
 *
 * Triggers the `prepare-workspace` task: materialises the agent
 * scaffold (.mcp.json, .tp/mcp-secrets.json, CLAUDE.md, .claude/agents/)
 * at the project's local working dir without dispatching any pipeline.
 *
 * Available for local / local-git mode projects only. Cloud mode has no
 * local dir to materialise into; the UI disables the button there too.
 *
 * Auth: Bearer {supabase access_token}, must be tenant member with
 * owner/admin role (parity with /run dispatch).
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { mintWorkerToken } from "@/lib/worker-jwt";
import { resolveTriggerKey } from "@/lib/trigger-key-resolver";

export const dynamic = "force-dynamic";

const TRIGGER_API = "https://api.trigger.dev";

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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId } = await params;

    // Load project + factory + tenant for membership check + mode resolution
    const { data: project } = await sb
      .from("projects")
      .select("id, name, slug, factory_id, settings, repo_url, working_destination_id, use_operator_git_auth")
      .eq("id", projectId)
      .single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb
      .from("factories").select("tenant_id, slug").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role").eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Mode validation — refuse cloud projects with a clear message
    const settings  = (project.settings ?? {}) as Record<string, unknown>;
    const cliAgents = (settings.cli_agents ?? {}) as Record<string, unknown>;
    const orchMode  = (cliAgents.orchestration_mode as "cloud" | "local" | "local-git" | undefined)
      ?? (cliAgents.execution_backend === "local" ? "local" : "cloud");
    if (orchMode === "cloud") {
      return NextResponse.json(
        { error: "Prepare workspace is only available for local / local-git projects. Cloud projects have no local working tree." },
        { status: 422 },
      );
    }

    // local-git requires a working repo. Two valid shapes (mirrors the
    // /api/projects/[id]/run validation):
    //   1. working_destination_id set (factory destinations dropdown).
    //   2. use_operator_git_auth ON + legacy repo_url set.
    if (orchMode === "local-git") {
      const workingDestId      = (project.working_destination_id as string | null | undefined) ?? null;
      const useOperatorGitAuth = (project.use_operator_git_auth as boolean | undefined) === true;
      const legacyRepoUrl      = (project.repo_url as string | null | undefined)?.trim() || null;
      if (!workingDestId && !(useOperatorGitAuth && legacyRepoUrl)) {
        return NextResponse.json(
          { error: "Local + Git mode requires a working repository. Set it in Project Settings → Orchestration / Storage Mode → Storage Location → Repository before preparing the workspace." },
          { status: 422 },
        );
      }
    }

    // Trigger.dev key resolution + worker JWT — same shape as /run dispatch
    const triggerKey = await resolveTriggerKey(sb, factory.tenant_id as string);
    if (!triggerKey) {
      return NextResponse.json({
        error: "No Trigger.dev key configured for this tenant. Add one in Integrations → Processing.",
      }, { status: 422 });
    }
    const jwt = mintWorkerToken({
      tenantId:  factory.tenant_id as string,
      factoryId: project.factory_id as string,
      ttlSeconds: 60 * 30,
    });

    const triggerRes = await fetch(`${TRIGGER_API}/api/v1/tasks/prepare-workspace/trigger`, {
      method: "POST",
      headers: { Authorization: `Bearer ${triggerKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: {
          projectId,
          supabaseJwt: jwt.token,
          supabaseJwtExpiresAt: jwt.expiresAt,
          ...(process.env.NEXT_PUBLIC_SUPABASE_URL ? { supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL } : {}),
        },
      }),
    });
    if (!triggerRes.ok) {
      const detail = await triggerRes.text().catch(() => "");
      return NextResponse.json({
        error: `Failed to trigger prepare-workspace: ${triggerRes.status} ${detail.slice(0, 200)}`,
      }, { status: 502 });
    }
    const triggerBody = await triggerRes.json() as { id?: string };
    return NextResponse.json({
      ok:        true,
      runId:     triggerBody.id ?? null,
      mode:      orchMode,
      message:   "Workspace preparation dispatched. Watch the run in Trigger.dev or check the project directory shortly.",
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
