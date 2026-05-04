/**
 * POST /api/projects/:id/backlog/generate-from-prd
 *
 * Reads `projects.prd_md` and asks an LLM to extract a flat list of backlog
 * items (title + description). Inserts them as `todo` items with
 * `source = 'wizard-gen'`, appended after any existing items.
 *
 * The endpoint deliberately does NOT replace existing backlog — it only
 * appends. Operators who want a clean slate can clear the kanban manually
 * before generating.
 *
 * Auth model:
 *   - Caller must be a tenant member (owner/admin/member) of the project's
 *     tenant. Same gate the regular backlog POST uses.
 *   - LLM call uses the tenant's own Anthropic API key from
 *     `tenant_integrations` (anthropic.ANTHROPIC_API_KEY). The platform
 *     pays neither the LLM cost nor the API key — tenant-funded execution.
 *
 * Failure modes are mapped to clean status codes:
 *   400 — missing PRD
 *   401 — unauthenticated
 *   403 — not a tenant member or not the right role
 *   404 — project not found
 *   422 — tenant has no ANTHROPIC_API_KEY configured
 *   502 — Anthropic API error / unparseable response
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { BacklogItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_ITEMS = 30;

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertProjectMember(req: NextRequest, projectId: string) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  const { data: project } = await sb
    .from("projects")
    .select("id, factory_id, prd_md, factories!inner(tenant_id)")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) throw new Error("NotFound");
  const tenantId = (project.factories as unknown as { tenant_id: string }).tenant_id;
  const { data: member } = await sb
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
    throw new Error("Forbidden");
  }
  return { sb, user, project, tenantId };
}

interface ExtractedItem { title: string; description?: string }

/** Strict-but-tolerant JSON extraction from a Claude response. */
function parseItems(rawText: string): ExtractedItem[] {
  // Try fenced code block first; fall back to first { … } / [ … ] block.
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidate = (fenceMatch?.[1] ?? rawText).trim();
  // Find the first JSON array — agent may preface with prose.
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  if (arrayStart === -1 || arrayEnd <= arrayStart) {
    throw new Error("LLM response did not contain a JSON array");
  }
  const slice = candidate.slice(arrayStart, arrayEnd + 1);
  const parsed = JSON.parse(slice);
  if (!Array.isArray(parsed)) {
    throw new Error("LLM response is not an array");
  }
  return parsed
    .filter((it): it is ExtractedItem => typeof it === "object" && it !== null && typeof (it as { title?: unknown }).title === "string")
    .map((it) => ({
      title: ((it as { title: string }).title ?? "").trim().slice(0, 200),
      description: typeof (it as { description?: unknown }).description === "string"
        ? ((it as { description: string }).description).slice(0, 4000)
        : undefined,
    }))
    .filter((it) => it.title.length > 0);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const { sb, project, tenantId } = await assertProjectMember(req, projectId);

    const prd = (project.prd_md as string | null)?.trim();
    if (!prd) {
      return NextResponse.json(
        { error: "Project has no PRD. Add a Product Requirements Document in Project Settings, then try again." },
        { status: 400 },
      );
    }

    // Tenant brings their own Anthropic key — the platform never proxies the LLM.
    const { data: integration } = await sb
      .from("tenant_integrations")
      .select("secret_value")
      .eq("tenant_id", tenantId)
      .eq("service_id", "anthropic")
      .eq("var_name", "ANTHROPIC_API_KEY")
      .maybeSingle();
    const apiKey = integration?.secret_value as string | null | undefined;
    if (!apiKey) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY is not configured for this tenant. Add it under Integrations → Providers." },
        { status: 422 },
      );
    }

    const systemPrompt =
      "You are a project planning assistant. The operator wrote a PRD; your job is to break it " +
      "into a flat list of backlog items, each scoped tight enough for a single sprint to address.\n\n" +
      "Output a JSON array (no prose, no markdown beyond the JSON) of objects with fields:\n" +
      "  - title (string, ≤120 chars, imperative present, e.g. \"Add user signup form\")\n" +
      "  - description (string, 1–3 sentences explaining what success looks like)\n\n" +
      "Order items so independent prerequisites come before items that depend on them. " +
      `Maximum ${MAX_ITEMS} items — if the PRD is bigger, cluster smaller details into milestone items. ` +
      "Reply ONLY with the JSON array. No commentary.";

    const userPrompt = `# PRD\n\n${prd}`;

    const llmRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type":      "application/json",
      },
      body: JSON.stringify({
        model:      ANTHROPIC_MODEL,
        max_tokens: 4096,
        system:     systemPrompt,
        messages:   [{ role: "user", content: userPrompt }],
      }),
    });

    if (!llmRes.ok) {
      const detail = await llmRes.text();
      return NextResponse.json(
        { error: `Anthropic API rejected the request: ${detail.slice(0, 300)}` },
        { status: 502 },
      );
    }

    const llmBody = await llmRes.json() as {
      content?: { type: string; text?: string }[];
      usage?:   { input_tokens?: number; output_tokens?: number };
    };
    const text = (llmBody.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    if (!text) {
      return NextResponse.json({ error: "LLM returned empty response" }, { status: 502 });
    }

    let items: ExtractedItem[];
    try {
      items = parseItems(text);
    } catch (e) {
      return NextResponse.json(
        { error: `Failed to parse LLM response: ${(e as Error).message}`, raw: text.slice(0, 1000) },
        { status: 502 },
      );
    }

    if (items.length === 0) {
      return NextResponse.json(
        { error: "LLM produced no usable items. Try refining the PRD with more concrete requirements.", raw: text.slice(0, 1000) },
        { status: 502 },
      );
    }

    // Append: read max order_index in the todo column, gap of 100 between items.
    const { data: lastTodo } = await sb
      .from("project_backlog_items")
      .select("order_index")
      .eq("project_id", projectId)
      .eq("status", "todo")
      .order("order_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    const baseOrder = (lastTodo?.order_index as number | undefined) ?? 0;

    const rows = items.slice(0, MAX_ITEMS).map((it, i) => ({
      project_id:  projectId,
      title:       it.title.slice(0, 200),
      description: it.description ?? null,
      status:      "todo",
      source:      "wizard-gen",
      order_index: baseOrder + (i + 1) * 100,
    }));

    const { data: inserted, error: insErr } = await sb
      .from("project_backlog_items")
      .insert(rows)
      .select("*");
    if (insErr) {
      return NextResponse.json({ error: `Failed to insert items: ${insErr.message}` }, { status: 500 });
    }

    return NextResponse.json({
      generated:  (inserted ?? []).length,
      items:      (inserted ?? []) as BacklogItem[],
      tokens_in:  llmBody.usage?.input_tokens ?? null,
      tokens_out: llmBody.usage?.output_tokens ?? null,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    const status = msg === "Forbidden" ? 403 : msg === "NotFound" ? 404 : msg === "Unauthorized" ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
