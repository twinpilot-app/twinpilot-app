/**
 * POST /api/factory/repo/configure
 *
 * Upserts a factory ↔ repo binding (factory_repos row) for a given purpose
 * and rotates its verification token. Invalidates `verified_at` — the user
 * must re-verify after any change.
 *
 * Body: {
 *   factoryId: string;
 *   purpose: 'marketplace' | 'storage';
 *   owner: string;
 *   repo: string;
 *   branch?: string;       // default 'main'
 * }
 * Returns: { token: string; filePath: string; purpose: string }
 *
 * Authorization: caller must be owner/admin of the factory's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";

const NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const BRANCH_RE = /^[a-zA-Z0-9_.\-/]+$/;
const ALLOWED_PURPOSES = new Set(["marketplace", "storage"]);

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertFactoryAdmin(req: NextRequest, factoryId: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: factory } = await sb.from("factories").select("id, slug, tenant_id").eq("id", factoryId).maybeSingle();
  if (!factory) throw new Error("NotFound");
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", factory.tenant_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || !["platform_admin", "admin"].includes(member.role)) throw new Error("Forbidden");
  return { sb, factory };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      factoryId?: string; purpose?: string;
      owner?: string; repo?: string; branch?: string;
    };
    const factoryId = body.factoryId?.trim();
    const purpose = body.purpose?.trim().toLowerCase() ?? "";
    const owner = body.owner?.trim();
    const repo = body.repo?.trim();
    const branch = body.branch?.trim() || "main";

    if (!factoryId) return NextResponse.json({ error: "factoryId is required" }, { status: 400 });
    if (!ALLOWED_PURPOSES.has(purpose)) {
      return NextResponse.json({ error: "Invalid purpose" }, { status: 400 });
    }
    if (!owner || !NAME_RE.test(owner)) return NextResponse.json({ error: "Invalid owner" }, { status: 400 });
    if (!repo || !NAME_RE.test(repo)) return NextResponse.json({ error: "Invalid repo" }, { status: 400 });
    if (!BRANCH_RE.test(branch)) return NextResponse.json({ error: "Invalid branch" }, { status: 400 });

    const { sb, factory } = await assertFactoryAdmin(req, factoryId);

    const token = randomUUID().replace(/-/g, "");
    const { error } = await sb
      .from("factory_repos")
      .upsert(
        {
          factory_id: factory.id,
          purpose,
          provider: "github",
          owner,
          name: repo,
          branch,
          verify_token: token,
          verified_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "factory_id,purpose" },
      );
    if (error) throw new Error(error.message);

    return NextResponse.json({
      token,
      filePath: `factories/${factory.slug}/.twinpilot-verify`,
      purpose,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
