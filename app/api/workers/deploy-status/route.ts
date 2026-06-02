/**
 * GET /api/workers/deploy-status?tenantId=…
 *
 * Returns the most recent Trigger.dev deployment for the tenant's
 * worker project. Used by the /status page so users can confirm
 * which worker version is live on Trigger.dev cloud without leaving
 * the platform.
 *
 * Uses Trigger.dev's Management API:
 *   GET https://api.trigger.dev/api/v1/deployments
 *   Authorization: Bearer <tr_prod_... | tr_dev_...>
 *
 * The secret key is already scoped to a single project+environment,
 * so no projectId is required in the URL. We prefer the prod key; if
 * the tenant only has a dev key, we fall back to that so the row
 * still renders something useful.
 *
 * Auth: Bearer {supabase access_token} — caller must be a tenant
 * member.
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

async function assertMember(req: NextRequest, tenantId: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: member } = await sb
    .from("tenant_members")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .single();
  if (!member) throw new Error("Forbidden");
  return sb;
}

async function readTriggerSecret(
  sb: ReturnType<typeof serviceClient>,
  tenantId: string,
  varName: string,
): Promise<string | null> {
  const { data } = await sb
    .from("tenant_integrations")
    .select("secret_value")
    .eq("tenant_id", tenantId)
    .eq("service_id", "trigger")
    .eq("var_name", varName)
    .maybeSingle();
  return (data?.secret_value as string | null) ?? null;
}

interface Deployment {
  id?:             string;
  shortCode?:      string;
  version?:        string;
  status?:         string;
  createdAt?:      string;
  deployedAt?:     string;
  runtime?:        string;
  runtimeVersion?: string;
}

export async function GET(req: NextRequest) {
  const tenantId = req.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

  try {
    const sb = await assertMember(req, tenantId);

    // Prefer the prod key (that's what `workers deploy` pushes to).
    // Fall back to the dev key so workspaces running only in dev still
    // get useful state.
    const [projectId, prodKey, devKey] = await Promise.all([
      readTriggerSecret(sb, tenantId, "TRIGGER_PROJECT_ID"),
      readTriggerSecret(sb, tenantId, "TRIGGER_PROD_SECRET_KEY"),
      readTriggerSecret(sb, tenantId, "TRIGGER_DEV_SECRET_KEY"),
    ]);

    const secretKey = prodKey ?? devKey;
    const environment: "prod" | "dev" = prodKey ? "prod" : "dev";

    if (!secretKey) {
      return NextResponse.json({
        configured: false,
        reason: "No Trigger.dev secret key set. Configure TRIGGER_PROD_SECRET_KEY or TRIGGER_DEV_SECRET_KEY under Integrations → Processing.",
      });
    }

    // page[size]=1 returns the most recent deployment for the env the
    // secret key is scoped to.
    const res = await fetch(
      `${TRIGGER_API}/api/v1/deployments?page%5Bsize%5D=1`,
      {
        headers: { Authorization: `Bearer ${secretKey}` },
        cache: "no-store",
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json({
        configured: true,
        projectId,
        environment,
        error: `Trigger.dev API returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
      });
    }

    const body = (await res.json()) as { data?: Deployment[] };
    const deployment = body.data?.[0] ?? null;

    // Cross-reference with worker_deployments — populated by the CLI
    // after `workers deploy` succeeds. Tells us which CLI bundle
    // version was last shipped to this env so /status can flag
    // outdated workers by comparing with npm.
    let deployedCliVersion: string | null = null;
    let deployedCliAt:      string | null = null;
    try {
      const { data: depRow } = await sb
        .from("worker_deployments")
        .select("cli_version, deployed_at, factory_id")
        .eq("tenant_id", tenantId)
        .eq("env", environment)
        .order("deployed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (depRow) {
        deployedCliVersion = (depRow.cli_version as string) ?? null;
        deployedCliAt      = (depRow.deployed_at as string) ?? null;
      }
    } catch { /* ignore — optional data */ }

    return NextResponse.json({
      configured: true,
      projectId,
      environment,
      deployment,
      deployedCliVersion,
      deployedCliAt,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === "Unauthorized") return NextResponse.json({ error: msg }, { status: 401 });
    if (msg === "Forbidden")    return NextResponse.json({ error: msg }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
