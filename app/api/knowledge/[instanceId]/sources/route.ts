/**
 * POST /api/knowledge/[instanceId]/sources — add a source to an instance
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const TRIGGER_API = "https://api.trigger.dev";

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

async function assertAccess(
  sb: ReturnType<typeof serviceClient>,
  userId: string,
  instanceId: string,
) {
  const { data: instance } = await sb
    .from("knowledge_instances")
    .select("id, tenant_id")
    .eq("id", instanceId)
    .maybeSingle();
  if (!instance) throw Object.assign(new Error("Instance not found"), { status: 404 });

  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", instance.tenant_id).eq("user_id", userId).single();
  if (!member) throw Object.assign(new Error("Forbidden"), { status: 403 });

  return instance;
}

/** Resolve the Trigger.dev secret key for the tenant. */
async function getTriggerKey(
  sb: ReturnType<typeof serviceClient>,
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
    const { user, sb } = await getUser(req);
    const { instanceId } = await params;
    const instance = await assertAccess(sb, user.id, instanceId);

    const body = await req.json() as {
      type: "url" | "document" | "github" | "slack";
      name: string;
      config: Record<string, unknown>;
      autoIndex?: boolean;
      indexEnv?: "prod" | "dev";
    };

    if (!body.type) return NextResponse.json({ error: "type required" }, { status: 400 });
    if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

    const { data: source, error } = await sb
      .from("knowledge_sources")
      .insert({
        instance_id: instanceId,
        type:        body.type,
        name:        body.name.trim(),
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
          const triggerRes = await fetch(`${TRIGGER_API}/api/v1/tasks/index-knowledge-source/trigger`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${triggerKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              payload: {
                sourceId: source!.id,
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
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
