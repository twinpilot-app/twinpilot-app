/**
 * POST /api/hooks/github-import
 *
 * Persist a GitHub-imported hook into factory_hooks with
 * origin='github-import'. The client posts the blob URL of the source
 * JSON plus the hook id (within that bundle) it picked. We re-fetch
 * the JSON server-side, find the matching entry, and insert.
 *
 * Re-fetching prevents a tampered client payload from smuggling
 * different content; the persisted command/event/matcher reflect the
 * upstream JSON at the pinned blob SHA.
 *
 * Body: { url, factory_id, project_id?, hook_id, slug, name, description? }
 */
import { NextRequest, NextResponse } from "next/server";
import { GitHubImportError } from "@/lib/github-skill-import";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { HooksGithubImportSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const VALID_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "UserPromptSubmit",
  "Notification", "Stop", "SubagentStop",
  "PreCompact", "SessionStart", "SessionEnd",
]);

async function assertFactoryMember(sb: SupabaseClient, userId: string, factoryId: string) {
  const { data: factory } = await sb
    .from("factories").select("tenant_id").eq("id", factoryId).maybeSingle();
  if (!factory) throw new NotFoundError("Factory not found");
  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", factory.tenant_id).eq("user_id", userId).maybeSingle();
  if (!member || !["platform_admin", "admin", "member"].includes(member.role as string)) {
    throw new ForbiddenError("Caller is not a member of this factory's tenant");
  }
}

function authHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  return token
    ? { Authorization: `Bearer ${token}`, "User-Agent": "TwinPilot-hooks-import" }
    : { "User-Agent": "TwinPilot-hooks-import" };
}

interface UpstreamHookCmd { type: "command"; command: string; timeout?: number; description?: string }
interface UpstreamHookGroup { matcher?: string; hooks: UpstreamHookCmd[]; description?: string; id?: string }
interface UpstreamSettings { hooks?: Record<string, UpstreamHookGroup[]> }

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, HooksGithubImportSchema);
    const { user, sb } = await getOperatorUser(req);
    await assertFactoryMember(sb, user.id, body.factory_id);

    // Parse the blob URL — only blobs are supported here because the
    // preview endpoint always emits `/blob/{ref}/{path}` for items.
    const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(body.url.trim());
    if (!m) throw new ValidationError("url must be a github blob URL", []);
    const owner = m[1];
    const repo  = m[2].replace(/\.git$/i, "");
    const ref   = m[3];
    const path  = m[4];

    const fileRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      { headers: { ...authHeaders(), Accept: "application/vnd.github+json" }, cache: "no-store" },
    );
    if (fileRes.status === 404) throw new GitHubImportError(`File not found: ${path}`, 404);
    if (fileRes.status === 403) throw new GitHubImportError("GitHub rate limit hit. Set GITHUB_TOKEN to raise it.", 429);
    if (!fileRes.ok)            throw new GitHubImportError(`GitHub fetch failed (${fileRes.status})`, 502);
    const meta = await fileRes.json() as { content?: string; encoding?: string; sha: string };
    if (!meta.content || meta.encoding !== "base64") {
      throw new GitHubImportError("Unexpected GitHub response shape", 502);
    }
    const raw = Buffer.from(meta.content, "base64").toString("utf-8");

    let parsed: UpstreamSettings;
    try { parsed = JSON.parse(raw) as UpstreamSettings; }
    catch (e) { throw new GitHubImportError(`Invalid JSON: ${(e as Error).message}`, 422); }

    if (!parsed.hooks) {
      throw new ValidationError("No hooks block in source file.", []);
    }

    // Find the matching entry by id.
    let foundEvent: string | null = null;
    let foundGroup: UpstreamHookGroup | null = null;
    let foundCmd:   UpstreamHookCmd   | null = null;
    outer:
    for (const [event, groups] of Object.entries(parsed.hooks)) {
      if (!VALID_EVENTS.has(event)) continue;
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (group.id !== body.hook_id) continue;
        if (!Array.isArray(group.hooks)) continue;
        for (const cmd of group.hooks) {
          if (cmd.type === "command" && cmd.command) {
            foundEvent = event;
            foundGroup = group;
            foundCmd   = cmd;
            break outer;
          }
        }
      }
    }
    if (!foundEvent || !foundGroup || !foundCmd) {
      throw new NotFoundError(`Hook id "${body.hook_id}" not found in ${path} on ${owner}/${repo}@${ref}.`);
    }

    // Slug collision check within scope.
    const scopeFilter = body.project_id
      ? sb.from("factory_hooks")
          .select("id, name")
          .eq("factory_id", body.factory_id)
          .eq("project_id", body.project_id)
          .eq("slug", body.slug)
      : sb.from("factory_hooks")
          .select("id, name")
          .eq("factory_id", body.factory_id)
          .is("project_id", null)
          .eq("slug", body.slug);
    const { data: existing } = await scopeFilter;
    if (existing && existing.length > 0) {
      return NextResponse.json({
        error: `A hook with slug "${body.slug}" already exists in this scope. Pick a different slug or delete first.`,
        code: "CONFLICT",
        existing_id: existing[0].id,
      }, { status: 409 });
    }

    const description =
      body.description?.slice(0, 500) ??
      foundGroup.description?.slice(0, 500) ??
      foundCmd.description?.slice(0, 500) ??
      "";

    const timeout = typeof foundCmd.timeout === "number"
      ? Math.max(1, Math.min(600, foundCmd.timeout))
      : 60;

    const { data: inserted, error: insErr } = await sb
      .from("factory_hooks")
      .insert({
        factory_id:        body.factory_id,
        project_id:        body.project_id ?? null,
        slug:              body.slug,
        name:              body.name,
        description,
        event:             foundEvent,
        matcher:           foundGroup.matcher ?? null,
        command:           foundCmd.command,
        timeout_secs:      timeout,
        origin:            "github-import",
        source_url:        body.url,
        source_commit_sha: meta.sha,
        source_version:    ref,
      })
      .select("*")
      .single();
    if (insErr) throw new Error(insErr.message);

    return NextResponse.json({ ok: true, hook: inserted }, { status: 201 });
  } catch (e) {
    if (e instanceof GitHubImportError) {
      return NextResponse.json({ error: e.message, code: "GITHUB_IMPORT_ERROR" }, { status: e.status });
    }
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
