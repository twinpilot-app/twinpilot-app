/**
 * GET / POST /api/factory/pip/settings
 *
 * Read / write the per-factory PIP feature config. Lives on
 * `factories.config.pip` as a small jsonb sub-object — keeps PIP
 * settings together so future flags plug in without endpoint churn.
 *
 * Schema:
 *   factories.config.pip = {
 *     cli_config?: {                  // optional — when absent, the
 *                                     // inception POST inherits from
 *                                     // any existing project on the
 *                                     // factory (fallback chain).
 *       default_cli?:        string,           // claude-code|codex|...
 *       authMode?:           "oauth" | "api-key",
 *       execution_backend?:  "local" | "supabase",
 *       default_model?:      string,
 *       default_effort?:     "low" | "medium" | "high" | "max",
 *       agent_overrides?: {
 *         [slug: string]: {
 *           cli?:      string,
 *           model?:    string,
 *           effort?:   "low" | "medium" | "high" | "max",
 *           authMode?: "oauth" | "api-key",
 *         }
 *       }
 *     }
 *   }
 *
 * Auto-apply moved to per-inception (PIP > Run Inception form);
 * factory-level default removed.
 *
 * Auth: getUser + assertMember(platform_admin | admin).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getUser, assertMember, errorResponse, parseBody,
} from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const EffortSchema = z.enum(["low", "medium", "high", "max"]);
const AuthModeSchema = z.enum(["oauth", "api-key"]);

const AgentOverrideSchema = z.object({
  cli:      z.string().min(1).max(60).optional(),
  model:    z.string().min(1).max(120).optional(),
  effort:   EffortSchema.optional(),
  authMode: AuthModeSchema.optional(),
}).strict();

const CliConfigSchema = z.object({
  default_cli:       z.string().min(1).max(60).optional(),
  authMode:          AuthModeSchema.optional(),
  execution_backend: z.enum(["local", "supabase"]).optional(),
  default_model:     z.string().min(1).max(120).optional(),
  default_effort:    EffortSchema.optional(),
  agent_overrides:   z.record(z.string(), AgentOverrideSchema).optional(),
}).strict();

const SettingsSchema = z.object({
  cli_config: CliConfigSchema.nullable().optional(),
}).strict();

export async function GET(req: NextRequest) {
  try {
    const factoryId = new URL(req.url).searchParams.get("factoryId");
    if (!factoryId) {
      return NextResponse.json(
        { error: "factoryId query param is required", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    const { user, sb } = await getUser(req);
    await assertMember(sb, user.id, factoryId, ["platform_admin", "admin"]);

    const { data: factory } = await sb
      .from("factories")
      .select("config")
      .eq("id", factoryId)
      .maybeSingle();
    if (!factory) throw new NotFoundError("Factory not found");

    const cfg = (factory.config ?? {}) as Record<string, unknown>;
    const pip = (cfg.pip ?? {}) as Record<string, unknown>;
    return NextResponse.json({
      cli_config: (pip.cli_config as Record<string, unknown> | undefined) ?? null,
    });
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
    const factoryId = new URL(req.url).searchParams.get("factoryId");
    if (!factoryId) {
      return NextResponse.json(
        { error: "factoryId query param is required", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }
    const body = await parseBody(req, SettingsSchema);
    const { user, sb } = await getUser(req);
    await assertMember(sb, user.id, factoryId, ["platform_admin", "admin"]);

    // Read-modify-write — preserve sibling keys under config (and under
    // config.pip) that other features might own.
    const { data: factory } = await sb
      .from("factories")
      .select("config")
      .eq("id", factoryId)
      .maybeSingle();
    if (!factory) throw new NotFoundError("Factory not found");

    const prevCfg = (factory.config ?? {}) as Record<string, unknown>;
    const prevPip = (prevCfg.pip ?? {}) as Record<string, unknown>;
    const nextPip: Record<string, unknown> = { ...prevPip };
    if (body.cli_config !== undefined) {
      if (body.cli_config === null) delete nextPip.cli_config;
      else                          nextPip.cli_config = body.cli_config;
    }
    const nextCfg = { ...prevCfg, pip: nextPip };
    const { error: updErr } = await sb
      .from("factories")
      .update({ config: nextCfg })
      .eq("id", factoryId);
    if (updErr) {
      return NextResponse.json({ error: `Update failed: ${updErr.message}` }, { status: 500 });
    }
    return NextResponse.json({
      ok:         true,
      cli_config: (nextPip.cli_config as Record<string, unknown> | undefined) ?? null,
    });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
