/**
 * GET  /api/settings/storage          — list configured storage backends
 * POST /api/settings/storage          — add / update a backend
 * DELETE /api/settings/storage?name=  — remove a backend by name
 *
 * Backends are stored in tenant_integrations:
 *   service_id  = "storage"
 *   var_name    = backend name (e.g. "default", "my-supabase")
 *   secret_value = StorageBackendConfig JSON
 *
 * Auth: Bearer {supabase access_token}
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { defaultLocalBasePath } from "@/lib/storage-defaults";

export const dynamic = "force-dynamic";

export interface StorageBackendConfig {
  type:       "supabase" | "local";
  name:       string;
  url?:       string;
  key?:       string;
  basePath?:  string;
  gitMode?:   "none" | "clone" | "existing";
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
  if (!data) throw new Error("No tenant found for user");
  return data.tenant_id as string;
}

/* ─── GET — list backends (no credentials returned) ─────────────────────────── */

export async function GET(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const tenantId = await getTenantId(sb, user.id);

    const { data, error } = await sb
      .from("tenant_integrations")
      .select("var_name, secret_value")
      .eq("tenant_id", tenantId)
      .eq("service_id", "storage");

    if (error) throw new Error(error.message);

    const backends = (data ?? []).map((row: { var_name: string; secret_value: string }) => {
      try {
        const cfg = JSON.parse(row.secret_value) as StorageBackendConfig;
        // Never return credentials to the browser
        return {
          name:       cfg.name,
          type:       cfg.type,
          url:        cfg.type === "supabase" ? cfg.url : undefined,
          basePath:   cfg.type === "local"    ? cfg.basePath : undefined,
          gitMode:    cfg.gitMode,
          verified:   cfg.verified ?? false,
          verifiedAt: cfg.verifiedAt,
        };
      } catch {
        return { name: row.var_name, type: "unknown", verified: false };
      }
    });

    // Resolve the global `local` base path: configured backend wins; otherwise
    // fall back to the OS user-home convention so a fresh install Just Works
    // without forcing the operator to configure storage before their first
    // sprint.
    const configuredLocal = backends.find((b) => b.type === "local" && b.basePath?.trim());
    const resolvedDefaultLocalBasePath = configuredLocal?.basePath?.trim() || defaultLocalBasePath();
    const isHomedirFallback = !configuredLocal;

    return NextResponse.json({
      backends,
      defaultLocalBasePath:    resolvedDefaultLocalBasePath,
      defaultLocalBasePathIsHomedirFallback: isHomedirFallback,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/* ─── POST — add / update a backend ─────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const tenantId = await getTenantId(sb, user.id);

    const body = await req.json() as Partial<StorageBackendConfig> & { verified?: boolean; verifiedAt?: string };

    const { type, name, url, key, basePath, gitMode, verified, verifiedAt } = body;

    if (!type || !name?.trim()) {
      return NextResponse.json({ error: "type and name are required" }, { status: 400 });
    }
    if (type === "supabase" && (!url?.trim() || !key?.trim())) {
      return NextResponse.json({ error: "url and key are required for supabase backend" }, { status: 400 });
    }
    if (type === "local" && !basePath?.trim()) {
      return NextResponse.json({ error: "basePath is required for local backend" }, { status: 400 });
    }

    const cfg: StorageBackendConfig = {
      type,
      name:      name.trim(),
      url:       type === "supabase" ? url?.trim() : undefined,
      key:       type === "supabase" ? key?.trim() : undefined,
      basePath:  type === "local"    ? basePath?.trim() : undefined,
      gitMode:   gitMode ?? "none",
      verified:  verified ?? false,
      verifiedAt,
    };

    const { error } = await sb
      .from("tenant_integrations")
      .upsert(
        {
          tenant_id:    tenantId,
          service_id:   "storage",
          var_name:     cfg.name,
          secret_value: JSON.stringify(cfg),
          updated_at:   new Date().toISOString(),
        },
        { onConflict: "tenant_id,service_id,var_name" },
      );

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, name: cfg.name });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/* ─── DELETE — remove a backend ──────────────────────────────────────────────── */

export async function DELETE(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const tenantId = await getTenantId(sb, user.id);

    const name = req.nextUrl.searchParams.get("name");
    if (!name) return NextResponse.json({ error: "name query param required" }, { status: 400 });

    const { error } = await sb
      .from("tenant_integrations")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("service_id", "storage")
      .eq("var_name",   name);

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
