/**
 * GET /api/projects/[id]/blueprint
 *
 * Returns the effective Project Blueprint for a project — either the operator-
 * configured value at projects.settings.blueprint or the default catalog
 * blueprint when no override is stored. Validation failures fall back to the
 * default; the response includes a `valid` flag so the Studio editor (later)
 * can warn the operator that their stored value didn't parse.
 *
 * Phase A.5 read-only foundation. PUT (operator-edit) lands in a follow-up
 * once the Studio editor is wired up.
 *
 * Auth: Bearer {supabase access_token}
 */
import { NextRequest, NextResponse } from "next/server";
import { getUser, errorResponse, NotFoundError, ForbiddenError } from "@/lib/api-helpers";
import {
  DEFAULT_PROJECT_BLUEPRINT,
  ProjectBlueprintSchema,
  getProjectBlueprint,
} from "@/lib/project-blueprint";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, sb } = await getUser(req);
    const { id } = await params;

    const { data: project } = await sb
      .from("projects")
      .select("id, factory_id, settings, factories!inner(tenant_id)")
      .eq("id", id)
      .single();
    if (!project) throw new NotFoundError("Project not found");

    const tenantId = (project.factories as unknown as { tenant_id?: string } | null)?.tenant_id;
    if (!tenantId) throw new NotFoundError("Project tenant not resolvable");

    // Membership check — any tenant member can read the blueprint;
    // editing (when PUT lands) will require platform_admin/admin.
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .single();
    if (!member) throw new ForbiddenError(`Caller lacks membership on tenant ${tenantId}`);

    const stored = (project.settings as Record<string, unknown> | null)?.blueprint;
    const validParse = stored ? ProjectBlueprintSchema.safeParse(stored) : null;
    const effective = getProjectBlueprint(project as { settings?: unknown });
    const isDefault = !stored || (validParse !== null && !validParse.success);

    return NextResponse.json({
      blueprint: effective,
      default: DEFAULT_PROJECT_BLUEPRINT,
      stored:   stored ?? null,
      // `valid` is null when nothing is stored, true when stored parses
      // cleanly, false when stored failed parse and we fell back. The
      // editor will surface the parse error to the operator.
      valid:    stored == null ? null : validParse?.success ?? false,
      is_default: isDefault,
    });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
