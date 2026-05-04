/**
 * GET /api/admin/deployment-status
 *
 * Returns:
 *   - Vercel: config status + latest production deployment info
 *   - Worker image: config status + latest GHCR image info
 *
 * Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAdminConfigs, maskSecret } from "@/lib/admin-config";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") throw new Error("Forbidden");
}

export async function GET(req: NextRequest) {
  try {
    await assertAdmin(req);

    const cfg = await getAdminConfigs([
      "VERCEL_TOKEN",
      "VERCEL_PROJECT_ID",
      "VERCEL_TEAM_ID",
      "VERCEL_DEPLOY_HOOK_URL",
      "GITHUB_ADMIN_TOKEN",
    ]);

    const { VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID, VERCEL_DEPLOY_HOOK_URL, GITHUB_ADMIN_TOKEN } = cfg;

    // ── Vercel config status ───────────────────────────────────────────────────
    const vercelEnv = [
      { var: "VERCEL_TOKEN",           label: "API token",              set: !!VERCEL_TOKEN,           preview: maskSecret(VERCEL_TOKEN) },
      { var: "VERCEL_PROJECT_ID",      label: "Project ID",             set: !!VERCEL_PROJECT_ID,      preview: VERCEL_PROJECT_ID },
      { var: "VERCEL_TEAM_ID",         label: "Team ID (optional)",     set: !!VERCEL_TEAM_ID,         preview: VERCEL_TEAM_ID },
      { var: "VERCEL_DEPLOY_HOOK_URL", label: "Deploy hook (optional)", set: !!VERCEL_DEPLOY_HOOK_URL, preview: VERCEL_DEPLOY_HOOK_URL ? "configured" : undefined },
    ];

    // ── Vercel latest deployment ───────────────────────────────────────────────
    let deployment: {
      url: string; state: string; createdAt: string;
      commitSha: string | undefined; commitMessage: string | undefined; branch: string | undefined;
    } | null = null;

    if (VERCEL_TOKEN && VERCEL_PROJECT_ID) {
      try {
        const params = new URLSearchParams({ projectId: VERCEL_PROJECT_ID, limit: "1", target: "production" });
        if (VERCEL_TEAM_ID) params.set("teamId", VERCEL_TEAM_ID);

        const res = await fetch(`https://api.vercel.com/v6/deployments?${params}`, {
          headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
          next: { revalidate: 0 },
        });

        if (res.ok) {
          const data = await res.json() as {
            deployments: Array<{
              url: string; state: string; createdAt: number;
              meta: Record<string, string>;
            }>;
          };
          const d = data.deployments?.[0];
          if (d) {
            deployment = {
              url:           `https://${d.url}`,
              state:         d.state,
              createdAt:     new Date(d.createdAt).toISOString(),
              commitSha:     d.meta?.githubCommitSha?.slice(0, 7),
              commitMessage: d.meta?.githubCommitMessage,
              branch:        d.meta?.githubCommitRef,
            };
          }
        }
      } catch { /* non-fatal */ }
    }

    // ── Worker image (GHCR) ───────────────────────────────────────────────────
    const workerEnv = [
      { var: "GITHUB_ADMIN_TOKEN", label: "GitHub PAT (packages:read + workflow)", set: !!GITHUB_ADMIN_TOKEN, preview: maskSecret(GITHUB_ADMIN_TOKEN) },
    ];

    let workerImage: { tags: string[]; createdAt: string } | null = null;

    if (GITHUB_ADMIN_TOKEN) {
      try {
        const res = await fetch(
          "https://api.github.com/orgs/tirsasoftware/packages/container/tirsa-factory-worker/versions?per_page=1",
          { headers: { Authorization: `Bearer ${GITHUB_ADMIN_TOKEN}`, Accept: "application/vnd.github+json" } },
        );
        if (res.ok) {
          const data = await res.json() as Array<{
            created_at: string;
            metadata: { container: { tags: string[] } };
          }>;
          if (data.length > 0) {
            workerImage = {
              tags:      data[0].metadata?.container?.tags ?? [],
              createdAt: data[0].created_at,
            };
          }
        }
      } catch { /* non-fatal */ }
    }

    return NextResponse.json({
      vercel: {
        env: vercelEnv,
        deployment,
        deployHookSet: !!VERCEL_DEPLOY_HOOK_URL,
      },
      worker: {
        env: workerEnv,
        image: workerImage,
        packageUrl: "https://github.com/tirsasoftware/tirsa-factory/pkgs/container/tirsa-factory-worker",
      },
    });

  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized" || msg === "Forbidden")
      return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
