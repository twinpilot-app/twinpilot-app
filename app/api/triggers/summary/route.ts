/**
 * GET /api/triggers/summary
 *
 * Per-source dispatch summary — one row per known trigger source with
 * counts and last-fired-at, scoped to the caller's tenant. Backs the
 * /triggers page (factory-scope view) so the operator sees activity at
 * a glance.
 *
 * Response shape:
 *   {
 *     sources: [
 *       {
 *         id: "manual" | "cli" | "api" | "webhook" | "auto_drain",
 *         total: number,                   // total sprints from this source (all time)
 *         last_30d: number,                // sprints in the last 30 days
 *         last_fired_at: string | null,    // ISO timestamp of most recent sprint
 *         last_project_name: string | null,// the project that last used this source
 *       },
 *       …
 *     ]
 *   }
 *
 * "configured" vs "not yet wired" is a UI concern — every source is
 * always returned, even with zero counts. Renders consistent cards.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const SOURCES = ["manual", "cli", "api", "webhook", "auto_drain"] as const;
type SourceId = typeof SOURCES[number];

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function getUserTenants(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: members } = await sb
    .from("tenant_members")
    .select("tenant_id")
    .eq("user_id", user.id);
  const tenantIds = (members ?? []).map((m) => m.tenant_id as string);
  return { sb, user, tenantIds };
}

interface SourceRow {
  id:                SourceId;
  total:             number;
  last_30d:          number;
  last_fired_at:     string | null;
  last_project_name: string | null;
}

export async function GET(req: NextRequest) {
  try {
    const { sb, tenantIds } = await getUserTenants(req);
    if (tenantIds.length === 0) {
      return NextResponse.json({ sources: SOURCES.map((id) => emptyRow(id)) });
    }

    // Find the projects the caller can see (tenant-scoped via factories).
    const { data: projectRows } = await sb
      .from("projects")
      .select("id, name, factory_id, factories!inner(tenant_id)")
      .in("factories.tenant_id", tenantIds);

    const projects = (projectRows ?? []) as Array<{ id: string; name: string }>;
    const projectIds = projects.map((p) => p.id);
    const projectName = new Map(projects.map((p) => [p.id, p.name]));

    if (projectIds.length === 0) {
      return NextResponse.json({ sources: SOURCES.map((id) => emptyRow(id)) });
    }

    // One sprints query per source — small set (5), keeps the SQL straightforward.
    // Could be refactored to a single GROUP BY query later if it shows up in perf.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sources: SourceRow[] = [];
    for (const id of SOURCES) {
      const [
        { count: total },
        { count: last30d },
        { data: latest },
      ] = await Promise.all([
        sb.from("sprints").select("id", { count: "exact", head: true })
          .in("project_id", projectIds).eq("trigger_source", id),
        sb.from("sprints").select("id", { count: "exact", head: true })
          .in("project_id", projectIds).eq("trigger_source", id)
          .gte("created_at", thirtyDaysAgo),
        sb.from("sprints").select("created_at, project_id")
          .in("project_id", projectIds).eq("trigger_source", id)
          .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ]);

      sources.push({
        id,
        total:             total ?? 0,
        last_30d:          last30d ?? 0,
        last_fired_at:     (latest?.created_at as string | null) ?? null,
        last_project_name: latest?.project_id ? (projectName.get(latest.project_id as string) ?? null) : null,
      });
    }

    return NextResponse.json({ sources });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

function emptyRow(id: SourceId): SourceRow {
  return { id, total: 0, last_30d: 0, last_fired_at: null, last_project_name: null };
}
