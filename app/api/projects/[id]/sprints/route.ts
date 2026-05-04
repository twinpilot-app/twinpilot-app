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

async function getUser(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { user, sb };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId } = await params;

    const { data: project } = await sb
      .from("projects")
      .select("factory_id")
      .eq("id", projectId)
      .single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb
      .from("factories").select("tenant_id").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data: sprints } = await sb
      .from("sprints")
      .select("id, sprint_num, status, created_at, completed_at, briefing, sprint_completed_saved, config")
      .eq("project_id", projectId)
      .order("sprint_num", { ascending: false });

    return NextResponse.json({ sprints: sprints ?? [] });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
