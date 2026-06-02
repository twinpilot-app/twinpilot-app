/**
 * POST /api/knowledge/[instanceId]/sources/[sourceId]/reindex
 * Force re-index: resets status, clears stale state, dispatches new indexation task.
 */
import { NextRequest, NextResponse } from "next/server";
import { mintWorkerToken } from "@/lib/worker-jwt";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { KnowledgeSourceReindexSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const TRIGGER_API = "https://api.trigger.dev";

async function getTriggerKey(
  sb: SupabaseClient,
  tenantId: string,
  preferDev = false,
): Promise<string | null> {
  const order = preferDev
    ? ["TRIGGER_DEV_SECRET_KEY", "TRIGGER_PROD_SECRET_KEY", "TRIGGER_SECRET_KEY"]
    : ["TRIGGER_PROD_SECRET_KEY", "TRIGGER_DEV_SECRET_KEY", "TRIGGER_SECRET_KEY"];
  for (const varName of order) {
    const { data: row } = await sb
      .from("tenant_integrations")
      .select("secret_value")
      .eq("tenant_id", tenantId)
      .eq("service_id", "trigger")
      .eq("var_name", varName)
      .maybeSingle();
    if (row?.secret_value) return row.secret_value as string;
  }
  return process.env.TRIGGER_SECRET_KEY ?? null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string; sourceId: string }> },
) {
  try {
    const body = await parseBody(req, KnowledgeSourceReindexSchema);
    const { user, sb } = await getOperatorUser(req);
    const { instanceId, sourceId } = await params;

    // Verify instance access
    const { data: instance } = await sb
      .from("knowledge_instances")
      .select("id, tenant_id")
      .eq("id", instanceId)
      .maybeSingle();
    if (!instance) throw new NotFoundError("Instance not found");

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", instance.tenant_id).eq("user_id", user.id).maybeSingle();
    if (!member) throw new ForbiddenError("Caller is not a member of this instance's tenant");

    // Verify source
    const { data: source } = await sb
      .from("knowledge_sources")
      .select("id, name, type")
      .eq("id", sourceId)
      .eq("instance_id", instanceId)
      .maybeSingle();
    if (!source) throw new NotFoundError("Source not found");

    const indexEnv: "prod" | "dev" = body.indexEnv === "dev" ? "dev" : "prod";

    // 1. Force reset status to pending (clears stuck indexing)
    await sb
      .from("knowledge_sources")
      .update({ status: "pending", error_message: null, updated_at: new Date().toISOString() })
      .eq("id", sourceId);

    // 2. Get trigger key
    const triggerKey = await getTriggerKey(sb, instance.tenant_id as string, indexEnv === "dev");
    if (!triggerKey) {
      throw new ValidationError("Trigger.dev key not configured. Check Orchestration settings.", []);
    }

    // 3. Dispatch task — mint tenant JWT so the worker's indexer can run
    // under RLS without service-role on the worker.
    const minted = mintWorkerToken({
      tenantId:   instance.tenant_id as string,
      ttlSeconds: 60 * 60,
    });
    const triggerRes = await fetch(`${TRIGGER_API}/api/v1/tasks/index-knowledge-source/trigger`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${triggerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payload: {
          sourceId,
          supabaseJwt:          minted.token,
          supabaseJwtExpiresAt: minted.expiresAt,
          supabaseUrl:          process.env.NEXT_PUBLIC_SUPABASE_URL,
        },
      }),
    });

    if (!triggerRes.ok) {
      const detail = await triggerRes.text().catch(() => "");
      await sb.from("knowledge_sources")
        .update({ status: "error", error_message: `Dispatch failed: ${detail.slice(0, 200)}` })
        .eq("id", sourceId);
      return NextResponse.json({ error: `Trigger.dev dispatch failed (${triggerRes.status})` }, { status: 502 });
    }

    const triggerBody = await triggerRes.json().catch(() => ({})) as { id?: string };
    const runUrl = triggerBody.id ? `https://cloud.trigger.dev/runs/${triggerBody.id}` : "";

    // 4. Mark as indexing
    await sb
      .from("knowledge_sources")
      .update({
        status: "indexing",
        error_message: runUrl ? `[run:${runUrl}] Starting indexation…` : "[progress] Starting indexation…",
        updated_at: new Date().toISOString(),
      })
      .eq("id", sourceId);

    return NextResponse.json({ ok: true, runUrl });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
