/**
 * GET  /api/admin/invites — list all invite codes (with target tenant slug)
 * POST /api/admin/invites — generate new invite code
 *
 * Platform admin only. Each invite is bound to:
 *   - email (required) + 8-char code,
 *   - role  (admin|member) — what the new tenant_members row gets,
 *   - tenant slug (optional) — three states:
 *       · empty       → invitee picks any slug at onboard, founder admin
 *       · matches one → join flow, role can be admin or member
 *       · doesn't match → reserves the slug, founder admin
 *
 * For join flow we set invite_codes.tenant_id and inherit the tenant's
 * plan. For new-tenant flow we keep tenant_id NULL and store the
 * (optional) reserved slug + name. New-tenant invites are always
 * 'admin' role since the redeemer is the founder.
 *
 * GET response includes a synthesised `tenant_slug` so the table can
 * show "@acme" instead of "(existing)" for join-flow rows.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { slugify } from "@/lib/slugify";

export const dynamic = "force-dynamic";

const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  if ((user.app_metadata as Record<string, unknown>)?.role !== "admin") throw new Error("Forbidden");
  return user;
}

function generateCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  return code.slice(0, 4) + "-" + code.slice(4);
}

const normalizeSlug = (s: string): string => slugify(s);

export async function GET(req: NextRequest) {
  try {
    await assertAdmin(req);
    const sb = serviceClient();
    const { data, error } = await sb
      .from("invite_codes")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    // Resolve linked tenant slugs in one trip — avoids N tenant lookups
    // on the client.
    const tenantIds = Array.from(new Set(
      (data ?? [])
        .map((c) => c.tenant_id as string | null)
        .filter((id): id is string => !!id),
    ));
    const slugById = new Map<string, string>();
    if (tenantIds.length > 0) {
      const { data: tenants } = await sb
        .from("tenants").select("id, slug").in("id", tenantIds);
      for (const t of tenants ?? []) slugById.set(t.id as string, t.slug as string);
    }

    const codes = (data ?? []).map((c) => ({
      ...c,
      tenant_slug: c.tenant_id ? (slugById.get(c.tenant_id as string) ?? null) : null,
    }));

    return NextResponse.json({ codes });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await assertAdmin(req);
    const body = (await req.json()) as {
      plan?: string;
      email?: string;
      tenantSlug?: string;
      tenantName?: string;
      role?: string;
      expiresInDays?: number;
      maxUses?: number;
    };

    const email = body.email?.trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const rawSlug = (body.tenantSlug ?? "").trim();
    const slug    = rawSlug ? normalizeSlug(rawSlug) : "";

    const role = (body.role ?? "admin").toLowerCase();
    if (!["admin", "member"].includes(role)) {
      return NextResponse.json({ error: "Role must be admin or member" }, { status: 400 });
    }

    const sb = serviceClient();
    const expiresInDays = body.expiresInDays ?? 90;
    const maxUses = body.maxUses ?? 1;
    const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();

    // Resolve the slug. Three branches:
    //   A. slug empty   → new org, slug TBD by invitee, role must be admin
    //   B. slug matches → join existing, role can be admin|member, plan inherited
    //   C. slug typed but no match → new org with reserved slug, role must be admin
    let tenantId:    string | null = null;
    let plan:        string;
    let targetSlug:  string | null = null;
    let targetName:  string | null = null;

    if (slug) {
      const { data: existing } = await sb
        .from("tenants").select("id, name, plan").eq("slug", slug).maybeSingle();

      if (existing) {
        // Branch B — join flow.
        tenantId = existing.id as string;
        plan     = (existing.plan as string) ?? "starter";
      } else {
        // Branch C — reserve the slug for a new tenant. Role must be admin
        // (founders run their own org).
        if (role !== "admin") {
          return NextResponse.json({
            error: "Role must be admin when creating a new org",
          }, { status: 400 });
        }
        plan = body.plan ?? "starter";
        if (!["starter", "pro", "enterprise"].includes(plan)) {
          return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
        }
        targetSlug = slug;
        targetName = body.tenantName?.trim() || null;
      }
    } else {
      // Branch A — slug TBD. Role must be admin (founder).
      if (role !== "admin") {
        return NextResponse.json({
          error: "Role must be admin when creating a new org",
        }, { status: 400 });
      }
      plan = body.plan ?? "starter";
      if (!["starter", "pro", "enterprise"].includes(plan)) {
        return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
      }
      targetName = body.tenantName?.trim() || null;
    }

    const code = generateCode();
    const { data, error } = await sb
      .from("invite_codes")
      .insert({
        code,
        email,
        plan,
        role,
        tenant_id:           tenantId,
        target_tenant_slug:  targetSlug,
        target_tenant_name:  targetName,
        max_uses:            maxUses,
        expires_at:          expiresAt,
        created_by:          user.id,
      })
      .select("id, code, plan, role, max_uses, expires_at, tenant_id, target_tenant_slug, target_tenant_name")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ code: data });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Forbidden" ? 403 : 401 });
  }
}
