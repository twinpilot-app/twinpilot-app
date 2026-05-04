/**
 * GET /api/projects/[id]/sprints/[sprintId]/files
 *
 * Returns files associated with a sprint for the storage explorer:
 *   - artifacts:  agent_runs.output_ref entries for this sprint's runs
 *   - storage:    file list from Supabase Storage (project prefix)
 *   - git:        repo_url / last_tag from project settings (if available)
 *   - local:      file list from local filesystem (if execution_backend = "local")
 *
 * Auth: Bearer {supabase access_token}
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readdirSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import { TP_BUCKET, sprintPath, localSprintPath, isWithinBase } from "@/lib/paths";

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

/**
 * Recursively list a local directory up to maxDepth.
 * When `includeHidden` is true, dot-prefixed directories are also walked.
 */
function listLocal(
  dir: string,
  rel = "",
  maxDepth = 4,
  includeHidden = false,
): { path: string; size: number }[] {
  if (maxDepth <= 0) return [];
  const result: { path: string; size: number }[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      if (!includeHidden && name.startsWith(".")) continue;
      // Always skip internal metadata dirs even in hidden-included mode
      if (name === ".mcp.json" || name === ".tp") continue;
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) {
        result.push(...listLocal(full, relPath, maxDepth - 1, includeHidden));
      } else {
        result.push({ path: relPath, size: st.size });
      }
    }
  } catch { /* unreadable */ }
  return result;
}

