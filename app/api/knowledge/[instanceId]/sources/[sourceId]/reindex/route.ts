/**
 * POST /api/knowledge/[instanceId]/sources/[sourceId]/reindex
 * Force re-index: resets status, clears stale state, dispatches new indexation task.
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

async function getTriggerKey(
  sb: ReturnType<typeof serviceClient>,
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
    const { user, sb } = await getUser(req);
    const { instanceId, sourceId } = await params;

    // Verify instance access
    const { data: instance } = await sb
      .from("knowledge_instances")
      .select("id, tenant_id")
      .eq("id", instanceId)
      .maybeSingle();
    if (!instance) return NextResponse.json({ error: "Instance not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members").select("role")
      .eq("tenant_id", instance.tenant_id).eq("user_id", user.id).maybeSingle();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Verify source
    const { data: source } = await sb
      .from("knowledge_sources")
      .select("id, name, type")
      .eq("id", sourceId)
      .eq("instance_id", instanceId)
      .maybeSingle();
    if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });

    // Parse body
    let indexEnv: "prod" | "dev" = "prod";
    try {
      const body = await req.json() as { indexEnv?: string };
      if (body.indexEnv === "dev") indexEnv = "dev";
    } catch { /* no body */ }

    // 1. Force reset status to pending (clears stuck indexing)
    await sb
      .from("knowledge_sources")
      .update({ status: "pending", error_message: null, updated_at: new Date().toISOString() })
      .eq("id", sourceId);

    // 2. Get trigger key
    const triggerKey = await getTriggerKey(sb, instance.tenant_id as string, indexEnv === "dev");
    if (!triggerKey) {
      return NextResponse.json({ error: "Trigger.dev key not configured. Check Orchestration settings." }, { status: 400 });
    }

    // 3. Dispatch task
    const triggerRes = await fetch(`${TRIGGER_API}/api/v1/tasks/index-knowledge-source/trigger`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${triggerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payload: { sourceId },
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
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
