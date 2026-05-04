/**
 * POST /api/skills/built-in/install
 *
 * Install a built-in skill into a factory (factory-default scope) or
 * project (project-specific scope). Copies the catalog row into
 * factory_skills with origin='built-in' and source_url + source_version
 * stamped for traceability. The copy is fully editable from then on.
 *
 * Body: { built_in_skill_id, factory_id, project_id? }
 *
 * Already-installed (slug collision in scope) returns 409 — operator can
 * uninstall first or rename the existing entry. We don't auto-overwrite.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function getUserAndAssertFactoryAccess(req: NextRequest, factoryId: string) {
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
  return { sb, user };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      built_in_skill_id: string;
      factory_id:        string;
      project_id?:       string | null;
    };
    if (!body.built_in_skill_id) return NextResponse.json({ error: "built_in_skill_id required" }, { status: 400 });
    if (!body.factory_id)        return NextResponse.json({ error: "factory_id required" }, { status: 400 });

    const { sb } = await getUserAndAssertFactoryAccess(req, body.factory_id);

    // Pull the catalog row.
    const { data: catalog, error: catErr } = await sb
      .from("built_in_skills")
      .select("slug, name, description, body, category, allowed_tools, source_url, source_attribution, version")
      .eq("id", body.built_in_skill_id)
      .maybeSingle();
    if (catErr) return NextResponse.json({ error: catErr.message }, { status: 500 });
    if (!catalog) return NextResponse.json({ error: "Built-in skill not found" }, { status: 404 });

    // Slug collision check within scope.
    const scopeFilter = body.project_id
      ? sb.from("factory_skills")
          .select("id, name", { count: "exact" })
          .eq("factory_id", body.factory_id)
          .eq("project_id", body.project_id)
          .eq("slug", catalog.slug as string)
      : sb.from("factory_skills")
          .select("id, name", { count: "exact" })
          .eq("factory_id", body.factory_id)
          .is("project_id", null)
          .eq("slug", catalog.slug as string);
    const { data: existing } = await scopeFilter;
    if (existing && existing.length > 0) {
      return NextResponse.json({
        error: `A skill with slug "${catalog.slug}" already exists in this scope. Uninstall or rename first.`,
        existing_id: existing[0].id,
      }, { status: 409 });
    }

    const { data: inserted, error: insErr } = await sb
      .from("factory_skills")
      .insert({
        factory_id:        body.factory_id,
        project_id:        body.project_id ?? null,
        slug:              catalog.slug,
        name:              catalog.name,
        description:       catalog.description,
        body:              catalog.body,
        category:          catalog.category,
        allowed_tools:     catalog.allowed_tools ?? [],
        origin:            "built-in",
        source_url:        catalog.source_url,
        source_version:    catalog.version,
      })
      .select("*")
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, skill: inserted }, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
