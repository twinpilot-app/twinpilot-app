/**
 * POST /api/invite/validate
 *
 * Validates an invite code without incrementing usage. The onboard
 * page calls this from step 1 to decide whether the user is joining
 * an existing tenant or creating a new one with a reserved slug.
 *
 * Body:    { code, email, slug }
 * Returns: { valid, plan?, role?, joinTenant?, createTenant?, error? }
 *
 *   joinTenant   = { id, slug, name }   when invite.tenant_id is set
 *   createTenant = { slug, name? }      when invite reserves a slug
 *                                        for a tenant that doesn't
 *                                        exist yet
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

const normalizeSlug = (s: string): string => slugify(s);

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { code?: string; email?: string; slug?: string };
    const code  = body.code?.trim().toUpperCase();
    const email = body.email?.trim().toLowerCase();
    const slug  = normalizeSlug(body.slug ?? "");

    if (!code)  return NextResponse.json({ valid: false, error: "Code is required" });
    if (!email) return NextResponse.json({ valid: false, error: "Email is required" });
    if (!slug)  return NextResponse.json({ valid: false, error: "Org slug is required" });

    const sb = serviceClient();

    const { data: invite, error } = await sb
      .from("invite_codes")
      .select("*")
      .eq("code", code)
      .single();

    if (error || !invite) {
      return NextResponse.json({ valid: false, error: "Invalid code" });
    }
    if (!invite.active) {
      return NextResponse.json({ valid: false, error: "This code has been deactivated" });
    }
    if (new Date(invite.expires_at) < new Date()) {
      return NextResponse.json({ valid: false, error: "Code expired" });
    }
    if (invite.used_count >= invite.max_uses) {
      return NextResponse.json({ valid: false, error: "Code depleted" });
    }
    if (invite.email && invite.email !== email) {
      return NextResponse.json({ valid: false, error: "This code is assigned to a different email" });
    }

    let joinTenant:   { id: string; slug: string; name: string } | null = null;
    let createTenant: { slug: string; name: string | null } | null      = null;

    if (invite.tenant_id) {
      // Join-existing flow — slug must match the bound tenant's slug.
      const { data: tenant } = await sb
        .from("tenants").select("id, slug, name").eq("id", invite.tenant_id as string).maybeSingle();
      if (!tenant) {
        return NextResponse.json({ valid: false, error: "Target tenant no longer exists" });
      }
      if ((tenant.slug as string) !== slug) {
        return NextResponse.json({ valid: false, error: "Org slug does not match this invite" });
      }
      joinTenant = {
        id:   tenant.id   as string,
        slug: tenant.slug as string,
        name: tenant.name as string,
      };
    } else {
      // Create-new flow — slug must match the reserved target slug if one was set.
      const target = (invite.target_tenant_slug as string | null) ?? null;
      if (target && target !== slug) {
        return NextResponse.json({ valid: false, error: "Org slug does not match this invite" });
      }
      // Belt-and-braces: refuse if the slug is already taken — that
      // would force the create-new path to collide.
      const { data: collide } = await sb
        .from("tenants").select("id").eq("slug", slug).maybeSingle();
      if (collide) {
        return NextResponse.json({ valid: false, error: "An org with this slug already exists" });
      }
      createTenant = {
        slug,
        name: (invite.target_tenant_name as string | null) ?? null,
      };
    }

    return NextResponse.json({
      valid: true,
      plan:  invite.plan,
      role:  invite.role ?? "admin",
      expiresAt: invite.expires_at,
      joinTenant,
      createTenant,
    });
  } catch {
    return NextResponse.json({ valid: false, error: "Server error" }, { status: 500 });
  }
}
