/**
 * GET  /api/cli/config/[projectId]  — read CLI agents config for a project
 * PUT  /api/cli/config/[projectId]  — save CLI agents config for a project
 *
 * Config is stored inside projects.settings.cli_agents (JSONB — no migration needed).
 * Auth: Bearer {supabase access_token}
 */
import { NextRequest, NextResponse } from "next/server";
import type { CliAgentsConfig } from "@/lib/types";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { CliConfigPutSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/** Verify the user belongs to the project's factory tenant. */
async function verifyAccess(sb: SupabaseClient, userId: string, projectId: string) {
  const { data: project } = await sb
    .from("projects")
    .select("id, settings, factories!inner(tenant_id)")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return null;

  const tenantId = (project.factories as { tenant_id?: string } | null)?.tenant_id;
  if (!tenantId) return null;

  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member) return null;
  return { project, tenantId };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { projectId } = await params;
    const access = await verifyAccess(sb, user.id, projectId);
    if (!access) throw new NotFoundError("Project not found or no access");

    const settings = (access.project.settings ?? {}) as { cli_agents?: CliAgentsConfig };
    return NextResponse.json({ config: settings.cli_agents ?? {} });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const body = await parseBody(req, CliConfigPutSchema);
    const { user, sb } = await getOperatorUser(req);
    const { projectId } = await params;
    const access = await verifyAccess(sb, user.id, projectId);
    if (!access) throw new NotFoundError("Project not found or no access");

    // Merge cli_agents into existing settings (preserve other settings fields).
    const currentSettings = (access.project.settings ?? {}) as Record<string, unknown>;
    const newSettings = { ...currentSettings, cli_agents: body.config };

    const { error } = await sb
      .from("projects")
      .update({ settings: newSettings })
      .eq("id", projectId);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
