/**
 * POST /api/cli/register
 * Auth: Bearer <API key>
 * Body: validated by CliRegisterSchema (lib/api-schemas.ts).
 *
 * Registers the CLI install for the API key's (tenant, factory) scope.
 * At most one row per scope exists — a new login from another machine
 * replaces the previous row.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getCliCaller, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { CliRegisterSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, CliRegisterSchema);
    const auth = await getCliCaller(req);

    const factoryId = auth.factoryId; // null = tenant-wide key

    // Look up the key id to attach (nice for admins; optional).
    const apiKey = req.headers.get("authorization")!.replace("Bearer ", "").trim();
    const { data: keyRow } = await auth.sb
      .from("tenant_api_keys")
      .select("id")
      .eq("key", apiKey)
      .maybeSingle();
    const apiKeyId = (keyRow as { id: string } | null)?.id ?? null;

    const row = {
      tenant_id:    auth.tenantId,
      factory_id:   factoryId,
      api_key_id:   apiKeyId,
      hostname:     body.hostname,
      os_username:  body.os_username,
      platform:     body.platform,
      arch:         body.arch ?? null,
      node_version: body.node_version,
      cli_version:  body.cli_version,
      email:        body.email ?? null,
      last_seen_at: new Date().toISOString(),
    };

    // One per scope — delete any existing row for this (tenant, factory) before inserting.
    let deleteQuery = auth.sb.from("cli_instances").delete().eq("tenant_id", auth.tenantId);
    deleteQuery = factoryId
      ? deleteQuery.eq("factory_id", factoryId)
      : deleteQuery.is("factory_id", null);
    const { error: delErr } = await deleteQuery;
    if (delErr) throw new Error(delErr.message);

    const { error: insErr } = await auth.sb.from("cli_instances").insert(row);
    if (insErr) throw new Error(insErr.message);

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
