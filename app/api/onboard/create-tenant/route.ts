/**
 * POST /api/onboard/create-tenant
 *
 * Two flows depending on the invite code:
 *
 *   1. Create-new: invite_codes.tenant_id IS NULL. Creates auth user
 *      + tenant + tenant_member with the role carried by the invite
 *      (typically 'admin' for the founder).
 *   2. Join-existing: invite_codes.tenant_id IS SET. Creates auth user
 *      and inserts tenant_member against the named tenant with the
 *      role carried by the invite (admin or member).
 *
 * Both paths increment invite usage on success. The tenant slug from
 * the request body is required and must match what the invite expects
 * (already validated upstream by /api/invite/validate; double-checked
 * here so this endpoint stands on its own).
 *
 * Body: {
 *   tenantName?, tenantSlug,  — tenantName only used by create-new
 *   email, password,
 *   inviteCode,
 * }
 *
 * No auth header required — this endpoint creates the user.
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
    const body = await req.json() as {
      tenantName?: string;
      tenantSlug: string;
      email: string;
      password: string;
      inviteCode: string;
    };

    if (!body.email?.trim() || !body.password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }
    if (body.password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }
    if (!body.inviteCode?.trim()) {
      return NextResponse.json({ error: "Invite code is required" }, { status: 400 });
    }
    const slug = normalizeSlug(body.tenantSlug ?? "");
    if (!slug) {
      return NextResponse.json({ error: "Tenant slug is required" }, { status: 400 });
    }

    const sb = serviceClient();
    const email = body.email.trim().toLowerCase();
    const code = body.inviteCode.trim().toUpperCase();

    // 1. Validate invite code.
    const { data: invite, error: invErr } = await sb
      .from("invite_codes")
      .select("*")
      .eq("code", code)
      .single();

    if (invErr || !invite) {
      return NextResponse.json({ error: "Invalid invite code" }, { status: 400 });
    }
    if (!invite.active) {
      return NextResponse.json({ error: "This invite code has been deactivated" }, { status: 400 });
    }
    if (new Date(invite.expires_at) < new Date()) {
      return NextResponse.json({ error: "Invite code expired" }, { status: 400 });
    }
    if (invite.used_count >= invite.max_uses) {
      return NextResponse.json({ error: "Invite code depleted" }, { status: 400 });
    }
    if (invite.email && invite.email !== email) {
      return NextResponse.json({ error: "This code is assigned to a different email" }, { status: 400 });
    }

    const plan       = invite.plan as string;
    const inviteRole = ((invite.role as string | null) ?? "admin").toLowerCase();
    if (!["admin", "member"].includes(inviteRole)) {
      return NextResponse.json({ error: "Invite carries an unsupported role" }, { status: 400 });
    }
    const joinTenantId = (invite.tenant_id as string | null) ?? null;
    const isJoinFlow   = joinTenantId !== null;

    // 2. Slug match against the invite's intent.
    if (isJoinFlow) {
      const { data: target } = await sb
        .from("tenants").select("id, slug").eq("id", joinTenantId).maybeSingle();
      if (!target) {
        return NextResponse.json({ error: "Target tenant no longer exists" }, { status: 404 });
      }
      if ((target.slug as string) !== slug) {
        return NextResponse.json({ error: "Org slug does not match this invite" }, { status: 400 });
      }
    } else {
      const targetSlug = (invite.target_tenant_slug as string | null) ?? null;
      if (targetSlug && targetSlug !== slug) {
        return NextResponse.json({ error: "Org slug does not match this invite" }, { status: 400 });
      }
      const { data: slugCheck } = await sb
        .from("tenants").select("id").eq("slug", slug).maybeSingle();
      if (slugCheck) {
        return NextResponse.json({ error: "Tenant slug already taken" }, { status: 409 });
      }
    }

    // 3. Create auth user (skip email confirmation). If the user already
    //    exists we resume them — typical case is an interrupted onboard.
    let userId: string;

    const { data: authData, error: authErr } = await sb.auth.admin.createUser({
      email,
      password: body.password,
      email_confirm: true,
    });

    if (authErr) {
      const msg = authErr.message.toLowerCase();
      const alreadyExists = msg.includes("already") || msg.includes("registered") || msg.includes("exists");
      if (!alreadyExists) {
        return NextResponse.json({ error: `Account creation failed: ${authErr.message}` }, { status: 500 });
      }

      const { data: existingUsers } = await sb.auth.admin.listUsers();
      const existingUser = existingUsers?.users?.find((u) => u.email === email);
      if (!existingUser) {
        return NextResponse.json({ error: "Account exists but could not be found. Try signing in.", redirect: "/login" }, { status: 409 });
      }

      const { data: existingMembers } = await sb
        .from("tenant_members")
        .select("tenant_id")
        .eq("user_id", existingUser.id);

      if (isJoinFlow) {
        const alreadyMember = (existingMembers ?? []).some((m) => m.tenant_id === joinTenantId);
        if (alreadyMember) {
          return NextResponse.json({
            error: "You're already a member of this org. Please sign in.",
            redirect: "/login",
          }, { status: 409 });
        }
        userId = existingUser.id;
        await sb.auth.admin.updateUserById(userId, { password: body.password });
      } else {
        if (existingMembers && existingMembers.length > 0) {
          return NextResponse.json({ error: "Account already set up. Please sign in.", redirect: "/login" }, { status: 409 });
        }
        userId = existingUser.id;
        await sb.auth.admin.updateUserById(userId, { password: body.password });
      }
    } else {
      userId = authData.user.id;
    }

    // 4. Resolve target tenant — create-new vs join-existing.
    let tenantId: string;
    if (isJoinFlow) {
      tenantId = joinTenantId!;
    } else {
      const tenantName = body.tenantName?.trim()
        || (invite.target_tenant_name as string | null)
        || slug;
      const { data: tenant, error: tErr } = await sb
        .from("tenants")
        .insert({
          name: tenantName,
          slug,
          plan,
          invite_code: code,
          invite_plan: plan,
          invite_expires_at: invite.expires_at,
        })
        .select("id")
        .single();
      if (tErr) {
        await sb.auth.admin.deleteUser(userId);
        return NextResponse.json({ error: `Tenant creation failed: ${tErr.message}` }, { status: 500 });
      }
      tenantId = tenant!.id as string;
    }

    // 5. Link user with the role carried by the invite.
    const { error: mErr } = await sb
      .from("tenant_members")
      .insert({
        tenant_id: tenantId,
        user_id:   userId,
        role:      inviteRole,
      });

    if (mErr) {
      if (!isJoinFlow) {
        await sb.from("tenants").delete().eq("id", tenantId);
        await sb.auth.admin.deleteUser(userId);
      }
      return NextResponse.json({ error: `Member creation failed: ${mErr.message}` }, { status: 500 });
    }

    // 6. Increment invite code usage.
    await sb
      .from("invite_codes")
      .update({ used_count: invite.used_count + 1 })
      .eq("id", invite.id);

    // 7. Mark matching waiting-list leads as converted (best-effort,
    //    create-new only — join doesn't add a tenant to the platform).
    if (!isJoinFlow) {
      await sb
        .from("waiting_list")
        .update({ converted_at: new Date().toISOString(), converted_tenant_id: tenantId })
        .eq("email", email)
        .is("converted_at", null);
    }

    // 8. Notify platform owner.
    try {
      const { createNotification } = await import("@/lib/notifications");
      const { data: owner } = await sb.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
      if (owner) {
        if (isJoinFlow) {
          await createNotification({
            tenantId: owner.id,
            eventType: "tenant_member_joined",
            severity: "info",
            title: `New member joined an org`,
            body: `${email} joined tenant ${tenantId.slice(0, 8)}…`,
            metadata: { tenantId, email, plan, role: inviteRole },
          });
        } else {
          await createNotification({
            tenantId: owner.id,
            eventType: "new_tenant_registered",
            severity: "info",
            title: `New tenant: ${slug}`,
            body: `${email} · plan: ${plan}`,
            metadata: { newTenantId: tenantId, email, plan },
          });
        }
      }
    } catch { /* non-blocking */ }

    return NextResponse.json({ tenantId, plan, joined: isJoinFlow });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
