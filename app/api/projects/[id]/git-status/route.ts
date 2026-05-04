/**
 * GET /api/projects/[id]/git-status
 *
 * Checks whether the GitHub repo for this project already exists,
 * without creating it. Used by the UI to show a "repo detected" banner.
 *
 * Returns:
 *   { repoName, repoUrl, exists: true,  cloneUrl }  — repo found
 *   { repoName, repoUrl, exists: false }             — repo not found
 *   { repoName, repoUrl, exists: null  }             — GitHub not configured
 *
 * Auth: Bearer {supabase access_token}
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

    // Auth: verify user is a tenant member
    const { data: project } = await sb
      .from("projects")
      .select("slug, factory_id, repo_url, factories!inner(slug, tenant_id)")
      .eq("id", projectId)
      .single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const factory    = project.factories as unknown as { slug: string; tenant_id: string } | null;
    const tenantId   = factory?.tenant_id;
    const factorySlug = factory?.slug ?? "";

    if (tenantId) {
      const { data: member } = await sb
        .from("tenant_members").select("role")
        .eq("tenant_id", tenantId).eq("user_id", user.id).single();
      if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const projectSlug = project.slug as string;
    const repoName    = `${factorySlug}-${projectSlug}`;
    const repoUrl     = project.repo_url as string | null;

    // If repo_url already persisted → repo exists
    if (repoUrl) {
      return NextResponse.json({ repoName, repoUrl, exists: true, cloneUrl: repoUrl });
    }

    // Look up GitHub credentials from tenant_integrations
    if (!tenantId) return NextResponse.json({ repoName, repoUrl: null, exists: null });

    const { data: integrations } = await sb
      .from("tenant_integrations")
      .select("var_name, secret_value")
      .eq("tenant_id", tenantId)
      .in("var_name", ["GITHUB_TOKEN", "GITHUB_OWNER"]);

    const creds: Record<string, string> = {};
    for (const row of integrations ?? []) {
      creds[row.var_name as string] = row.secret_value as string;
    }

    const token  = creds["GITHUB_TOKEN"];
    const owner  = creds["GITHUB_OWNER"]?.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");

    if (!token || !owner) {
      return NextResponse.json({ repoName, repoUrl: null, exists: null }); // GitHub not configured
    }

    // Check GitHub API
    const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
    });

    if (ghRes.ok) {
      const data = await ghRes.json() as { html_url: string; clone_url: string };
      return NextResponse.json({ repoName, repoUrl: data.html_url, exists: true, cloneUrl: data.clone_url });
    }

    if (ghRes.status === 404) {
      return NextResponse.json({ repoName, repoUrl: null, exists: false });
    }

    // Other error (bad token, rate limit, etc.)
    return NextResponse.json({ repoName, repoUrl: null, exists: null });

  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
