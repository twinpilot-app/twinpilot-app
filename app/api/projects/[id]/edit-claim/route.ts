/**
 * POST /api/projects/[id]/edit-claim
 *
 * Soft-lock semantics. Claims the editor slot for the calling user so
 * other operators in the same tenant see a "{name} is editing" banner
 * before they accidentally start a parallel sprint.
 *
 * Behaviour:
 *   - free slot (or stale heartbeat) → claim, return holder=self
 *   - already held by SELF           → refresh heartbeat, return holder=self
 *   - held by OTHER, fresh heartbeat → 409, return current holder
 *   - body.force=true                → take over regardless
 *
 * Frontend calls this on project page mount + every 2 min heartbeat.
 *
 * Body: { force?: boolean }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { ProjectEditClaimSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

const STALE_MINUTES = 10;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const body = await parseBody(req, ProjectEditClaimSchema);
    const { user, sb } = await getOperatorUser(req);
    const { id: projectId } = await params;

    const { data: project } = await sb
      .from("projects")
      .select("id, factory_id, editing_user_id, editing_started_at, editing_last_heartbeat")
      .eq("id", projectId)
      .maybeSingle();
    if (!project) throw new NotFoundError("Project not found");

    // Tenant gate — caller must be a member of the project's tenant.
    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", project.factory_id as string).maybeSingle();
    if (!factory) throw new NotFoundError("Factory not found");
    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).maybeSingle();
    if (!member) throw new ForbiddenError("Caller is not a member of this project's tenant");

    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_MINUTES * 60 * 1000);
    const heartbeat = project.editing_last_heartbeat ? new Date(project.editing_last_heartbeat as string) : null;
    const isStale = !heartbeat || heartbeat < staleBefore;
    const currentHolder = project.editing_user_id as string | null;

    // Held by someone else with a fresh heartbeat → 409 unless force.
    if (currentHolder && currentHolder !== user.id && !isStale && !body.force) {
      const { data: holderUser } = await sb.auth.admin.getUserById(currentHolder);
      const holderEmail = holderUser?.user?.email ?? null;
      return NextResponse.json({
        error: "Project is being edited by another operator.",
        code:  "CONFLICT",
        holder: {
          user_id:    currentHolder,
          email:      holderEmail,
          started_at: project.editing_started_at,
          last_seen:  project.editing_last_heartbeat,
        },
      }, { status: 409 });
    }

    // Claim or refresh.
    const isNewClaim = currentHolder !== user.id;
    const { error: upErr } = await sb
      .from("projects")
      .update({
        editing_user_id:        user.id,
        editing_started_at:     isNewClaim ? now.toISOString() : (project.editing_started_at ?? now.toISOString()),
        editing_last_heartbeat: now.toISOString(),
      })
      .eq("id", projectId);
    if (upErr) throw new Error(upErr.message);

    return NextResponse.json({
      ok: true,
      holder: { user_id: user.id, email: user.email, started_at: now.toISOString() },
      took_over: Boolean(body.force) && currentHolder !== null && currentHolder !== user.id,
    });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
