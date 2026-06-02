/**
 * GET /api/factory/pip/inception/pip-json?inceptionId=...
 *
 * Reads sprints.outcome.pip_json for the inception project's latest
 * sprint that has one stashed. Used by PIP Manager > Browse for the
 * Download / Preview affordances on a pending inception.
 *
 * Returns the JSON content (Content-Type: application/json) with a
 * Content-Disposition that suggests a download filename.
 *
 * Auth: getUser + assertMember(platform_admin | admin) on factory.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getUser, assertMember, errorResponse,
} from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const inceptionId = new URL(req.url).searchParams.get("inceptionId");
    if (!inceptionId) {
      return NextResponse.json(
        { error: "inceptionId query param is required", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }

    const { sb, user } = await getUser(req);

    const { data: inception } = await sb
      .from("projects")
      .select("id, slug, factory_id, settings")
      .eq("id", inceptionId)
      .maybeSingle();
    if (!inception) throw new NotFoundError("Inception project not found");
    const settings = (inception.settings ?? {}) as Record<string, unknown>;
    if (settings.kind !== "pip-inception") {
      throw new ValidationError("Project is not a PIP inception", []);
    }
    await assertMember(sb, user.id, inception.factory_id as string, [
      "platform_admin", "admin",
    ]);

    const { data: sprints } = await sb
      .from("sprints")
      .select("sprint_num, outcome")
      .eq("project_id", inceptionId)
      .order("sprint_num", { ascending: false })
      .limit(5);
    const sprintWithPip = (sprints ?? []).find(
      (s) => s.outcome && (s.outcome as Record<string, unknown>).pip_json,
    );
    if (!sprintWithPip) {
      throw new NotFoundError(
        "No pip.json stashed in any sprint outcome yet. The pip-composer step must complete first.",
      );
    }
    const pip = (sprintWithPip.outcome as Record<string, unknown>).pip_json;

    return new NextResponse(JSON.stringify(pip, null, 2), {
      status: 200,
      headers: {
        "Content-Type":        "application/json; charset=utf-8",
        "Content-Disposition": `inline; filename="${(inception.slug as string) || "pip"}.pip.json"`,
        "Cache-Control":       "no-store",
      },
    });
  } catch (e) {
    if (e instanceof AuthError)      return errorResponse(e);
    if (e instanceof ForbiddenError) return errorResponse(e);
    if (e instanceof NotFoundError)  return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
