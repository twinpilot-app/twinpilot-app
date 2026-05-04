/**
 * POST /api/skills/updates/apply
 *
 * Re-fetches the upstream skill and overwrites the installed copy's
 * body + provenance. The operator's local edits to the body are lost
 * — the UI is expected to warn before calling. Local UX choices
 * (enabled flag, disable_model_invocation, model_override) are
 * preserved.
 *
 * Body: { skill_id }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { applySkillUpdate, FactorySkillRow } from "@/lib/skills-updates";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const sb = serviceClient();
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json() as { skill_id?: string };
    if (!body.skill_id) return NextResponse.json({ error: "skill_id required" }, { status: 400 });

    const { data: skill } = await sb
      .from("factory_skills")
      .select("id, factory_id, project_id, slug, name, origin, source_url, source_version, source_commit_sha, body, category, description, updated_at, created_at")
      .eq("id", body.skill_id)
      .maybeSingle();
    if (!skill) return NextResponse.json({ error: "Skill not found" }, { status: 404 });

    // Authorise via factory→tenant→member chain, same as other skill writes.
    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", skill.factory_id as string).maybeSingle();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });
    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).maybeSingle();
    if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    try {
      const result = await applySkillUpdate(sb, skill as FactorySkillRow);
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
