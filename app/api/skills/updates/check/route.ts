/**
 * POST /api/skills/updates/check
 *
 * Checks every installed skill in the given scope for an upstream
 * update. Custom skills are excluded (no upstream); built-in /
 * github-import / marketplace each have their own check logic in
 * lib/skills-updates.ts.
 *
 * GitHub-import checks each cost one GitHub API call. The check is
 * user-initiated (button click), so we accept the cost and parallelise
 * up to 4 at a time to avoid hammering the API.
 *
 * Body: { factory_id, project_id? }
 * Returns: { results: UpdateCheckResult[] }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkSkillUpdate, FactorySkillRow } from "@/lib/skills-updates";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertFactoryAccess(req: NextRequest, factoryId: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: factory } = await sb
    .from("factories").select("tenant_id").eq("id", factoryId).maybeSingle();
  if (!factory) throw new Error("NotFound");
  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).maybeSingle();
  if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
    throw new Error("Forbidden");
  }
  return sb;
}

async function mapInBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { factory_id?: string; project_id?: string | null };
    if (!body.factory_id) return NextResponse.json({ error: "factory_id required" }, { status: 400 });

    const sb = await assertFactoryAccess(req, body.factory_id);

    let query = sb
      .from("factory_skills")
      .select("id, factory_id, project_id, slug, name, origin, source_url, source_version, source_commit_sha, body, category, description, updated_at, created_at")
      .eq("factory_id", body.factory_id)
      .neq("origin", "custom");
    if (body.project_id) query = query.eq("project_id", body.project_id);
    else                 query = query.is("project_id", null);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const skills = (data ?? []) as FactorySkillRow[];

    // Parallelise checks (especially for github-import which does network
    // calls) but cap to 4 to avoid GitHub rate-limit surprises.
    const results = await mapInBatches(skills, 4, (s) => checkSkillUpdate(sb, s));

    return NextResponse.json({ results });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
