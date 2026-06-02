/**
 * GET /api/admin/platform-agents — list all Platform Agents (mig 190).
 * Returns rows where is_platform=true with usage stats.
 *
 * Admin-only — gated on app_metadata.role === 'admin'.
 */
import { NextRequest, NextResponse } from "next/server";
import { getOperatorUser, errorResponse, ForbiddenError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { user, sb } = await getOperatorUser(req);
    if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") {
      throw new ForbiddenError("Platform admin role required");
    }

    const { data: agents, error } = await sb
      .from("agent_definitions")
      .select("id, slug, name, version, enabled, platform_hook, spec, metadata, updated_at, created_at")
      .eq("is_platform", true)
      .order("platform_hook", { ascending: true });
    if (error) throw new Error(error.message);

    return NextResponse.json({ agents: agents ?? [] });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
