/**
 * POST /api/knowledge/[instanceId]/sources — add a source to an instance
 */
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getOperatorUser, parseBody, errorResponse,
  ForbiddenError, NotFoundError,
} from "@/lib/api-helpers";
import { KnowledgeSourceAddSchema } from "@/lib/api-schemas";
import { mintWorkerToken } from "@/lib/worker-jwt";

export const dynamic = "force-dynamic";

const TRIGGER_API = "https://api.trigger.dev";

async function assertAccess(
  sb: SupabaseClient,
  userId: string,
  instanceId: string,
) {
  const { data: instance } = await sb
    .from("knowledge_instances")
    .select("id, tenant_id")
    .eq("id", instanceId)
    .maybeSingle();
  if (!instance) throw new NotFoundError(`Knowledge instance ${instanceId} not found`);

  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", instance.tenant_id).eq("user_id", userId).single();
  if (!member) throw new ForbiddenError(`Caller is not a member of tenant ${instance.tenant_id}`);

  return instance;
}

/** Resolve the Trigger.dev secret key for the tenant. */
async function getTriggerKey(
  sb: SupabaseClient,
  tenantId: string,
  preferDev = false,
): Promise<string | null> {
  // Order depends on caller preference; default prod
  for (const varName of preferDev
    ? ["TRIGGER_DEV_SECRET_KEY", "TRIGGER_PROD_SECRET_KEY", "TRIGGER_SECRET_KEY"]
    : ["TRIGGER_PROD_SECRET_KEY", "TRIGGER_DEV_SECRET_KEY", "TRIGGER_SECRET_KEY"]) {
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
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const { user, sb } = await getOperatorUser(req);
    const { instanceId } = await params;
    const instance = await assertAccess(sb, user.id, instanceId);

    // Validated body — Zod enforces type enum (url/document/github/slack),
    // name 1-200, autoIndex/indexEnv flags. config is freeform per-type
    // and validated downstream by the indexer task.
    const body = await parseBody(req, KnowledgeSourceAddSchema);

    const { data: source, error } = await sb
      .from("knowledge_sources")
      .insert({
        instance_id: instanceId,
        type:        body.type,
        name:        body.name,
        config:      body.config ?? {},
        status:      "pending",
      })
      .select("id, name, type, status")
      .single();

    if (error) throw new Error(error.message);

    // Optionally trigger indexation
    let indexStatus: "dispatched" | "no_trigger_key" | "dispatch_failed" | "skipped" = "skipped";
    let indexError: string | undefined;
    let triggerRunUrl: string | undefined;

    if (body.autoIndex) {
      const triggerKey = await getTriggerKey(sb, instance.tenant_id as string, body.indexEnv === "dev");
      if (!triggerKey) {
        indexStatus = "no_trigger_key";
        indexError = "No Trigger.dev key found. Configure in Orchestration settings.";
      } else {
        try {
          // Mint a tenant-scoped JWT for the worker — index-knowledge.ts
          // wraps indexSource in runWithScopedSupabase so all DB calls run
          // under tenant RLS without ever needing service-role on the worker.
          const minted = mintWorkerToken({
            tenantId:   instance.tenant_id as string,
            ttlSeconds: 60 * 60, // 1h — indexer's maxDuration is 10min
          });
          const triggerRes = await fetch(`${TRIGGER_API}/api/v1/tasks/index-knowledge-source/trigger`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${triggerKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              payload: {
                sourceId:             source!.id,
                supabaseJwt:          minted.token,
                supabaseJwtExpiresAt: minted.expiresAt,
                supabaseUrl:          process.env.NEXT_PUBLIC_SUPABASE_URL,
              },
            }),
          });

          if (triggerRes.ok) {
            const triggerBody = await triggerRes.json().catch(() => ({})) as { id?: string };
            indexStatus = "dispatched";
            if (triggerBody.id) {
              triggerRunUrl = `https://cloud.trigger.dev/runs/${triggerBody.id}`;
            }

            const runUrl = triggerRunUrl ?? "";
            await sb
              .from("knowledge_sources")
              .update({
                status: "indexing",
                error_message: runUrl ? `[run:${runUrl}] Starting indexation…` : "[progress] Starting indexation…",
              })
              .eq("id", source!.id);
            source!.status = "indexing";
          } else {
            const errText = await triggerRes.text().catch(() => "");
            indexStatus = "dispatch_failed";
            indexError = `Trigger.dev returned HTTP ${triggerRes.status}: ${errText.slice(0, 200)}`;
            console.warn("[knowledge/sources] index dispatch failed:", indexError);
          }
        } catch (triggerErr) {
          indexStatus = "dispatch_failed";
          indexError = (triggerErr as Error).message;
          console.warn("[knowledge/sources] index dispatch error:", indexError);
        }
      }
    }

    return NextResponse.json({ source, indexStatus, indexError, triggerRunUrl }, { status: 201 });
  } catch (e: unknown) {
    return errorResponse(e);
  }
}
