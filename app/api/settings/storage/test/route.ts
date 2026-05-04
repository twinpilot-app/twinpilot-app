/**
 * POST /api/settings/storage/test
 *
 * Tests a storage backend configuration and, on success, writes the
 * .tirsa-factory marker file so the directory/bucket is recognized.
 * Also updates the `verified` + `verifiedAt` fields in tenant_integrations.
 *
 * Two usage modes:
 *   A) New backend — pass full config: { type, name, url+key | basePath, gitMode? }
 *   B) Existing backend — pass name only: { name } — server fetches stored config
 *
 * Returns: { ok: true; note: string } | { error: string }
 *
 * Auth: Bearer {supabase access_token}
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { brand } from "@/lib/brand";

export const dynamic = "force-dynamic";

const TIRSA_BUCKET = "tirsa";
const MARKER_FILE  = ".tirsa-factory";

interface StorageBackendConfig {
  type:       "supabase" | "local" | "github";
  name:       string;
  url?:       string;
  key?:       string;
  basePath?:  string;
  gitMode?:   string;
  verified?:  boolean;
  verifiedAt?: string;
}

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

async function getTenantId(sb: ReturnType<typeof serviceClient>, userId: string): Promise<string> {
  const { data } = await sb
    .from("tenant_members")
    .select("tenant_id")
    .eq("user_id", userId)
    .limit(1)
    .single();
  if (!data) throw new Error("No tenant found");
  return data.tenant_id as string;
}

async function testConfig(
  cfg: StorageBackendConfig,
  tenantId: string,
): Promise<{ note: string }> {
  if (cfg.type === "supabase") {
    if (!cfg.url || !cfg.key) throw new Error("url and key are required for supabase backend");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createClient(cfg.url.trim(), cfg.key.trim(), { auth: { persistSession: false } }) as SupabaseClient<any>;

    // Try to create bucket (best-effort — ok if already exists or RLS blocks it)
    const { error: bucketErr } = await client.storage.createBucket(TIRSA_BUCKET, { public: false });
    if (bucketErr) {
      const bmsg = bucketErr.message.toLowerCase();
      if (!bmsg.includes("already exists") && !bmsg.includes("duplicate")) {
        // Not a "already exists" error — log but continue; upload will confirm if bucket is accessible
        console.warn(`[storage/test] createBucket warning: ${bucketErr.message}`);
      }
    }

    const testPath = `.tirsa-test/${Date.now()}.txt`;
    const { error: uploadErr } = await client.storage
      .from(TIRSA_BUCKET)
      .upload(testPath, Buffer.from("tirsa-storage-test", "utf-8"), { upsert: true, contentType: "text/plain" });
    if (uploadErr) {
      const umsg = uploadErr.message.toLowerCase();
      if (umsg.includes("bucket not found") || umsg.includes("not found")) {
        throw new Error(
          `Bucket '${TIRSA_BUCKET}' not found. Create it in your Supabase dashboard (Storage → New bucket → name: "${TIRSA_BUCKET}", private) or use the service_role key so ${brand.shortName} can create it automatically.`,
        );
      }
      if (umsg.includes("security") || umsg.includes("policy") || umsg.includes("unauthorized") || umsg.includes("403")) {
        throw new Error(
          `Permission denied writing to bucket '${TIRSA_BUCKET}'. Use the service_role key (Dashboard → Settings → API Keys → service_role).`,
        );
      }
      throw new Error(`Storage write failed: ${uploadErr.message}`);
    }
    await client.storage.from(TIRSA_BUCKET).remove([testPath]);

    const marker = JSON.stringify({
      tirsa_version: "1.0",
      tenant_id:     tenantId,
      backend_name:  cfg.name,
      type:          "supabase",
      created_at:    new Date().toISOString(),
    }, null, 2);
    await client.storage.from(TIRSA_BUCKET).upload(
      MARKER_FILE,
      Buffer.from(marker, "utf-8"),
      { upsert: true, contentType: "application/json" },
    );

    return { note: `Bucket '${TIRSA_BUCKET}' is ready and marker written.` };
  }

  if (cfg.type === "local") {
    if (!cfg.basePath) throw new Error("basePath is required for local backend");
    const dir = cfg.basePath.trim();
    mkdirSync(dir, { recursive: true });

    const testFile = join(dir, `.tirsa-test-${Date.now()}`);
    writeFileSync(testFile, "tirsa-storage-test", "utf-8");
    const readBack = readFileSync(testFile, "utf-8");
    rmSync(testFile);
    if (readBack !== "tirsa-storage-test") throw new Error("Read-back mismatch — filesystem error.");

    const marker = JSON.stringify({
      tirsa_version: "1.0",
      tenant_id:     tenantId,
      backend_name:  cfg.name,
      type:          "local",
      created_at:    new Date().toISOString(),
    }, null, 2);
    writeFileSync(join(dir, MARKER_FILE), marker, "utf-8");

    return { note: `Directory '${dir}' is writable and marker written.` };
  }

  if (cfg.type === "github") {
    // Fetch GitHub credentials from tenant_integrations (individual rows per key)
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const { data: ghRows } = await sb
      .from("tenant_integrations")
      .select("var_name, secret_value")
      .eq("tenant_id", tenantId)
      .eq("service_id", "github");

    const ghKeys: Record<string, string> = {};
    for (const row of ghRows ?? []) {
      if (row.var_name && row.secret_value) ghKeys[row.var_name as string] = row.secret_value as string;
    }
    if (!ghKeys.GITHUB_TOKEN || !ghKeys.GITHUB_OWNER) throw new Error("GitHub token or owner not configured. Set up GitHub in Integrations first.");

    // Test: list repos for the owner
    const res = await fetch(`https://api.github.com/user`, {
      headers: { Authorization: `Bearer ${ghKeys.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status} — check your token.`);
    const user = await res.json() as { login: string };

    // Test: verify owner access
    const orgRes = await fetch(`https://api.github.com/orgs/${ghKeys.GITHUB_OWNER}/repos?per_page=1`, {
      headers: { Authorization: `Bearer ${ghKeys.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    const userRes = await fetch(`https://api.github.com/users/${ghKeys.GITHUB_OWNER}/repos?per_page=1`, {
      headers: { Authorization: `Bearer ${ghKeys.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!orgRes.ok && !userRes.ok) {
      throw new Error(`Cannot access repos for "${ghKeys.GITHUB_OWNER}". Check token scopes and org SSO.`);
    }

    return { note: `GitHub authenticated as @${user.login}, owner "${ghKeys.GITHUB_OWNER}" accessible.` };
  }

  throw new Error("type must be 'supabase', 'local', or 'github'");
}

export async function POST(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const tenantId = await getTenantId(sb, user.id);

    const body = await req.json() as {
      name:      string;
      type?:     "supabase" | "local" | "github";
      url?:      string;
      key?:      string;
      basePath?: string;
      gitMode?:  string;
    };

    const { name } = body;
    if (!name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });

    let cfg: StorageBackendConfig;

    if (body.type) {
      // Mode A — inline config provided
      cfg = {
        type:     body.type,
        name:     name.trim(),
        url:      body.url,
        key:      body.key,
        basePath: body.basePath,
        gitMode:  body.gitMode,
      };
    } else {
      // Mode B — look up stored config
      const { data, error } = await sb
        .from("tenant_integrations")
        .select("secret_value")
        .eq("tenant_id", tenantId)
        .eq("service_id", "storage")
        .eq("var_name",   name.trim())
        .single();

      if (error || !data) {
        return NextResponse.json({ error: `Backend '${name}' not found` }, { status: 404 });
      }
      cfg = JSON.parse(data.secret_value as string) as StorageBackendConfig;
    }

    const { note } = await testConfig(cfg, tenantId);

    // Mark as verified in DB
    const verified    = true;
    const verifiedAt  = new Date().toISOString();
    const updatedCfg  = { ...cfg, verified, verifiedAt };
    await sb
      .from("tenant_integrations")
      .upsert(
        {
          tenant_id:    tenantId,
          service_id:   "storage",
          var_name:     cfg.name,
          secret_value: JSON.stringify(updatedCfg),
          updated_at:   verifiedAt,
        },
        { onConflict: "tenant_id,service_id,var_name" },
      );

    return NextResponse.json({ ok: true, note });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