/** Recursively list a Supabase Storage prefix. */
async function listStoragePrefix(
  sb: ReturnType<typeof serviceClient>,
  bucket: string,
  prefix: string,
  rootPrefix?: string,
): Promise<{ path: string; size: number | null }[]> {
  const effectiveRoot = rootPrefix ?? prefix;
  const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 500 });
  if (error || !data) return [];

  const results: { path: string; size: number | null }[] = [];
  for (const item of data) {
    const full = `${prefix}/${item.name}`;
    if (!item.id) {
      // folder — recurse
      results.push(...await listStoragePrefix(sb, bucket, full, effectiveRoot));
    } else {
      // Strip the root prefix to get relative path within sprint
      results.push({ path: full.slice(effectiveRoot.length + 1), size: item.metadata?.size ?? null });
    }
  }
  return results;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sprintId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId, sprintId } = await params;

    // Optional: filter listing to a specific subdirectory within the sprint staging area.
    // e.g. ?subdir=_audit%2Fcarlos-cto  →  only files under sprint-N/_audit/carlos-cto/
    const subdirParam = req.nextUrl.searchParams.get("subdir") ?? "";

    // ── Auth ────────────────────────────────────────────────
    const { data: project } = await sb
      .from("projects")
      .select("slug, factory_id, settings, repo_url")
      .eq("id", projectId)
      .single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb
      .from("factories").select("tenant_id, slug").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Resolve tenant slug
    const { data: tenant } = await sb.from("tenants").select("slug").eq("id", factory.tenant_id).single();

    const projectSlug  = project.slug as string;
    const tenantId     = factory.tenant_id as string;
    const tenantSlug   = tenant?.slug as string;
    const factorySlug  = factory.slug as string;
    const settings     = (project.settings ?? {}) as Record<string, unknown>;
    const cliConfig    = (settings.cli_agents ?? {}) as Record<string, unknown>;

    // ── Sprint + its agent runs ──────────────────────────────
    const { data: sprint } = await sb
      .from("sprints")
      .select("id, sprint_num, status, created_at, completed_at, config")
      .eq("id", sprintId)
      .eq("project_id", projectId)
      .single();
    if (!sprint) return NextResponse.json({ error: "Sprint not found" }, { status: 404 });

    // Resolve localBase: sprint config → project settings → tenant storage integration
    const sprintConfig = (sprint.config ?? {}) as Record<string, unknown>;
    let localBase = sprintConfig.localBasePath as string | undefined
      ?? cliConfig.local_base_path as string | undefined;

    if (!localBase) {
      const { data: storageInts } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", factory.tenant_id)
        .eq("service_id", "storage");
      for (const row of storageInts ?? []) {
        try {
          const cfg = JSON.parse(row.secret_value as string) as { type?: string; basePath?: string };
          if (cfg.type === "local" && cfg.basePath) { localBase = cfg.basePath; break; }
        } catch { /* ignore */ }
      }
    }

    const { data: runs } = await sb
      .from("agent_runs")
      .select("id, agent, step, status, output_ref, cost_usd")
      .eq("sprint_id", sprintId)
      .order("step", { ascending: true });

    const artifacts = (runs ?? [])
      .filter((r) => Boolean(r.output_ref))
      .map((r) => ({
        agent:     r.agent as string,
        step:      r.step as number | null,
        status:    r.status as string,
        outputRef: r.output_ref as string,
        costUsd:   r.cost_usd as number | null,
      }));

    // ── Storage files — respect sprint mode, scope to this sprint only ───
    //
    // Previous logic always started with the local filesystem and, when
    // the sprint's own staging dir was empty, FELL BACK TO LISTING THE
    // WHOLE PROJECT ROOT — which leaked every sprint's files into the
    // modal. It also used the platform's Supabase client to reach a
    // bucket that actually lives on the tenant's Supabase, so cloud
    // sprints never found anything.
    //
    // New logic:
    //   cloud sprint  → only the tenant's bucket
    //   local sprint  → only this sprint's staging dir on disk
    //   mode missing  → try this sprint's local dir, then the tenant
    //                   bucket (legacy sprints)
    let storageFiles: { path: string; size: number | null }[] = [];
    let storageBackend: "supabase" | "local" | "unavailable" = "unavailable";
    let localError: string | null = null;

    const sprintNum = sprint.sprint_num as number;
    const sprintMode = sprintConfig.mode as "cloud" | "local" | undefined;

    /** List this sprint's local staging dir. No fallback to project root. */
    const tryLocal = (): { path: string; size: number | null }[] | null => {
      if (!localBase || !tenantSlug || !factorySlug) return null;
      const stagingBase = localSprintPath(localBase, tenantSlug, factorySlug, projectSlug, sprintNum);
      const targetDir   = subdirParam
        ? join(stagingBase, ...subdirParam.split("/"))
        : stagingBase;
      if (!isWithinBase(resolve(targetDir), localBase) || !existsSync(targetDir)) return null;
      return listLocal(targetDir, "", 6, true).map((f) => ({ path: f.path, size: f.size }));
    };

    /** List this sprint's bucket prefix using the TENANT's Supabase. */
    const tryBucket = async (): Promise<{ path: string; size: number | null }[] | null> => {
      if (!tenantSlug || !factorySlug) return null;
      // Resolve the tenant's Supabase storage credentials. The bucket
      // lives on the tenant's project, not the platform's — using `sb`
      // (platform service role) here would hit a bucket that doesn't
      // exist and Supabase would report "Bucket not found".
      const { data: storageInts } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", factory.tenant_id)
        .eq("service_id", "storage");
      let tenantUrl: string | null = null;
      let tenantKey: string | null = null;
      for (const row of storageInts ?? []) {
        try {
          const cfg = JSON.parse(row.secret_value as string) as { type?: string; url?: string; key?: string };
          if (cfg.type === "supabase" && cfg.url && cfg.key) {
            tenantUrl = cfg.url;
            tenantKey = cfg.key;
            break;
          }
        } catch { /* ignore */ }
      }
      if (!tenantUrl || !tenantKey) return null;
      const tenantSb = createClient(tenantUrl, tenantKey, { auth: { persistSession: false } });
      const basePrefix = sprintPath(tenantSlug, factorySlug, projectSlug, sprintNum);
      const prefix = subdirParam ? `${basePrefix}/${subdirParam}` : basePrefix;
      try {
        const sbFiles = await listStoragePrefix(tenantSb, TP_BUCKET, prefix);
        return sbFiles;
      } catch {
        return null;
      }
    };

    if (sprintMode === "cloud") {
      const remote = await tryBucket();
      if (remote && remote.length > 0) { storageFiles = remote; storageBackend = "supabase"; }
    } else if (sprintMode === "local") {
      const locals = tryLocal();
      if (locals && locals.length > 0) { storageFiles = locals; storageBackend = "local"; }
    } else {
      // Legacy sprints without a mode recorded — try local then bucket.
      const locals = tryLocal();
      if (locals && locals.length > 0) { storageFiles = locals; storageBackend = "local"; }
      if (storageFiles.length === 0) {
        const remote = await tryBucket();
        if (remote && remote.length > 0) { storageFiles = remote; storageBackend = "supabase"; }
      }
    }

    if (storageFiles.length === 0) {
      localError = sprintMode === "cloud"
        ? `No files found in the tenant's bucket for sprint-${sprintNum}. Is cloud storage configured under Integrations → Storage?`
        : sprintMode === "local"
          ? `No files found locally at staging/sprint-${sprintNum}.`
          : `No files found locally at staging/sprint-${sprintNum} or in the tenant's bucket.`;
    }

    // ── Git info ─────────────────────────────────────────────
    const repoUrl = project.repo_url as string | null;
    let gitInfo: { repoUrl: string; tagsUrl: string; commitsUrl: string } | null = null;
    if (repoUrl) {
      const ghMatch = repoUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
      if (ghMatch) {
        const nwo = ghMatch[1];
        gitInfo = {
          repoUrl,
          tagsUrl:    `https://api.github.com/repos/${nwo}/tags`,
          commitsUrl: `https://api.github.com/repos/${nwo}/commits`,
        };
      }
    }

    return NextResponse.json({
      sprintNum:     sprint.sprint_num,
      sprintStatus:  sprint.status,
      artifacts,
      storageBackend,
      storageFiles,
      localError,
      gitInfo,
      subdir:         subdirParam || null,
      localBackend:   storageBackend === "local",
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
