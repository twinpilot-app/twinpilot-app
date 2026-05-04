/**
 * GET  /api/factory/harness-presets?factoryId=…
 * POST /api/factory/harness-presets
 *
 * BL-26 Phase 4 — manages reusable agent harness bundles per factory.
 * A preset is a named JSONB blob of harness tunables (cli, model,
 * max_turns, effort, append_system_prompt, skills_include/exclude, …)
 * that an agent override can reference by id. The worker merges the
 * preset config UNDER the override so the agent's own field-by-field
 * settings always win.
 *
 * Reading: any tenant member.
 * Writing: platform_admin / admin only — presets shape dispatch
 * behaviour for everyone in the factory.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { slugify } from "@/lib/slugify";

export const dynamic = "force-dynamic";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function requireAuth(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { sb, user };
}

async function loadFactory(sb: ReturnType<typeof serviceClient>, factoryId: string) {
  const { data: factory } = await sb
    .from("factories")
    .select("id, tenant_id")
    .eq("id", factoryId)
    .maybeSingle();
  if (!factory) throw new Error("NotFound");
  return factory;
}

async function assertMember(sb: ReturnType<typeof serviceClient>, userId: string, tenantId: string) {
  const { data } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
  return data.role as string;
}

/** Lightly validate the preset config shape. We don't enforce known
 *  keys — the schema is intentionally open — but we do reject obvious
 *  type mismatches that would explode later in the worker. */
function validateConfig(cfg: unknown): cfg is Record<string, unknown> {
  return typeof cfg === "object" && cfg !== null && !Array.isArray(cfg);
}

export async function GET(req: NextRequest) {
  try {
    const { sb, user } = await requireAuth(req);
    const factoryId = new URL(req.url).searchParams.get("factoryId");
    if (!factoryId) return NextResponse.json({ error: "factoryId required" }, { status: 400 });

    const factory = await loadFactory(sb, factoryId);
    await assertMember(sb, user.id, factory.tenant_id as string);

    const { data, error } = await sb
      .from("harness_presets")
      .select("id, slug, name, description, config, created_at, updated_at")
      .eq("factory_id", factoryId)
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);

    return NextResponse.json({ presets: data ?? [] });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { sb, user } = await requireAuth(req);
    const body = (await req.json()) as {
      factoryId?: string;
      name?: string;
      slug?: string;
      description?: string | null;
      config?: unknown;
    };

    if (!body.factoryId) return NextResponse.json({ error: "factoryId required" }, { status: 400 });
    if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
    if (!validateConfig(body.config)) {
      return NextResponse.json({ error: "config must be a JSON object" }, { status: 400 });
    }

    const factory = await loadFactory(sb, body.factoryId);
    const role = await assertMember(sb, user.id, factory.tenant_id as string);
    if (!["platform_admin", "admin"].includes(role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const slug = slugify(body.slug?.trim() || body.name);
    if (!slug) return NextResponse.json({ error: "slug must be at least one alphanumeric char" }, { status: 400 });

    const { data, error } = await sb
      .from("harness_presets")
      .insert({
        factory_id:  body.factoryId,
        slug,
        name:        body.name.trim(),
        description: body.description?.trim() || null,
        config:      body.config,
      })
      .select("id, slug, name, description, config, created_at, updated_at")
      .single();
    if (error) {
      const status = error.message.includes("duplicate") ? 409 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }

    return NextResponse.json({ preset: data });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
