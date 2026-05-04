/**
 * POST /api/projects/[id]/sprints/[sprintId]/save
 *
 * Resolves a sprint that is in "pending_save" status.
 *
 * Body: { action: "github" | "download" | "discard" }
 *
 * - github:   Commits sprint artifacts to GitHub via the REST API.
 *             Commit: "feat: add sprint-<n>", tag: "sprint-<n>", branch: main.
 *             Reads from local filesystem (TwinPilotProjects/.../staging/sprint-<n>/) or Supabase bucket.
 * - download: Fetches all staged files from Supabase storage, returns a zip as application/zip.
 * - discard:  Deletes staging artifacts (local dir or Supabase objects) and closes the sprint.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { brand } from "@/lib/brand";
import { deflateRawSync } from "node:zlib";
import { readdirSync, statSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { TP_BUCKET, sprintPath, localSprintPath, isWithinBase } from "@/lib/paths";
import { getAdminConfig } from "@/lib/admin-config";
import { resolveTriggerKey } from "@/lib/trigger-key-resolver";
import { mintWorkerToken } from "@/lib/worker-jwt";

export const dynamic = "force-dynamic";

const GH_API = "https://api.github.com";
const TRIGGER_API = "https://api.trigger.dev";

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

// ─── Minimal ZIP writer (no external deps) ────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files: { name: string; content: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const central: Buffer[]    = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes  = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.content, { level: 6 });
    const crc        = crc32(file.content);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);  local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(file.content.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);

    localParts.push(local, compressed);
    central.push(cd);
    offset += local.length + compressed.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd  = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

// ─── Local filesystem helpers ─────────────────────────────────────────────────

/** Recursively read all files under dir; returns relative paths + content. */
function readDirRecursive(dir: string, rel = ""): { path: string; content: string }[] {
  const result: { path: string; content: string }[] = [];
  if (!existsSync(dir)) return result;
  for (const name of readdirSync(dir)) {
    // Skip hidden directories and most dot-files, but allow .gitignore
    if (name === "node_modules") continue;
    if (name.startsWith(".") && name !== ".gitignore") continue;
    const full    = join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) {
      result.push(...readDirRecursive(full, relPath));
    } else {
      try { result.push({ path: relPath, content: readFileSync(full, "utf-8") }); } catch { /* skip binary */ }
    }
  }
  return result;
}

// ─── Supabase storage helpers ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function listStorageAll(client: any, bucket: string, prefix: string): Promise<string[]> {
  const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !data) return [];
  const paths: string[] = [];
  for (const item of data) {
    const full = `${prefix}/${item.name}`;
    if (!item.id) paths.push(...await listStorageAll(client, bucket, full));
    else paths.push(full);
  }
  return paths;
}

// ─── GitHub REST API helpers ──────────────────────────────────────────────────

