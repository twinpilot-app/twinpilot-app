/**
 * GET  /api/factory/harness-presets?factoryId=…
 * POST /api/factory/harness-presets
 *
 * BL-26 Phase 4 — manages reusable agent harness bundles per factory.
 * A preset is a named JSONB blob of harness tunables (cli, model,
 * max_turns, effort, append_system_prompt, skills_include/exclude, …)
 * that an agent override can reference by id. The worker merges the
 * preset config UNDER the override so the agent's own field-by-field
 * settings always win.
 *
 * Reading: any tenant member.
 * Writing: platform_admin / admin only — presets shape dispatch
 * behaviour for everyone in the factory.
 */
import { NextRequest, NextResponse } from "next/server";
import { slugify } from "@/lib/slugify";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { FactoryHarnessPresetCreateSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function loadFactory(sb: SupabaseClient, factoryId: string) {
  const { data: factory } = await sb
    .from("factories")
    .select("id, tenant_id")
    .eq("id", factoryId)
    .maybeSingle();
  if (!factory) throw new NotFoundError("Factory not found");
  return factory;
}

async function assertMember(sb: SupabaseClient, userId: string, tenantId: string) {
  const { data } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new ForbiddenError("Caller is not a member of this tenant");
  return data.role as string;
}

function validateConfig(cfg: unknown): cfg is Record<string, unknown> {
  return typeof cfg === "object" && cfg !== null && !Array.isArray(cfg);
}

export async function GET(req: NextRequest) {
  try {
    const factoryId = new URL(req.url).searchParams.get("factoryId");
    if (!factoryId) {
      return NextResponse.json({ error: "factoryId required", code: "VALIDATION_ERROR" }, { status: 400 });
    }
    const { user, sb } = await getOperatorUser(req);

    const factory = await loadFactory(sb, factoryId);
    await assertMember(sb, user.id, factory.tenant_id as string);

    const { data, error } = await sb
      .from("harness_presets")
      .select("id, slug, name, description, config, created_at, updated_at")
      .eq("factory_id", factoryId)
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);

    return NextResponse.json({ presets: data ?? [] });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, FactoryHarnessPresetCreateSchema);
    const { user, sb } = await getOperatorUser(req);

    if (!validateConfig(body.config)) {
      throw new ValidationError("config must be a JSON object", []);
    }

    const factory = await loadFactory(sb, body.factoryId);
    const role = await assertMember(sb, user.id, factory.tenant_id as string);
    if (!["platform_admin", "admin"].includes(role)) {
      throw new ForbiddenError("Caller is not an admin of this tenant");
    }

    const slug = slugify(body.slug?.trim() || body.name);
    if (!slug) throw new ValidationError("slug must be at least one alphanumeric char", []);

    const { data, error } = await sb
      .from("harness_presets")
      .insert({
        factory_id:  body.factoryId,
        slug,
        name:        body.name.trim(),
        description: body.description?.trim() || null,
        config:      body.config,
      })
      .select("id, slug, name, description, config, created_at, updated_at")
      .single();
    if (error) {
      const status = error.message.includes("duplicate") ? 409 : 500;
      return NextResponse.json({
        error: error.message,
        code:  status === 409 ? "CONFLICT" : "INTERNAL",
      }, { status });
    }

    return NextResponse.json({ preset: data });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
