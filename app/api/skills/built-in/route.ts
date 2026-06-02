/**
 * GET /api/skills/built-in
 *
 * Browse the catalog of TwinPilot-curated skills. Returns all enabled
 * built-in skills, optionally filtered by domain or category. Operators
 * see the catalog in the SkillsSection "Browse Built-In" modal and pick
 * which to install into their factory_skills.
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
  return { sb, user };
}

export async function GET(req: NextRequest) {
  try {
    const { sb } = await assertAuth(req);
    const url = new URL(req.url);
    const domain   = url.searchParams.get("domain");
    const category = url.searchParams.get("category");

    let query = sb.from("built_in_skills")
      .select("id, slug, name, description, category, domain, tags, allowed_tools, source_url, source_attribution, version")
      .eq("enabled", true)
      .order("category", { ascending: true })
      .order("name",     { ascending: true });
    if (domain)   query = query.eq("domain", domain);
    if (category) query = query.eq("category", category);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ skills: data ?? [] });
  } catch (e) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}