async function ghFetch(
  path: string,
  token: string,
  opts?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${GH_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tirsa-factory",
      "Content-Type": "application/json",
      ...(opts?.headers ?? {}),
    },
  });
  let data: unknown;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function githubPushSprint(opts: {
  token: string;
  owner: string;
  repo: string;
  sprintNum: number;
  branch: string;
  files: { path: string; content: string }[];
}): Promise<void> {
  const { token, owner, repo, sprintNum, branch, files } = opts;
  const sprintLabel = `sprint-${sprintNum}`;

  if (files.length === 0) throw new Error("No files to commit.");

  // Get current HEAD of the target branch (may not exist for a fresh repo)
  const refResult = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);

  let baseCommitSha: string | null = null;
  let baseTreeSha:   string | null = null;

  if (refResult.ok) {
    baseCommitSha = (refResult.data as { object: { sha: string } }).object.sha;
    const commitResult = await ghFetch(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`, token);
    if (!commitResult.ok) throw new Error(`Could not fetch base commit: ${JSON.stringify(commitResult.data)}`);
    baseTreeSha = (commitResult.data as { tree: { sha: string } }).tree.sha;
  } else if (refResult.status !== 404) {
    throw new Error(`Could not get ${branch} branch: ${JSON.stringify(refResult.data)}`);
  }
  // status 404 → repo is empty or branch doesn't exist yet → first commit

  // Create blobs
  const treeItems: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const file of files) {
    // encode content as base64 to safely handle any text encoding
    const b64 = Buffer.from(file.content, "utf-8").toString("base64");
    const blobResult = await ghFetch(`/repos/${owner}/${repo}/git/blobs`, token, {
      method: "POST",
      body: JSON.stringify({ content: b64, encoding: "base64" }),
    });
    if (!blobResult.ok) throw new Error(`Failed to create blob for ${file.path}: ${JSON.stringify(blobResult.data)}`);
    treeItems.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha:  (blobResult.data as { sha: string }).sha,
    });
  }

  // Create tree
  const treeBody: Record<string, unknown> = { tree: treeItems };
  if (baseTreeSha) treeBody.base_tree = baseTreeSha;

  const treeResult = await ghFetch(`/repos/${owner}/${repo}/git/trees`, token, {
    method: "POST",
    body: JSON.stringify(treeBody),
  });
  if (!treeResult.ok) throw new Error(`Failed to create tree: ${JSON.stringify(treeResult.data)}`);
  const newTreeSha = (treeResult.data as { sha: string }).sha;

  // Create commit
  const commitBody: Record<string, unknown> = {
    message: `feat: add ${sprintLabel}`,
    tree:    newTreeSha,
    ...(baseCommitSha ? { parents: [baseCommitSha] } : { parents: [] }),
  };
  const newCommitResult = await ghFetch(`/repos/${owner}/${repo}/git/commits`, token, {
    method: "POST",
    body: JSON.stringify(commitBody),
  });
  if (!newCommitResult.ok) throw new Error(`Failed to create commit: ${JSON.stringify(newCommitResult.data)}`);
  const newCommitSha = (newCommitResult.data as { sha: string }).sha;

  // Update (or create) branch ref
  if (baseCommitSha) {
    const patchResult = await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommitSha }),
    });
    if (!patchResult.ok) throw new Error(`Failed to update ${branch}: ${JSON.stringify(patchResult.data)}`);
  } else {
    const createResult = await ghFetch(`/repos/${owner}/${repo}/git/refs`, token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommitSha }),
    });
    if (!createResult.ok) throw new Error(`Failed to create ${branch} ref: ${JSON.stringify(createResult.data)}`);
  }

  // Create tag (best-effort — ignore if it already exists)
  await ghFetch(`/repos/${owner}/${repo}/git/refs`, token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/tags/${sprintLabel}`, sha: newCommitSha }),
  });
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sprintId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId, sprintId } = await params;
    const body = await req.json() as {
      action: "export" | "discard" | "close" | "github" | "download" | "save";
      targets?: string[];
      /** Optional filter for action="export" + targets:["github"] —
       *  limits the push to a subset of the project's configured
       *  output_destinations. Each element is a destination id
       *  ("global" or a factory_output_destinations.id). */
      destinations?: string[];
    };

    const validActions = ["export", "discard", "close", "github", "download", "save"];
    if (!validActions.includes(body.action)) {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    // ── Load project + verify membership ──────────────────────────────────────
    const { data: project } = await sb
      .from("projects")
      .select("id, name, slug, factory_id, pipeline, settings, repo_url")
      .eq("id", projectId)
      .single();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: factory } = await sb
      .from("factories").select("tenant_id, slug").eq("id", project.factory_id).single();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", factory.tenant_id).eq("user_id", user.id).single();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Resolve tenant slug
    const { data: tenant } = await sb.from("tenants").select("slug").eq("id", factory.tenant_id).single();
    const tenantSlug  = tenant?.slug as string;
    const factorySlug = factory.slug as string;

    // ── Load sprint ───────────────────────────────────────────────────────────
    const { data: sprint } = await sb
      .from("sprints")
      .select("id, sprint_num, status, sprint_completed_saved, config")
      .eq("id", sprintId)
      .eq("project_id", projectId)
      .single();
    if (!sprint) return NextResponse.json({ error: "Sprint not found" }, { status: 404 });
    if (sprint.status !== "pending_save" && sprint.sprint_completed_saved !== false) {
      return NextResponse.json({ error: "Sprint is not pending save" }, { status: 409 });
    }

    const projectSlug      = project.slug as string;
    const sprintNum        = sprint.sprint_num as number;
    const sprintConfig     = (sprint.config ?? {}) as Record<string, unknown>;
    const settings         = (project.settings ?? {}) as Record<string, unknown>;
    const storageName      = settings.storage_backend_name as string | undefined;
    const cliAgents        = (settings.cli_agents ?? {}) as Record<string, unknown>;
    const sprintMode       = sprintConfig.mode as string | undefined;
    const storageType      = sprintMode === "local" ? "local"
      : (cliAgents.execution_backend as "supabase" | "local" | undefined) ?? "supabase";
    const orchestrationMode = (cliAgents.orchestration_mode as "cloud" | "local" | "local-git" | undefined)
      ?? (storageType === "local" ? "local" : "cloud");
    const isLocalGit = orchestrationMode === "local-git";
    const localBaseFromCli = cliAgents.local_base_path as string | undefined;
    const githubBranch     = (settings.github_branch as string | undefined) ?? "main";

    // ── Resolve local backend config ─────────────────────────────────────────
    // Priority: sprint config → project settings → tenant storage integrations
    let localBasePath: string | null = sprintConfig.localBasePath as string | null ?? null;
    let supabaseUrl:   string | null = null;
    let supabaseKey:   string | null = null;

    if (!localBasePath && localBaseFromCli) localBasePath = localBaseFromCli;

    if (storageName) {
      const { data: integration } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", factory.tenant_id)
        .eq("service_id", "storage")
        .eq("var_name", storageName)
        .single();

      if (integration?.secret_value) {
        try {
          const cfg = JSON.parse(integration.secret_value as string) as {
            type: string; basePath?: string; url?: string; key?: string;
          };
          if (cfg.type === "local" && !localBasePath) localBasePath = cfg.basePath ?? null;
          if (cfg.type === "supabase") { supabaseUrl = cfg.url ?? null; supabaseKey = cfg.key ?? null; }
        } catch { /* use defaults */ }
      }
    }

    // Fallback: scan all storage integrations for local type
    if (!localBasePath) {
      const { data: storageInts } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", factory.tenant_id)
        .eq("service_id", "storage");
      for (const row of storageInts ?? []) {
        try {
          const cfg = JSON.parse(row.secret_value as string) as { type?: string; basePath?: string };
          if (cfg.type === "local" && cfg.basePath) { localBasePath = cfg.basePath; break; }
        } catch { /* ignore */ }
      }
    }

    function getStagingDir(): string | null {
      if (!localBasePath || !tenantSlug || !factorySlug) return null;
      const dir = localSprintPath(localBasePath, tenantSlug, factorySlug, projectSlug, sprintNum);
      if (!isWithinBase(resolve(dir), localBasePath)) return null;
      return dir;
    }

    /**
     * Resolve the tenant's Supabase storage credentials on demand.
     *
     * In-scope `supabaseUrl`/`supabaseKey` are only set when the project
     * has a `storage_backend_name` matching an integrations row. When
     * the project doesn't explicitly name a backend (common), fall
     * back to scanning tenant_integrations for the first supabase-type
     * storage entry. Previously the code fell back to the *platform*
     * client + TP_BUCKET, but that bucket lives on the tenant project
     * — so cloud sprints never saw their own artifacts.
     *
     * Mutates the outer supabaseUrl/supabaseKey so callers can keep
     * testing truthiness. Returns the pair for convenience.
     */
    // Captured here so the closure doesn't have to re-narrow the factory
    // non-null check TypeScript already did at the top of the handler.
    const factoryTenantId = factory.tenant_id as string;
    async function ensureTenantSupabase(): Promise<{ url: string | null; key: string | null }> {
      if (supabaseUrl && supabaseKey) return { url: supabaseUrl, key: supabaseKey };
      const { data: storageInts } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", factoryTenantId)
        .eq("service_id", "storage");
      for (const row of storageInts ?? []) {
        try {
          const cfg = JSON.parse(row.secret_value as string) as { type?: string; url?: string; key?: string };
          if (cfg.type === "supabase" && cfg.url && cfg.key) {
            supabaseUrl = cfg.url;
            supabaseKey = cfg.key;
            return { url: supabaseUrl, key: supabaseKey };
          }
        } catch { /* ignore */ }
      }
      return { url: null, key: null };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GITHUB — commit sprint artifacts to every selected destination
    // ─────────────────────────────────────────────────────────────────────────
    if (body.action === "github") {
      // Local + Git short-circuit: in this mode the worker has already
      // committed + tagged + pushed at sprint end (commitAndTagSprint
      // pushes origin/<branch> and origin/sprint-N). This endpoint runs
      // on Vercel and has no access to the operator's filesystem, so it
      // can't read the working tree to push elsewhere. Acknowledge the
      // close so the dashboard transitions out of pending_save instead
      // of looping on "Auto-push failed: Staging directory not found".
      //
      // Output destinations to OTHER repos in local-git mode are TODO:
      // they need to ride on the worker (which has the working tree)
      // rather than on this Vercel function. Tracked in
      // docs/STORAGE-LAYOUT.md.
      if (isLocalGit) {
        await sb.from("sprints")
          .update({ status: "completed", sprint_completed_saved: true, completed_at: new Date().toISOString(), needs_human: false })
          .eq("id", sprintId);
        await sb.from("projects").update({ status: "idle" }).eq("id", projectId);
        return NextResponse.json({
          ok: true,
          action: "github",
          mode: "local-git",
          note: "Working repo already committed + pushed by the worker at sprint end.",
        });
      }
      // Feature gate: when admin_config.PUSH_VIA_TRIGGER === "true", offload
      // the push to the worker's push-sprint task. The caller gets 202 and
      // can poll sprint.status for completion; the Vercel function returns
      // immediately so hobby-plan timeouts don't matter.
      const pushViaTrigger = (await getAdminConfig("PUSH_VIA_TRIGGER"))?.toLowerCase() === "true";
      if (pushViaTrigger) {
        const triggerKey = await resolveTriggerKey(sb, factory.tenant_id as string);
        if (!triggerKey) {
          return NextResponse.json({
            error: "PUSH_VIA_TRIGGER is enabled but this tenant has no Trigger.dev key. Configure one under Integrations → Processing or disable PUSH_VIA_TRIGGER.",
          }, { status: 422 });
        }
        try {
          const jwt = mintWorkerToken({
            tenantId:  factory.tenant_id as string,
            factoryId: project.factory_id as string,
            ttlSeconds: 60 * 60,
          });
          const requestedDests = Array.isArray(body.destinations) ? body.destinations : undefined;
          const triggerRes = await fetch(`${TRIGGER_API}/api/v1/tasks/push-sprint/trigger`, {
            method: "POST",
            headers: { Authorization: `Bearer ${triggerKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              payload: {
                projectId,
                sprintId,
                ...(requestedDests ? { destinations: requestedDests } : {}),
                supabaseJwt: jwt.token,
                supabaseJwtExpiresAt: jwt.expiresAt,
                ...(process.env.NEXT_PUBLIC_SUPABASE_URL ? { supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL } : {}),
              },
            }),
          });
          if (!triggerRes.ok) {
            const detail = await triggerRes.text().catch(() => "");
            return NextResponse.json({
              error: `Could not enqueue push-sprint: ${triggerRes.status} ${detail.slice(0, 200)}`,
            }, { status: 502 });
          }
          const runBody = await triggerRes.json() as { id?: string };
          return NextResponse.json({
            ok: true,
            action: "github",
            queued: true,
            triggerRunId: runBody.id ?? null,
          }, { status: 202 });
        } catch (e) {
          return NextResponse.json({
            error: `Failed to enqueue push-sprint: ${(e as Error).message}`,
          }, { status: 500 });
        }
      }

      // Inline path (default) — runs in this Vercel function.
      // Per-destination shape: settings.destinations: Array<{id, auto_push}>.
      // For inline export we honour the body's destinations filter (manual
      // export from the UI) when provided; otherwise we push to all
      // saved destinations regardless of auto_push (operator clicked
      // Export = explicit intent, push everything they configured).
      const savedDests = Array.isArray(settings.destinations)
        ? settings.destinations as Array<{ id: string; auto_push?: boolean }>
        : [];
      const savedIds = savedDests.map((d) => d.id);
      const effectiveIds = body.destinations && body.destinations.length > 0
        ? body.destinations.filter((id: string) => savedIds.includes(id))
        : savedIds;

      if (effectiveIds.length === 0) {
        return NextResponse.json({
          error: "No output destinations selected for this project. Pick at least one under Project Settings → Output Destinations.",
        }, { status: 422 });
      }

      // Pre-fetch credential sources for both kinds of destination.
      const { data: integrations } = await sb
        .from("tenant_integrations")
        .select("var_name, secret_value")
        .eq("tenant_id", factory.tenant_id);
      const envVars: Record<string, string> = {};
      for (const row of integrations ?? []) {
        if (row.var_name && row.secret_value) envVars[row.var_name as string] = row.secret_value as string;
      }

      const factoryDestIds = effectiveIds.filter((id) => id !== "global");
      let factoryDests: { id: string; name: string; owner: string; token: string; branch: string | null }[] = [];
      if (factoryDestIds.length > 0) {
        const { data: rows } = await sb
          .from("factory_output_destinations")
          .select("id, name, owner, token, branch")
          .in("id", factoryDestIds)
          .eq("tenant_id", factory.tenant_id);
        factoryDests = (rows ?? []) as typeof factoryDests;
      }

      // Build the resolved list in request order.
      interface ResolvedDest {
        id:     string;    // "global" or factory destination id
        label:  string;    // for logs/errors
        owner:  string;
        token:  string;
        branch: string;    // effective branch
      }
      const branchDefault = (settings.output_branch as string | undefined)
        ?? (settings.github_branch as string | undefined) ?? "main";

      const resolved: ResolvedDest[] = [];
      const missing: string[] = [];
      for (const id of effectiveIds) {
        if (id === "global") {
          const token = envVars["GITHUB_TOKEN"];
          const owner = envVars["GITHUB_OWNER"];
          if (!token || !owner) { missing.push("global (Integrations → Storage)"); continue; }
          resolved.push({ id: "global", label: "global", owner, token, branch: branchDefault });
        } else {
          const d = factoryDests.find((x) => x.id === id);
          if (!d) { missing.push(`factory destination ${id}`); continue; }
          resolved.push({ id: d.id, label: d.name, owner: d.owner, token: d.token, branch: d.branch ?? branchDefault });
        }
      }

      if (resolved.length === 0) {
        return NextResponse.json({
          error: `None of the selected output destinations could be resolved. Missing: ${missing.join(", ")}`,
        }, { status: 422 });
      }

      // Per-destination: ensure the repo exists, then prepare for push
      // below. The factory slug + project slug produce a predictable
      // name so the same sprint reaches the same repo across reruns.
      const factorySlugValue = (factory.slug as string) ?? "tirsa";
      const repoName = `${factorySlugValue}-${projectSlug}`;

      interface ReadyDest extends ResolvedDest { repoUrl: string; }
      const ready: ReadyDest[] = [];
      for (const d of resolved) {
        const headers = { Authorization: `token ${d.token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" };
        const checkRes = await fetch(`https://api.github.com/repos/${d.owner}/${repoName}`, { headers });
        let repoUrl: string | null = null;
        if (checkRes.ok) {
          const checkData = await checkRes.json() as { html_url: string };
          repoUrl = checkData.html_url;
        } else {
          const ownerRes = await fetch(`https://api.github.com/users/${d.owner}`, { headers });
          const ownerData = await ownerRes.json() as { type?: string };
          const isOrg = ownerData.type === "Organization";
          const createUrl = isOrg
            ? `https://api.github.com/orgs/${d.owner}/repos`
            : "https://api.github.com/user/repos";
          const createRes = await fetch(createUrl, {
            method: "POST", headers,
            body: JSON.stringify({
              name: repoName,
              description: `${project.name as string ?? projectSlug} — managed by ${brand.name}`,
              private: true,
              auto_init: true,
            }),
          });
          if (createRes.ok || createRes.status === 201) {
            const createData = await createRes.json() as { html_url: string };
            repoUrl = createData.html_url;
          } else {
            const err = await createRes.text().catch(() => "");
            return NextResponse.json({
              error: `Failed to create repo ${d.owner}/${repoName} for destination "${d.label}": ${err}`,
            }, { status: 422 });
          }
        }
        if (!repoUrl) {
          return NextResponse.json({
            error: `Could not resolve repo for destination "${d.label}".`,
          }, { status: 422 });
        }
        ready.push({ ...d, repoUrl });
      }

      // Persist the FIRST destination's repo URL on the project so the
      // existing UI repo:<url> preview keeps working. Later iterations
      // can surface a per-destination map.
      if (!project.repo_url) {
        await sb.from("projects").update({ repo_url: ready[0]!.repoUrl }).eq("id", projectId);
      }

      // `owner`/`repo`/`repoUrl` locals are kept so the downstream code
      // that collects files + pushes can stay structurally unchanged.
      const primary = ready[0]!;
      const owner = primary.owner;
      const repo  = repoName;
      const repoUrl = primary.repoUrl;
      void repoUrl;
      const githubToken = primary.token;
      void githubToken;

      // Collect files
      let files: { path: string; content: string }[] = [];

      if (storageType === "local") {
        const stagingDir = getStagingDir();
        if (!stagingDir) {
          return NextResponse.json({
            error: "Staging directory not found. Check your local storage configuration.",
          }, { status: 404 });
        }
        files = readDirRecursive(stagingDir);
      } else {
        // Supabase storage — always the tenant's project (where the
        // bucket actually lives). Resolve credentials on demand if the
        // project doesn't explicitly name a storage backend.
        const { url, key } = await ensureTenantSupabase();
        if (!url || !key) {
          return NextResponse.json({
            error: "Cloud sprint has no tenant Supabase configured. Set a Supabase storage backend in Integrations → Storage.",
          }, { status: 422 });
        }
        const storageClient = createClient(url, key, { auth: { persistSession: false } });
        const bucket = TP_BUCKET;
        const prefix = (tenantSlug && factorySlug) ? sprintPath(tenantSlug, factorySlug, projectSlug, sprintNum) : `${projectSlug}/sprint-${sprintNum}`;

        const storagePaths = await listStorageAll(storageClient, bucket, prefix);
        for (const p of storagePaths) {
          const { data } = await storageClient.storage.from(bucket).download(p);
          if (data) files.push({ path: p.slice(prefix.length + 1), content: await data.text() });
        }
      }

      if (files.length === 0) {
        return NextResponse.json({ error: "No files found to commit." }, { status: 404 });
      }

      // Auto-inject README.md and .gitignore if not present in staging
      const sprintLabel = `sprint-${sprintNum}`;
      if (!files.some((f) => f.path === "README.md")) {
        const agentList = [...new Set(
          files
            .map((f) => f.path.split("/")[1])
            .filter((s): s is string => Boolean(s) && s !== "summary.md"),
        )].join(", ");
        files.push({
          path: "README.md",
          content: `# ${project.name as string} — ${sprintLabel}\n\n` +
            `Sprint generated by [${brand.name}](${brand.urls.website}).\n\n` +
            `## Agents\n\n${agentList || "(none)"}\n\n` +
            `## Structure\n\n` +
            `- \`_audit/\` — per-agent summaries\n` +
            `- \`_docs/\` — documents and specifications\n` +
            `- \`_workspace/\` — implementation artifacts\n`,
        });
      }
      if (!files.some((f) => f.path === ".gitignore")) {
        files.push({
          path: ".gitignore",
          content: `staging/\n.tp/\n.claude/\n.mcp.json\nCLAUDE.md\nnode_modules/\n`,
        });
      }

      // Push to every resolved destination. One failure fails the whole
      // action (so the sprint isn't marked "saved" when it only partially
      // landed). Collect per-destination outcomes for the response so the
      // caller can see where each push went.
      const pushResults: { id: string; label: string; owner: string; repoUrl: string; ok: true }[] = [];
      for (const d of ready) {
        await githubPushSprint({
          token: d.token, owner: d.owner, repo, sprintNum,
          branch: d.branch, files,
        });
        pushResults.push({ id: d.id, label: d.label, owner: d.owner, repoUrl: d.repoUrl, ok: true });
      }

      await sb.from("sprints")
        .update({ status: "completed", sprint_completed_saved: true, completed_at: new Date().toISOString(), needs_human: false })
        .eq("id", sprintId);
      await sb.from("projects").update({ status: "idle" }).eq("id", projectId);

      try {
        const { createNotification } = await import("@/lib/notifications");
        const destLabels = pushResults.map((r) => r.label).join(", ");
        await createNotification({
          tenantId: factory.tenant_id as string,
          eventType: "sprint_completed",
          severity: "info",
          title: `Sprint completed — ${project.name as string}`,
          body: pushResults.length === 1
            ? `Pushed to GitHub (${destLabels})`
            : `Pushed to GitHub (${pushResults.length} destinations: ${destLabels})`,
          metadata: { projectId, sprintId, destinations: pushResults.map((r) => ({ id: r.id, label: r.label, repoUrl: r.repoUrl })) },
        });
      } catch { /* non-blocking */ }
      return NextResponse.json({ ok: true, action: "github", destinations: pushResults });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DISCARD — delete staging artifacts, close sprint
    // ─────────────────────────────────────────────────────────────────────────
    if (body.action === "discard") {
      if (storageType === "local") {
        const stagingDir = getStagingDir();
        if (stagingDir) try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
      } else {
        // Supabase: delete sprint objects from bucket
        try {
          const storageClient = (supabaseUrl && supabaseKey)
            ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
            : createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
          const bucket = (supabaseUrl && supabaseKey) ? "staging" : TP_BUCKET;
          const prefix = (tenantSlug && factorySlug) ? sprintPath(tenantSlug, factorySlug, projectSlug, sprintNum) : `${projectSlug}/sprint-${sprintNum}`;

          const storagePaths = await listStorageAll(storageClient, bucket, prefix);
          if (storagePaths.length > 0) {
            await storageClient.storage.from(bucket).remove(storagePaths);
          }
        } catch { /* non-fatal */ }
      }

      await sb.from("sprints")
        .update({ status: "completed", sprint_completed_saved: false, completed_at: new Date().toISOString(), needs_human: false })
        .eq("id", sprintId);
      await sb.from("projects").update({ status: "idle" }).eq("id", projectId);
      try { const { createNotification } = await import("@/lib/notifications"); await createNotification({ tenantId: factory.tenant_id as string, eventType: "sprint_completed", severity: "info", title: `Sprint completed — ${project.name as string}`, body: "Discarded", metadata: { projectId, sprintId } }); } catch { /* non-blocking */ }
      return NextResponse.json({ ok: true, action: "discard" });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DOWNLOAD — zip files from Supabase storage
    // ─────────────────────────────────────────────────────────────────────────
    if (body.action === "download") {
      const storageClient = (supabaseUrl && supabaseKey)
        ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
        : createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
      const bucket = (supabaseUrl && supabaseKey) ? "staging" : TP_BUCKET;
      const prefix = (tenantSlug && factorySlug) ? sprintPath(tenantSlug, factorySlug, projectSlug, sprintNum) : `${projectSlug}/sprint-${sprintNum}`;

      const storagePaths = await listStorageAll(storageClient, bucket, prefix);
      const zipFiles: { name: string; content: Buffer }[] = [];

      for (const p of storagePaths) {
        const { data } = await storageClient.storage.from(bucket).download(p);
        if (!data) continue;
        const relPath = p.slice(prefix.length + 1);
        zipFiles.push({ name: relPath, content: Buffer.from(await data.arrayBuffer()) });
      }

      if (zipFiles.length === 0) {
        return NextResponse.json({ error: "No files found in staging storage for this sprint." }, { status: 404 });
      }

      const zipBuffer = makeZip(zipFiles);

      await sb.from("sprints")
        .update({ status: "completed", sprint_completed_saved: true, completed_at: new Date().toISOString(), needs_human: false })
        .eq("id", sprintId);
      await sb.from("projects").update({ status: "idle" }).eq("id", projectId);

      const filename = `${projectSlug}-sprint-${sprintNum}.zip`;
      return new NextResponse(new Uint8Array(zipBuffer), {
        status: 200,
        headers: {
          "Content-Type":        "application/zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length":      String(zipBuffer.length),
        },
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SAVE / CLOSE — keep artifacts in bucket, just close the sprint
    // ─────────────────────────────────────────────────────────────────────────
    if (body.action === "save" || body.action === "close") {
      await sb.from("sprints")
        .update({ status: "completed", sprint_completed_saved: true, completed_at: new Date().toISOString(), needs_human: false })
        .eq("id", sprintId);
      await sb.from("projects").update({ status: "idle" }).eq("id", projectId);
      try { const { createNotification } = await import("@/lib/notifications"); await createNotification({ tenantId: factory.tenant_id as string, eventType: "sprint_completed", severity: "info", title: `Sprint completed — ${project.name as string}`, body: "Closed", metadata: { projectId, sprintId } }); } catch { /* non-blocking */ }
      return NextResponse.json({ ok: true, action: body.action });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXPORT — execute multiple targets, then close sprint
    // ─────────────────────────────────────────────────────────────────────────
    if (body.action === "export") {
      const targets = body.targets ?? [];
      if (targets.length === 0) {
        return NextResponse.json({ error: "No export targets specified" }, { status: 400 });
      }

      const results: { target: string; ok: boolean; error?: string }[] = [];

      // ── Collect files (local filesystem or bucket) ─────────────────────
      let files: { path: string; content: string }[] = [];

      const stagingDir = getStagingDir();
      if (storageType === "local" && stagingDir && existsSync(stagingDir)) {
        // Local mode — read from filesystem
        files = readDirRecursive(stagingDir);
      } else {
        // Cloud mode — read from the tenant's Supabase bucket (same
        // resolution path as the single-action github flow above).
        const { url, key } = await ensureTenantSupabase();
        if (!url || !key) {
          results.push({
            target: "github",
            ok: false,
            error: "Cloud sprint has no tenant Supabase configured. Set a Supabase storage backend in Integrations → Storage.",
          });
          // Fall through with empty files so "download" target still
          // returns an empty archive gracefully (handled by its own
          // empty-zip logic below).
        } else {
          const storageClient = createClient(url, key, { auth: { persistSession: false } });
          const bucket = TP_BUCKET;
          const prefix = (tenantSlug && factorySlug) ? sprintPath(tenantSlug, factorySlug, projectSlug, sprintNum) : `${projectSlug}/sprint-${sprintNum}`;

          const storagePaths = await listStorageAll(storageClient, bucket, prefix);
          for (const p of storagePaths) {
            const { data } = await storageClient.storage.from(bucket).download(p);
            if (data) files.push({ path: p.slice(prefix.length + 1), content: await data.text() });
          }
        }
      }

      // ── GitHub target ──────────────────────────────────────────────────
      if (targets.includes("github")) {
        try {
          // Resolve destinations:
          //   1. If the caller passed an explicit `destinations` array in
          //      the body (Export modal with per-destination checkboxes),
          //      honour it — but only allow ids that the project itself
          //      has selected, so export can't silently push to a dest
          //      the user never configured on this project.
          //   2. Otherwise push to ALL the project's saved destinations
          //      (manual export = explicit operator intent).
          const savedDests = Array.isArray(settings.destinations)
            ? settings.destinations as Array<{ id: string; auto_push?: boolean }>
            : [];
          const savedIds = savedDests.map((d) => d.id);
          const requestedDests = Array.isArray(body.destinations) ? body.destinations : undefined;
          const effectiveIds = requestedDests
            ? requestedDests.filter((id) => savedIds.includes(id))
            : savedIds;

          if (effectiveIds.length === 0) {
            results.push({ target: "github", ok: false, error: "No output destinations selected." });
          } else {
            const { data: integrations } = await sb
              .from("tenant_integrations")
              .select("var_name, secret_value")
              .eq("tenant_id", factory.tenant_id);
            const envVars: Record<string, string> = {};
            for (const row of integrations ?? []) {
              if (row.var_name && row.secret_value) envVars[row.var_name as string] = row.secret_value as string;
            }
            const factoryDestIds = effectiveIds.filter((id) => id !== "global");
            let factoryDests: { id: string; name: string; owner: string; token: string; branch: string | null }[] = [];
            if (factoryDestIds.length > 0) {
              const { data: rows } = await sb
                .from("factory_output_destinations")
                .select("id, name, owner, token, branch")
                .in("id", factoryDestIds)
                .eq("tenant_id", factory.tenant_id);
              factoryDests = (rows ?? []) as typeof factoryDests;
            }

            const branchDefault = (settings.output_branch as string | undefined)
              ?? (settings.github_branch as string | undefined) ?? "main";
            const factorySlug = (factory.slug as string) ?? "factory";
            const repoName = `${factorySlug}-${projectSlug}`;

            // Shared file payload with README/.gitignore injection.
            const ghFiles = [...files];
            if (!ghFiles.some((f) => f.path === "README.md")) {
              ghFiles.push({ path: "README.md", content: `# ${project.name as string} — sprint-${sprintNum}\n\nGenerated by ${brand.name}.\n` });
            }
            if (!ghFiles.some((f) => f.path === ".gitignore")) {
              ghFiles.push({ path: ".gitignore", content: `staging/\n.tp/\n.claude/\n.mcp.json\nCLAUDE.md\nnode_modules/\n` });
            }

            for (const id of effectiveIds) {
              let owner: string | null = null;
              let token: string | null = null;
              let branch = branchDefault;
              let label  = id;
              if (id === "global") {
                owner = envVars["GITHUB_OWNER"] ?? null;
                token = envVars["GITHUB_TOKEN"] ?? null;
                label = "global";
              } else {
                const d = factoryDests.find((x) => x.id === id);
                if (d) {
                  owner = d.owner; token = d.token; branch = d.branch ?? branchDefault; label = d.name;
                }
              }
              if (!owner || !token) {
                results.push({ target: `github:${label}`, ok: false, error: `credentials missing for destination "${label}"` });
                continue;
              }

              // Ensure the repo exists on this destination.
              const headers = { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" };
              let repoUrl: string | null = null;
              const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, { headers });
              if (checkRes.ok) {
                repoUrl = ((await checkRes.json()) as { html_url: string }).html_url;
              } else {
                const ownerRes = await fetch(`https://api.github.com/users/${owner}`, { headers });
                const isOrg = ((await ownerRes.json()) as { type?: string }).type === "Organization";
                const createUrl = isOrg ? `https://api.github.com/orgs/${owner}/repos` : "https://api.github.com/user/repos";
                const createRes = await fetch(createUrl, {
                  method: "POST", headers,
                  body: JSON.stringify({ name: repoName, description: `${project.name as string ?? projectSlug}`, private: true, auto_init: true }),
                });
                if (createRes.ok || createRes.status === 201) {
                  repoUrl = ((await createRes.json()) as { html_url: string }).html_url;
                }
              }
              if (!repoUrl) {
                results.push({ target: `github:${label}`, ok: false, error: "could not resolve or create repo" });
                continue;
              }
              if (!project.repo_url) {
                await sb.from("projects").update({ repo_url: repoUrl }).eq("id", projectId);
                project.repo_url = repoUrl;
              }

              try {
                await githubPushSprint({ token, owner, repo: repoName, sprintNum, branch, files: ghFiles });
                results.push({ target: `github:${label}`, ok: true });
              } catch (e) {
                results.push({ target: `github:${label}`, ok: false, error: (e as Error).message });
              }
            }
          }
        } catch (e) {
          results.push({ target: "github", ok: false, error: (e as Error).message });
        }
      }

      // ── Download ZIP target (must be last — returns binary) ────────────
      if (targets.includes("download")) {
        const zipFiles = files.map((f) => ({
          name: f.path,
          content: Buffer.from(f.content, "utf-8"),
        }));

        if (zipFiles.length > 0) {
          // Close sprint before sending zip
          await sb.from("sprints")
            .update({ status: "completed", sprint_completed_saved: true, completed_at: new Date().toISOString(), needs_human: false })
            .eq("id", sprintId);
          await sb.from("projects").update({ status: "idle" }).eq("id", projectId);

          const zipBuffer = makeZip(zipFiles);
          const filename = `${projectSlug}-sprint-${sprintNum}.zip`;
          return new NextResponse(new Uint8Array(zipBuffer), {
            status: 200,
            headers: {
              "Content-Type": "application/zip",
              "Content-Disposition": `attachment; filename="${filename}"`,
              "Content-Length": String(zipBuffer.length),
              "X-Export-Results": JSON.stringify(results),
            },
          });
        } else {
          results.push({ target: "download", ok: false, error: "No files found" });
        }
      }

      // Close sprint
      await sb.from("sprints")
        .update({ status: "completed", sprint_completed_saved: true, completed_at: new Date().toISOString(), needs_human: false })
        .eq("id", sprintId);
      await sb.from("projects").update({ status: "idle" }).eq("id", projectId);
      try { const { createNotification } = await import("@/lib/notifications"); await createNotification({ tenantId: factory.tenant_id as string, eventType: "sprint_completed", severity: "info", title: `Sprint completed — ${project.name as string}`, body: `Exported to: ${targets.join(", ")}`, metadata: { projectId, sprintId } }); } catch { /* non-blocking */ }

      return NextResponse.json({ ok: true, action: "export", results });
    }

    return NextResponse.json({ error: "Unhandled action" }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
