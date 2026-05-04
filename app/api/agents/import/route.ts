/**
 * POST /api/agents/import
 *
 * Parses a YAML agent spec and upserts into agent_definitions.
 * Supports both legacy format (persona/sipoc) and new persona model (description/output_types).
 * Body: { tenantId, factoryId, yaml }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { load as parseYaml } from "js-yaml";

export const dynamic = "force-dynamic";

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

interface YamlAgent {
  slug?: string;
  name?: string;
  version?: string;
  squad?: string;
  level?: string;
  icon?: string;
  // New format
  description?: string;
  output_types?: string[];
  suggested_inputs?: string[];
  tools?: string[];
  autonomy?: string;
  human_gate_reason?: string;
  sla?: string;
  guardrails?: string;
  accept_external_instructions?: boolean;
  model_preference?: string;
  max_rounds?: number;
  // Legacy format
  persona?: string;
  sipoc?: {
    inputs?: { artifact: string }[];
    outputs?: { artifact: string }[];
  };
  protocol?: {
    human_gate?: boolean;
    human_gate_reason?: string;
    sla?: string;
  };
  constraints?: string;
}

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const s = sb();
    const { data: { user }, error: authErr } = await s.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json() as { tenantId?: string; factoryId?: string; yaml?: string };
    const { tenantId, factoryId, yaml } = body;
    if (!tenantId || !yaml) {
      return NextResponse.json({ error: "tenantId and yaml required" }, { status: 400 });
    }

    // Verify membership
    const { data: member } = await s.from("tenant_members").select("id").eq("tenant_id", tenantId).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    let agent: YamlAgent;
    try {
      agent = parseYaml(yaml) as YamlAgent;
    } catch (e: unknown) {
      return NextResponse.json({ error: `Invalid YAML: ${(e as Error).message}` }, { status: 400 });
    }

    if (!agent.slug || !agent.name) {
      return NextResponse.json({ error: "YAML must have slug and name fields" }, { status: 400 });
    }

    // Build normalized spec — handle both new and legacy formats
    const spec: Record<string, unknown> = {
      description: agent.description ?? agent.persona ?? "",
      output_types: agent.output_types ?? (agent.sipoc?.outputs ?? []).map((o) => o.artifact).filter(Boolean),
      suggested_inputs: agent.suggested_inputs ?? (agent.sipoc?.inputs ?? []).map((i) => i.artifact).filter(Boolean),
      tools: agent.tools ?? [],
      autonomy: agent.autonomy ?? "auto",
      human_gate_reason: agent.human_gate_reason ?? (agent.protocol?.human_gate ? (agent.protocol.human_gate_reason ?? "Requires human approval") : ""),
      sla: agent.sla ?? agent.protocol?.sla ?? "",
      guardrails: agent.guardrails ?? agent.constraints ?? "",
      accept_external_instructions: agent.accept_external_instructions ?? true,
      model_preference: agent.model_preference ?? "",
      max_rounds: agent.max_rounds ?? 0,
    };

    const { data: tenant } = await s.from("tenants").select("marketplace_id").eq("id", tenantId).single();

    const row: Record<string, unknown> = {
      tenant_id: tenantId,
      factory_id: factoryId || null,
      slug: agent.slug,
      name: agent.name,
      version: agent.version ?? "1.0.0",
      squad: agent.squad ?? null,
      level: agent.level ?? null,
      icon: agent.icon ?? null,
      origin: "user",
      origin_id: tenant?.marketplace_id ?? null,
      enabled: true,
      spec,
    };

    // Upsert
    const { data: existing } = await s
      .from("agent_definitions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("slug", agent.slug)
      .maybeSingle();

    if (existing) {
      const { error } = await s.from("agent_definitions").update(row).eq("id", existing.id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action: "updated", slug: agent.slug });
    }

    const { error } = await s.from("agent_definitions").insert(row);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, action: "created", slug: agent.slug });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
