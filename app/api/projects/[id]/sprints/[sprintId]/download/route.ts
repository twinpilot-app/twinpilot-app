/**
 * GET /api/projects/[id]/sprints/[sprintId]/download
 *
 * Returns all sprint artifacts as a ZIP archive.
 * Lists files under the sprint prefix in Supabase Storage and bundles them.
 *
 * Auth: Bearer {supabase access_token}
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { deflateRawSync } from "node:zlib";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; sprintId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { id: projectId, sprintId } = await params;

    // ── Auth + load project ───────────────────────────────────────────────────
    const { data: project } = await sb
      .from("projects")
      .select("slug, factory_id, settings")
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

    // ── Load sprint ───────────────────────────────────────────────────────────
    const { data: sprint } = await sb
      .from("sprints")
      .select("id, sprint_num, config")
      .eq("id", sprintId)
      .eq("project_id", projectId)
      .single();
    if (!sprint) return NextResponse.json({ error: "Sprint not found" }, { status: 404 });

    const projectSlug  = project.slug as string;
    const sprintNum    = sprint.sprint_num as number;
    const tenantId     = factory.tenant_id as string;
    const tenantSlug   = tenant?.slug as string;
    const factorySlug  = factory.slug as string;
    const settings     = (project.settings ?? {}) as Record<string, unknown>;
    const cliCfg       = (settings.cli_agents ?? {}) as Record<string, unknown>;
    const sprintConfig = (sprint?.config ?? {}) as Record<string, unknown>;

    // Resolve localBase: sprint config → project settings → tenant storage
    let localBase = sprintConfig.localBasePath as string | undefined
      ?? cliCfg.local_base_path as string | undefined;

    if (!localBase) {
      const { data: storageInts } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", tenantId)
        .eq("service_id", "storage");
      for (const row of storageInts ?? []) {
        try {
          const cfg = JSON.parse(row.secret_value as string) as { type?: string; basePath?: string };
          if (cfg.type === "local" && cfg.basePath) { localBase = cfg.basePath; break; }
        } catch { /* ignore */ }
      }
    }

    // ── Collect files — try local first, then bucket ─────────────────────────
    const zipFiles: { name: string; content: Buffer }[] = [];

    function readLocalDir(dir: string, rel = ""): void {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || (name.startsWith(".") && name !== ".gitignore")) continue;
        const full = join(dir, name);
        const relPath = rel ? `${rel}/${name}` : name;
        if (statSync(full).isDirectory()) {
          readLocalDir(full, relPath);
        } else {
          try { zipFiles.push({ name: relPath, content: readFileSync(full) }); } catch { /* skip */ }
        }
      }
    }

    // Try local filesystem first
    if (localBase && tenantSlug && factorySlug) {
      const stagingDir = localSprintPath(localBase, tenantSlug, factorySlug, projectSlug, sprintNum);
      if (isWithinBase(resolve(stagingDir), localBase)) {
        readLocalDir(stagingDir);
      }
    }

    // If local didn't find anything, try Supabase bucket
    if (zipFiles.length === 0) {
      // Supabase bucket
      const storageName = settings.storage_backend_name as string | undefined;
      let storageClient = sb;
      let bucket        = TP_BUCKET;
      let prefix        = (tenantSlug && factorySlug) ? sprintPath(tenantSlug, factorySlug, projectSlug, sprintNum) : `${projectSlug}/sprint-${sprintNum}`;

      if (storageName) {
        const { data: integration } = await sb
          .from("tenant_integrations")
          .select("secret_value")
          .eq("tenant_id", tenantId)
          .eq("service_id", "storage")
          .eq("var_name", storageName)
          .single();

        if (integration?.secret_value) {
          try {
            const cfg = JSON.parse(integration.secret_value as string) as {
              type: string; url?: string; key?: string;
            };
            if (cfg.type === "supabase" && cfg.url && cfg.key) {
              storageClient = createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
              bucket = "staging";
            }
          } catch { /* use default */ }
        }
      }

      async function listAll(pfx: string): Promise<string[]> {
        const { data, error } = await storageClient.storage.from(bucket).list(pfx, { limit: 1000 });
        if (error || !data) return [];
        const paths: string[] = [];
        for (const item of data) {
          const full = `${pfx}/${item.name}`;
          if (!item.id) paths.push(...await listAll(full));
          else paths.push(full);
        }
        return paths;
      }

      const storagePaths = await listAll(prefix);
      for (const storagePath of storagePaths) {
        const { data, error } = await storageClient.storage.from(bucket).download(storagePath);
        if (error || !data) continue;
        const relPath = storagePath.slice(prefix.length + 1);
        zipFiles.push({ name: relPath, content: Buffer.from(await data.arrayBuffer()) });
      }
    }

    if (zipFiles.length === 0) {
      return NextResponse.json({
        error: "No files found for this sprint.",
        debug: { projectSlug, sprintNum },
      }, { status: 404 });
    }

    const zipBuffer = makeZip(zipFiles);
    const filename  = `${projectSlug}-sprint-${sprintNum}.zip`;

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type":        "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length":      String(zipBuffer.length),
      },
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
