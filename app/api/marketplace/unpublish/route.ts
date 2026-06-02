/**
 * POST /api/marketplace/unpublish
 *
 * Removes a factory's marketplace listing. The verified repo binding
 * remains; the factory is simply not advertised.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { MarketplaceFactoryPublishSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function assertFactoryAdmin(sb: SupabaseClient, userId: string, factoryId: string) {
  const { data: factory } = await sb.from("factories").select("id, tenant_id").eq("id", factoryId).maybeSingle();
  if (!factory) throw new NotFoundError("Factory not found");
  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", factory.tenant_id).eq("user_id", userId).maybeSingle();
  if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
    throw new ForbiddenError("Caller is not an admin of this factory's tenant");
  }
  return { factory };
}

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, MarketplaceFactoryPublishSchema);
    const { user, sb } = await getOperatorUser(req);
    const { factory } = await assertFactoryAdmin(sb, user.id, body.factoryId);

    const { data: repo } = await sb
      .from("factory_repos")
      .select("id")
      .eq("factory_id", factory.id as string)
      .eq("purpose", "marketplace")
      .maybeSingle();
    if (!repo) return NextResponse.json({ ok: true });

    const { error } = await sb
      .from("marketplace_listings")
      .delete()
      .eq("factory_repo_id", repo.id);
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
