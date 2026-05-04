/**
 * DELETE /api/knowledge/[instanceId]/sources/[sourceId] — remove source (cascade)
 * POST   /api/knowledge/[instanceId]/sources/[sourceId] — re-index source
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

/* ─── DELETE — remove source ─────────────────────────────────── */

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string; sourceId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { instanceId, sourceId } = await params;
    await assertAccess(sb, user.id, instanceId);

    // Verify source belongs to instance
    const { data: source } = await sb
      .from("knowledge_sources")
      .select("id")
      .eq("id", sourceId)
      .eq("instance_id", instanceId)
      .maybeSingle();
    if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });

    // ON DELETE CASCADE handles chunks
    const { error } = await sb
      .from("knowledge_sources")
      .delete()
      .eq("id", sourceId);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, deleted: sourceId });
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}

/* ─── POST — re-index source ────────────────────────────────── */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string; sourceId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { instanceId, sourceId } = await params;
    const instance = await assertAccess(sb, user.id, instanceId);

    // Verify source belongs to instance
    const { data: source } = await sb
      .from("knowledge_sources")
      .select("id, name, type, status")
      .eq("id", sourceId)
      .eq("instance_id", instanceId)
      .maybeSingle();
    if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });

    // Parse body for indexEnv preference
    let indexEnv: "prod" | "dev" = "prod";
    try {
      const body = await req.json().catch(() => ({})) as { indexEnv?: string };
      if (body.indexEnv === "dev") indexEnv = "dev";
    } catch { /* no body is fine */ }

    const triggerKey = await getTriggerKey(sb, instance.tenant_id as string, indexEnv === "dev");
    if (!triggerKey) {
      return NextResponse.json({ error: "Trigger.dev key not configured" }, { status: 400 });
    }

    // Dispatch re-index task
    const triggerRes = await fetch(`${TRIGGER_API}/api/v1/tasks/index-knowledge-source/trigger`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${triggerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payload: {
          sourceId,
          instanceId,
          tenantId: instance.tenant_id,
        },
      }),
    });

    if (!triggerRes.ok) {
      const detail = await triggerRes.text().catch(() => "unknown");
      throw new Error(`Trigger.dev dispatch failed: ${detail}`);
    }

    // Mark source as indexing
    await sb
      .from("knowledge_sources")
      .update({ status: "indexing", error_message: null, updated_at: new Date().toISOString() })
      .eq("id", sourceId);

    return NextResponse.json({
      source: { id: source.id, name: source.name, type: source.type, status: "indexing" },
    });
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}

/* ─── PATCH — update source status (pause/unpause) ─────────── */

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string; sourceId: string }> },
) {
  try {
    const { user, sb } = await getUser(req);
    const { instanceId, sourceId } = await params;
    await assertAccess(sb, user.id, instanceId);

    const body = await req.json() as { status?: string; name?: string; config?: Record<string, unknown>; clearError?: boolean };

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.status) {
      if (!["paused", "pending", "indexed"].includes(body.status)) {
        return NextResponse.json({ error: "status must be 'paused', 'pending', or 'indexed'" }, { status: 400 });
      }
      updates.status = body.status;
    }
    if (body.name?.trim()) {
      updates.name = body.name.trim();
    }
    if (body.config && typeof body.config === "object") {
      updates.config = body.config;
    }
    if (body.clearError) {
      updates.error_message = null;
    }
    if (Object.keys(updates).length <= 1) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    await sb
      .from("knowledge_sources")
      .update(updates)
      .eq("id", sourceId)
      .eq("instance_id", instanceId);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}
