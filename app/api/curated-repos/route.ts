/**
 * GET /api/curated-repos?kind={agents|skills|commands|hooks}
 *
 * Returns the platform-curated repo catalogue (migration 178). When
 * `kind` is supplied, filters to repos whose `paths` map declares a
 * subdirectory for that kind — exactly the set the Studio dropdown
 * needs for that section.
 *
 * Auth: any authenticated user. Writes go through the admin route.
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

async function assertAuth(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return sb;
}

export async function GET(req: NextRequest) {
  try {
    const sb = await assertAuth(req);
    const kind = req.nextUrl.searchParams.get("kind");

    const { data, error } = await sb
      .from("curated_repos")
      .select("id, slug, name, description, repo_owner, repo_name, default_branch, paths, homepage_url")
      .eq("enabled", true)
      .order("name");
    if (error) throw new Error(error.message);

    const filtered = kind
      ? (data ?? []).filter((r) => {
          const paths = r.paths as Record<string, string> | null;
          return paths && typeof paths[kind] === "string" && paths[kind].length > 0;
        })
      : (data ?? []);

    return NextResponse.json({ repos: filtered });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
