/**
 * POST /api/commands/github-import
 *
 * Persist a GitHub-imported slash command into factory_slash_commands
 * with origin='github-import' and full provenance (source_url,
 * source_commit_sha, source_version=ref). Mirrors the skill import
 * shape — the body is re-fetched server-side so a tampered client
 * payload can't smuggle alternative content.
 *
 * Body: { url, factory_id, project_id?, slug, name, description }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchCommandFromGitHub } from "@/lib/github-command-import";
import { GitHubImportError } from "@/lib/github-skill-import";

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

type Body = {
  url:          string;
  factory_id:   string;
  project_id?:  string | null;
  slug:         string;
  name:         string;
  description?: string;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Body;
    if (!body.url)        return NextResponse.json({ error: "url required" },        { status: 400 });
    if (!body.factory_id) return NextResponse.json({ error: "factory_id required" }, { status: 400 });
    if (!body.slug)       return NextResponse.json({ error: "slug required" },       { status: 400 });
    if (!body.name)       return NextResponse.json({ error: "name required" },       { status: 400 });

    const { sb } = await getUserAndAssertFactoryAccess(req, body.factory_id);

    const fetched = await fetchCommandFromGitHub(body.url);

    // Slug collision check within scope.
    const scopeFilter = body.project_id
      ? sb.from("factory_slash_commands")
          .select("id, name")
          .eq("factory_id", body.factory_id)
          .eq("project_id", body.project_id)
          .eq("slug", body.slug)
      : sb.from("factory_slash_commands")
          .select("id, name")
          .eq("factory_id", body.factory_id)
          .is("project_id", null)
          .eq("slug", body.slug);
    const { data: existing } = await scopeFilter;
    if (existing && existing.length > 0) {
      return NextResponse.json({
        error: `A slash command with slug "${body.slug}" already exists in this scope. Pick a different slug or delete first.`,
        existing_id: existing[0].id,
      }, { status: 409 });
    }

    const { data: inserted, error: insErr } = await sb
      .from("factory_slash_commands")
      .insert({
        factory_id:        body.factory_id,
        project_id:        body.project_id ?? null,
        slug:              body.slug,
        name:              body.name,
        description:       body.description ?? "",
        body:              fetched.body,
        origin:            "github-import",
        source_url:        fetched.htmlUrl,
        source_commit_sha: fetched.sha,
        source_version:    fetched.ref.ref,
      })
      .select("*")
      .single();
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({ ok: true, command: inserted }, { status: 201 });
  } catch (e) {
    if (e instanceof GitHubImportError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
