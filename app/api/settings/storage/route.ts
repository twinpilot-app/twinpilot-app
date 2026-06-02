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
import { defaultLocalBasePath } from "@/lib/storage-defaults";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { SettingsStorageSaveSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

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

async function getTenantId(sb: SupabaseClient, userId: string): Promise<string> {
  const { data } = await sb
    .from("tenant_members")
    .select("tenant_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (!data) throw new NotFoundError("No tenant found for user");
  return data.tenant_id as string;
}

/* ─── GET — list backends (no credentials returned) ─────────────────────────── */

export async function GET(req: NextRequest) {
  try {
    const { user, sb } = await getOperatorUser(req);
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
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

/* ─── POST — add / update a backend ─────────────────────────────────────────── */

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, SettingsStorageSaveSchema);
    const { user, sb } = await getOperatorUser(req);
    const tenantId = await getTenantId(sb, user.id);

    if (body.type === "supabase" && (!body.url?.trim() || !body.key?.trim())) {
      throw new ValidationError("url and key are required for supabase backend", []);
    }
    if (body.type === "local" && !body.basePath?.trim()) {
      throw new ValidationError("basePath is required for local backend", []);
    }

    const gitModeValue: "none" | "clone" | "existing" =
      typeof body.gitMode === "string" ? body.gitMode
      : body.gitMode === true ? "clone"
      : "none";
    const cfg: StorageBackendConfig = {
      type:       body.type,
      name:       body.name.trim(),
      url:        body.type === "supabase" ? body.url?.trim() : undefined,
      key:        body.type === "supabase" ? body.key?.trim() : undefined,
      basePath:   body.type === "local"    ? body.basePath?.trim() : undefined,
      gitMode:    gitModeValue,
      verified:   body.verified ?? false,
      ...(body.verifiedAt ? { verifiedAt: body.verifiedAt } : {}),
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
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

/* ─── DELETE — remove a backend ──────────────────────────────────────────────── */

export async function DELETE(req: NextRequest) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const tenantId = await getTenantId(sb, user.id);

    const name = req.nextUrl.searchParams.get("name");
    if (!name) return NextResponse.json({ error: "name query param required", code: "VALIDATION_ERROR" }, { status: 400 });

    const { error } = await sb
      .from("tenant_integrations")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("service_id", "storage")
      .eq("var_name",   name);

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
