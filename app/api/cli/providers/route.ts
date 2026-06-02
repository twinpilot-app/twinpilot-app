/**
 * GET    /api/cli/providers?tenantId=...  — list configured CLI provider API keys
 * POST   /api/cli/providers                — save/update a single env var
 * DELETE /api/cli/providers                — remove a single env var
 *
 * API keys are stored in tenant_integrations with service_id = "cli".
 * The control-plane executor reads exclusively from service_id = "cli".
 *
 * Auth: Bearer {supabase access_token}
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { CliProvidersSaveSchema, CliProvidersDeleteSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function verifyMembership(sb: SupabaseClient, userId: string, tenantId: string) {
  const { data } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

/** Env var names used by each CLI provider (cloud mode) */
const CLI_PROVIDER_VARS: Record<string, string[]> = {
  "claude-code": ["ANTHROPIC_API_KEY"],
  "aider":       ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"],
  "codex":       ["OPENAI_API_KEY"],
  "plandex":     ["OPENAI_API_KEY"],
  "goose":       ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  "amp":         ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  "gemini-cli":  ["GEMINI_API_KEY"],
};

const ALL_VARS = [...new Set(Object.values(CLI_PROVIDER_VARS).flat())];

export async function GET(req: NextRequest) {
  try {
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId required", code: "VALIDATION_ERROR" }, { status: 400 });
    }
    const { user, sb } = await getOperatorUser(req);
    const member = await verifyMembership(sb, user.id, tenantId);
    if (!member) throw new ForbiddenError("Caller is not a member of this tenant");

    const { data: rows } = await sb
      .from("tenant_integrations")
      .select("var_name, preview, updated_at")
      .eq("tenant_id", tenantId)
      .eq("service_id", "cli")
      .in("var_name", ALL_VARS);

    const configured: Record<string, { preview: string; updatedAt: string }> = {};
    for (const row of rows ?? []) {
      configured[row.var_name as string] = {
        preview:   (row.preview as string | null) ?? "",
        updatedAt: row.updated_at as string,
      };
    }

    return NextResponse.json({ configured });
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
    const { tenantId, varName, value } = await parseBody(req, CliProvidersSaveSchema);
    if (!ALL_VARS.includes(varName)) throw new ValidationError("Unknown var name", []);

    const { user, sb } = await getOperatorUser(req);
    const member = await verifyMembership(sb, user.id, tenantId);
    if (!member) throw new ForbiddenError("Caller is not a member of this tenant");

    const preview = value.length > 8 ? `${value.slice(0, 6)}…${value.slice(-4)}` : "…";

    const { error } = await sb
      .from("tenant_integrations")
      .upsert(
        { tenant_id: tenantId, service_id: "cli", var_name: varName, secret_value: value, preview },
        { onConflict: "tenant_id,service_id,var_name" },
      );

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, preview });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { tenantId, varName } = await parseBody(req, CliProvidersDeleteSchema);
    const { user, sb } = await getOperatorUser(req);
    const member = await verifyMembership(sb, user.id, tenantId);
    if (!member) throw new ForbiddenError("Caller is not a member of this tenant");

    await sb
      .from("tenant_integrations")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("service_id", "cli")
      .eq("var_name", varName);

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
