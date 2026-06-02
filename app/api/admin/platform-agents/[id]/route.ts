/**
 * PATCH /api/admin/platform-agents/[id] — update persona / enable flag /
 * platform_hook on a Platform Agent (mig 190).
 *
 * Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getOperatorUser, parseBody, errorResponse, ForbiddenError, NotFoundError } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const PlatformAgentPatchSchema = z.object({
  /** Toggle enable/disable. Disabled agents fall back to the
   *  deterministic heuristic at every dispatch site — kill switch. */
  enabled:       z.boolean().optional(),
  /** Update the platform_hook slug. Rare — typically set once. */
  platform_hook: z.string().min(1).max(100).optional(),
  /** Update persona text. Replaces spec.description. */
  description:   z.string().min(1).max(32_768).optional(),
  /** Update budget knobs nested under spec. */
  max_turns:         z.number().int().min(1).max(10).optional(),
  max_output_tokens: z.number().int().min(1).max(4_096).optional(),
  /** Bump the version string when shipping a persona update. */
  version:       z.string().min(1).max(32).optional(),
}).strict();

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") {
      throw new ForbiddenError("Platform admin role required");
    }
    const { id } = await params;
    const body = await parseBody(req, PlatformAgentPatchSchema);

    const { data: existing } = await sb
      .from("agent_definitions")
      .select("id, spec, is_platform")
      .eq("id", id)
      .maybeSingle();
    if (!existing || !existing.is_platform) {
      throw new NotFoundError("Platform agent not found");
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    let spec = (existing.spec ?? {}) as Record<string, unknown>;
    let specChanged = false;

    if (body.description !== undefined) {
      spec = { ...spec, description: body.description };
      specChanged = true;
    }
    if (body.max_turns !== undefined) {
      spec = { ...spec, max_turns: body.max_turns };
      specChanged = true;
    }
    if (body.max_output_tokens !== undefined) {
      spec = { ...spec, max_output_tokens: body.max_output_tokens };
      specChanged = true;
    }
    if (specChanged) update.spec = spec;
    if (body.enabled       !== undefined) update.enabled       = body.enabled;
    if (body.platform_hook !== undefined) update.platform_hook = body.platform_hook;
    if (body.version       !== undefined) update.version       = body.version;

    const { data, error } = await sb
      .from("agent_definitions")
      .update(update)
      .eq("id", id)
      .select("id, slug, name, version, enabled, platform_hook, spec, metadata, updated_at")
      .single();
    if (error) throw new Error(error.message);

    return NextResponse.json({ agent: data });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
