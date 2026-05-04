/**
 * GET    /api/factory/harness-presets/:id
 * PATCH  /api/factory/harness-presets/:id
 * DELETE /api/factory/harness-presets/:id
 *
 * BL-26 Phase 4. Per-preset CRUD. Same auth model as the list endpoint:
 * read for any tenant member, write for platform_admin / admin.
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

async function loadPresetWithFactory(
  sb: ReturnType<typeof serviceClient>,
  id: string,
) {
  const { data } = await sb
    .from("harness_presets")
    .select("id, slug, name, description, config, factory_id, created_at, updated_at, factories!inner(tenant_id)")
    .eq("id", id)
    .maybeSingle();
  if (!data) throw new Error("NotFound");
  return data as unknown as {
    id: string; slug: string; name: string; description: string | null;
    config: Record<string, unknown>; factory_id: string;
    created_at: string; updated_at: string;
    factories: { tenant_id: string };
  };
}

async function assertWriteRole(
  sb: ReturnType<typeof serviceClient>,
  userId: string,
  tenantId: string,
) {
  const { data } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
  if (!["platform_admin", "admin"].includes(data.role as string)) throw new Error("Forbidden");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { sb, user } = await requireAuth(req);
    const { id } = await params;
    const preset = await loadPresetWithFactory(sb, id);

    // Read: any tenant member.
    const { data } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", preset.factories.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    return NextResponse.json({
      preset: {
        id: preset.id,
        slug: preset.slug,
        name: preset.name,
        description: preset.description,
        config: preset.config,
        factory_id: preset.factory_id,
        created_at: preset.created_at,
        updated_at: preset.updated_at,
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { sb, user } = await requireAuth(req);
    const { id } = await params;
    const preset = await loadPresetWithFactory(sb, id);
    await assertWriteRole(sb, user.id, preset.factories.tenant_id);

    const body = (await req.json()) as {
      name?: string;
      slug?: string;
      description?: string | null;
      config?: unknown;
    };

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (!body.name.trim()) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
      patch.name = body.name.trim();
    }
    if (body.slug !== undefined) {
      const slug = slugify(body.slug);
      if (!slug) return NextResponse.json({ error: "slug must be at least one alphanumeric char" }, { status: 400 });
      patch.slug = slug;
    }
    if (body.description !== undefined) {
      patch.description = body.description?.trim() || null;
    }
    if (body.config !== undefined) {
      if (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)) {
        return NextResponse.json({ error: "config must be a JSON object" }, { status: 400 });
      }
      patch.config = body.config;
    }

    const { data, error } = await sb
      .from("harness_presets")
      .update(patch)
      .eq("id", id)
      .select("id, slug, name, description, config, factory_id, created_at, updated_at")
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

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { sb, user } = await requireAuth(req);
    const { id } = await params;
    const preset = await loadPresetWithFactory(sb, id);
    await assertWriteRole(sb, user.id, preset.factories.tenant_id);

    const { error } = await sb.from("harness_presets").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
