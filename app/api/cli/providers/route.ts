/**
 * GET  /api/cli/providers?tenantId=...  — list configured CLI provider API keys
 * POST /api/cli/providers               — save/update a CLI provider API key
 *
 * API keys are stored in tenant_integrations with service_id = "cli".
 * This is the canonical source for CLI provider keys — distinct from
 * /api/settings/integrations which uses provider-specific service_ids
 * ("anthropic", "openai", etc.) for non-CLI integrations.
 * The control-plane executor reads exclusively from service_id = "cli".
 *
 * Auth: Bearer {supabase access_token}
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

async function verifyMembership(sb: ReturnType<typeof serviceClient>, userId: string, tenantId: string) {
  const { data } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .single();
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
    const { user, sb } = await getUser(req);
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

    const member = await verifyMembership(sb, user.id, tenantId);
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const { tenantId, varName, value } = await req.json() as {
      tenantId: string;
      varName: string;
      value: string;
    };

    if (!tenantId || !varName || !value) {
      return NextResponse.json({ error: "tenantId, varName, and value required" }, { status: 400 });
    }

    if (!ALL_VARS.includes(varName)) {
      return NextResponse.json({ error: "Unknown var name" }, { status: 400 });
    }

    const member = await verifyMembership(sb, user.id, tenantId);
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const preview = value.length > 8 ? `${value.slice(0, 6)}…${value.slice(-4)}` : "…";

    const { error } = await sb
      .from("tenant_integrations")
      .upsert(
        { tenant_id: tenantId, service_id: "cli", var_name: varName, secret_value: value, preview },
        { onConflict: "tenant_id,service_id,var_name" },
      );

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, preview });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const { tenantId, varName } = await req.json() as { tenantId: string; varName: string };

    if (!tenantId || !varName) {
      return NextResponse.json({ error: "tenantId and varName required" }, { status: 400 });
    }

    const member = await verifyMembership(sb, user.id, tenantId);
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    await sb
      .from("tenant_integrations")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("service_id", "cli")
      .eq("var_name", varName);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
