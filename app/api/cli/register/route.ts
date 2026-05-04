/**
 * POST /api/cli/register
 * Auth: Bearer <API key>
 * Body: { hostname, os_username, platform, arch?, node_version, cli_version, email? }
 *
 * Registers the CLI install for the API key's (tenant, factory) scope.
 * At most one row per scope exists — a new login from another machine
 * replaces the previous row. Called by the CLI right after a successful
 * browser login (browser-gated, so impossible to spam automatically).
 */
import { NextRequest, NextResponse } from "next/server";
import { authCli } from "@/lib/cli-api-auth";

export const dynamic = "force-dynamic";

interface RegisterBody {
  hostname?:     string;
  os_username?:  string;
  platform?:     string;
  arch?:         string;
  node_version?: string;
  cli_version?:  string;
  email?:        string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as RegisterBody;

  const required: (keyof RegisterBody)[] = ["hostname", "os_username", "platform", "node_version", "cli_version"];
  const missing = required.filter((k) => !body[k]);
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing fields: ${missing.join(", ")}` }, { status: 400 });
  }

  const auth = await authCli(req);
  if (auth instanceof NextResponse) return auth;

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
    hostname:     String(body.hostname).slice(0, 255),
    os_username:  String(body.os_username).slice(0, 255),
    platform:     String(body.platform).slice(0, 32),
    arch:         body.arch ? String(body.arch).slice(0, 32) : null,
    node_version: String(body.node_version).slice(0, 64),
    cli_version:  String(body.cli_version).slice(0, 64),
    email:        body.email ? String(body.email).slice(0, 255) : null,
    last_seen_at: new Date().toISOString(),
  };

  // One per scope — delete any existing row for this (tenant, factory) before inserting.
  // Partial unique indexes prevent duplicates; we explicitly delete to make the
  // replace semantics obvious and avoid the NULL-is-distinct gotcha on upsert.
  let deleteQuery = auth.sb.from("cli_instances").delete().eq("tenant_id", auth.tenantId);
  deleteQuery = factoryId
    ? deleteQuery.eq("factory_id", factoryId)
    : deleteQuery.is("factory_id", null);
  const { error: delErr } = await deleteQuery;
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  const { error: insErr } = await auth.sb.from("cli_instances").insert(row);
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
