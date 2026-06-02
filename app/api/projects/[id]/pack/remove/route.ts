/**
 * POST /api/projects/[id]/pack/remove
 *
 * Triggers the remove-pack worker task on the operator's local machine
 * (cloud mode is rejected — ephemeral workdirs have nothing to clean
 * up). Auth + factory-membership gates mirror the run-sprint route.
 *
 * The actual deletion runs inside Trigger.dev's worker process so the
 * Vercel function returns immediately. Status flows back via Trigger's
 * run record (frontend can poll if needed; today we just acknowledge).
 *
 * Body: { cliExecutionMode?: 'local' | 'local-git' }  // hint only — worker resolves anyway
 */
import { NextRequest, NextResponse } from "next/server";
import { mintWorkerToken } from "@/lib/worker-jwt";
import { resolveTriggerKey } from "@/lib/trigger-key-resolver";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { ProjectPackRemoveSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

const TRIGGER_API     = "https://api.trigger.dev";
const TRIGGER_TASK_ID = "remove-pack";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = await parseBody(req, ProjectPackRemoveSchema);
    const { user, sb } = await getOperatorUser(req);
    const { id: projectId } = await params;

    // Membership + project resolution — only members of the project's
    // tenant can clean up the pack on their own machine.
    const { data: project } = await sb
      .from("projects")
      .select("factory_id, factories!inner(tenant_id)")
      .eq("id", projectId)
      .maybeSingle();
    if (!project) throw new NotFoundError("Project not found");
    const tenantId = (project.factories as unknown as { tenant_id: string }).tenant_id;
    const factoryId = project.factory_id as string;

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", tenantId).eq("user_id", user.id).maybeSingle();
    if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
      throw new ForbiddenError("Caller is not a member of this project's tenant");
    }

    // Pack removal only applies to local-mode workers. Cloud workdirs
    // are ephemeral; there's nothing on disk to clean up.
    const cliMode = body.cliExecutionMode ?? "local";
    if (cliMode === "cloud") {
      throw new ValidationError("Pack remove is local-only — cloud workdirs are ephemeral.", []);
    }
    const dispatchMode: "local" = "local";

    const triggerKey = await resolveTriggerKey(sb, tenantId, dispatchMode);
    if (!triggerKey) {
      return NextResponse.json({ error: "Worker key not configured for this tenant.", code: "WORKER_KEY_MISSING" }, { status: 503 });
    }

    let supabaseJwt: string;
    let supabaseJwtExpiresAt: number;
    try {
      const minted = mintWorkerToken({ tenantId, factoryId, ttlSeconds: 60 * 60 });
      supabaseJwt = minted.token;
      supabaseJwtExpiresAt = minted.expiresAt;
    } catch (e) {
      return NextResponse.json({
        error: "Worker token mint failed; contact support.",
        detail: (e as Error).message,
      }, { status: 500 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const triggerRes = await fetch(
      `${TRIGGER_API}/api/v1/tasks/${TRIGGER_TASK_ID}/trigger`,
      {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${triggerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: {
            projectId,
            supabaseJwt,
            supabaseJwtExpiresAt,
            ...(supabaseUrl ? { supabaseUrl } : {}),
          },
        }),
      },
    );
    if (!triggerRes.ok) {
      const detail = await triggerRes.text();
      return NextResponse.json({ error: "Trigger.dev rejected", detail }, { status: 502 });
    }
    const triggerBody = (await triggerRes.json()) as { id?: string };
    return NextResponse.json({ ok: true, triggerRunId: triggerBody.id ?? null }, { status: 202 });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
