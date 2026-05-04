/**
 * GET  /api/pipelines?tenantId=...  — system + tenant custom pipelines
 * POST /api/pipelines               — create custom pipeline (plan-gated)
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const PLAN_MAX_CUSTOM: Record<string, number>   = { starter: Infinity, pro: Infinity, enterprise: Infinity, owner: Infinity };
const PLAN_MAX_STEPS:  Record<string, number>   = { starter: Infinity, pro: Infinity, enterprise: Infinity, owner: Infinity };

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

export async function GET(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const tenantId = req.nextUrl.searchParams.get("tenantId");

    if (!tenantId) return NextResponse.json({ system: [], custom: [], installed: [] });

    // Verify membership
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", tenantId)
      .eq("user_id", user.id)
      .single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // 1. Tenant pipelines (type='custom') — operator-authored or clones.
    const { data: customs, error: cErr } = await sb
      .from("pipelines")
      .select("id, slug, name, description, type, category, plan_required, steps, is_active, created_at, factory_id, tenant_id, intent, origin_id")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("created_at");
    if (cErr) throw new Error(cErr.message);

    // 2. Installed pipelines (refs) — canonical pipelines this tenant
    //    adopted via marketplace install (mode='install'). Migration 171.
    //    Each ref resolves to the canonical row in pipelines (typically
    //    tenant_id IS NULL); we annotate with listing_id + install_id so
    //    the UI can render the "via marketplace" treatment + uninstall
    //    handle. Broken refs (canonical deleted upstream) come back with
    //    pipeline=null so the UI can flag them.
    const { data: installs } = await sb
      .from("marketplace_installs")
      .select("id, listing_id, source_id, factory_id, installed_at")
      .eq("tenant_id", tenantId)
      .eq("kind", "pipeline");
    const installedIds = (installs ?? []).map((r) => r.source_id as string);
    const { data: canonicals } = installedIds.length === 0
      ? { data: [] as Array<Record<string, unknown>> }
      : await sb
          .from("pipelines")
          .select("id, slug, name, description, type, category, plan_required, steps, is_active, created_at, factory_id, tenant_id, intent")
          .in("id", installedIds);
    const canonicalById = new Map((canonicals ?? []).map((p) => [p.id as string, p]));
    const installed = (installs ?? []).map((ref) => {
      const canonical = canonicalById.get(ref.source_id as string) ?? null;
      return {
        install_id:    ref.id as string,
        listing_id:    ref.listing_id as string,
        installed_at:  ref.installed_at as string,
        installed_factory_id: (ref.factory_id as string | null) ?? null,
        broken:        canonical === null,
        pipeline:      canonical,
      };
    });

    // 3. System pipelines (tenant_id IS NULL) are NOT returned to clients
    //    that didn't subscribe via install — operators discover them in
    //    the marketplace and adopt explicitly. Filtering keeps the
    //    Studio sidebar focused on "things this tenant can use today".

    return NextResponse.json({
      system:    [] as unknown[],   // legacy field, kept for back-compat
      custom:    customs ?? [],
      installed,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user, sb } = await getUser(req);
    const body = await req.json() as {
      tenantId: string; slug: string; name: string; description?: string;
      category?: string; steps: unknown[]; factoryId?: string; mode?: string;
      intent?: "discovery" | "planning" | "execution" | "review";
    };

    // Verify membership + plan
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", body.tenantId)
      .eq("user_id", user.id)
      .single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data: tenant } = await sb
      .from("tenants")
      .select("plan")
      .eq("id", body.tenantId)
      .single();
    const plan = (tenant?.plan as string) ?? "starter";
    const maxCustom = PLAN_MAX_CUSTOM[plan] ?? Infinity;
    const maxSteps  = PLAN_MAX_STEPS[plan]  ?? Infinity;

    if (maxCustom === 0) {
      return NextResponse.json({ error: "Your plan does not support custom pipelines. Upgrade to Pro." }, { status: 403 });
    }

    // Count existing custom pipelines
    const { count } = await sb
      .from("pipelines")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", body.tenantId);
    if ((count ?? 0) >= maxCustom) {
      return NextResponse.json({ error: `Custom pipeline limit reached (${maxCustom}). Upgrade to Enterprise.` }, { status: 403 });
    }

    if (body.steps.length > maxSteps) {
      return NextResponse.json({ error: `Pipeline too large. Your plan allows up to ${maxSteps} steps.` }, { status: 403 });
    }

    const { data, error } = await sb
      .from("pipelines")
      .insert({
        tenant_id:     body.tenantId,
        factory_id:    body.factoryId ?? null,
        slug:          body.slug,
        name:          body.name,
        description:   body.description ?? null,
        category:      body.category ?? "software-factory",
        type:          "custom",
        plan_required: "starter",
        steps:         body.steps,
        mode:          body.mode ?? "sequential",
        intent:        body.intent ?? "execution",
      })
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ pipeline: data });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
