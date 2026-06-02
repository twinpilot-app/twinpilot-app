/**
 * POST /api/agents/import
 *
 * Parses a YAML agent spec and upserts into agent_definitions.
 * Supports both legacy format (persona/sipoc) and new persona model (description/output_types).
 * Body: { tenantId, factoryId, yaml }
 */
import { NextRequest, NextResponse } from "next/server";
import { load as parseYaml } from "js-yaml";
import {
  getOperatorUser, parseBody, errorResponse, ForbiddenError,
} from "@/lib/api-helpers";
import { AgentImportSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

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
    const { user, sb: s } = await getOperatorUser(req);
    // Validated body — Zod enforces uuid for tenantId/factoryId and a
    // 256 KB cap on the YAML payload (fails fast before js-yaml allocates).
    // Structural shape of the parsed YAML is checked DOWNSTREAM since
    // it allows two formats (legacy persona/sipoc vs new persona model).
    const { tenantId, factoryId, yaml } = await parseBody(req, AgentImportSchema);

    // Verify membership
    const { data: member } = await s.from("tenant_members").select("id").eq("tenant_id", tenantId).eq("user_id", user.id).single();
    if (!member) throw new ForbiddenError(`Caller is not a member of tenant ${tenantId}`);

    let agent: YamlAgent;
    try {
      agent = parseYaml(yaml) as YamlAgent;
    } catch (e: unknown) {
      return NextResponse.json({ error: `Invalid YAML: ${(e as Error).message}`, code: "YAML_PARSE_ERROR" }, { status: 400 });
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
    return errorResponse(e);
  }
}
