/**
 * Skills update detection — Phase 5 Slice F.
 *
 * Per-origin logic for "is there a newer version of this installed
 * skill?" and "apply the newer version, snapshotting the new body".
 * Custom skills have no upstream and are skipped.
 *
 *   built-in       — match factory_skills.slug → built_in_skills.slug,
 *                    compare semantic versions.
 *   github-import  — re-resolve the original ref to a SHA via GitHub
 *                    API; if the new SHA differs from
 *                    source_commit_sha, there's an update.
 *   marketplace    — look up the listing by id (extracted from
 *                    source_url=marketplace://<id>), compare its
 *                    metadata.published_at against source_version.
 *
 * Failures are per-item (network, listing deleted, etc.) and reported
 * via the `error` field — the batch never throws.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchSkillFromGitHub,
  parseGitHubUrl,
  GitHubImportError,
} from "@/lib/github-skill-import";

// The route handlers' serviceClient() and the helpers here both work with
// the public schema. SupabaseClient with its default generics is the
// loosest shape that still flows through the .from(...).select(...) chain
// without typing every column individually.
type Sb = SupabaseClient;

export interface FactorySkillRow {
  id:                string;
  factory_id:        string;
  project_id:        string | null;
  slug:              string;
  name:              string;
  origin:            string;
  source_url:        string | null;
  source_version:    string | null;
  source_commit_sha: string | null;
  body:              string;
  category:          string;
  description:       string;
  updated_at:        string;
  created_at:        string;
}

export interface UpdateCheckResult {
  skill_id:        string;
  origin:          string;
  has_update:      boolean;
  current_version: string | null;
  latest_version:  string | null;
  reason?:         string;
  error?:          string;
}

export async function checkSkillUpdate(sb: Sb, skill: FactorySkillRow): Promise<UpdateCheckResult> {
  const base = { skill_id: skill.id, origin: skill.origin, current_version: skill.source_version, latest_version: null as string | null, has_update: false };
  try {
    switch (skill.origin) {
      case "built-in":      return await checkBuiltIn(sb, skill);
      case "github-import": return await checkGitHubImport(skill);
      case "marketplace":   return await checkMarketplace(sb, skill);
      default:              return { ...base, reason: "Custom skills don't track an upstream — edits are local." };
    }
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

async function checkBuiltIn(sb: Sb, skill: FactorySkillRow): Promise<UpdateCheckResult> {
  const { data: catalog } = await sb
    .from("built_in_skills")
    .select("version, slug")
    .eq("slug", skill.slug)
    .maybeSingle();
  if (!catalog) {
    return {
      skill_id: skill.id, origin: skill.origin, has_update: false,
      current_version: skill.source_version, latest_version: null,
      reason: "No catalog row matches this slug — skill may have been deprecated.",
    };
  }
  const latest  = catalog.version as string;
  const current = skill.source_version ?? "0.0.0";
  return {
    skill_id: skill.id, origin: skill.origin,
    has_update:      compareSemver(latest, current) > 0,
    current_version: current,
    latest_version:  latest,
  };
}

async function checkGitHubImport(skill: FactorySkillRow): Promise<UpdateCheckResult> {
  if (!skill.source_url || !skill.source_version) {
    return {
      skill_id: skill.id, origin: skill.origin, has_update: false,
      current_version: skill.source_commit_sha, latest_version: null,
      reason: "Missing source_url or source_version — can't probe for updates.",
    };
  }
  // source_url has the install-time SHA baked into /blob/<sha>/.
  // To check upstream, replace ref with the original branch (source_version)
  // and re-resolve via GitHub. Reusing fetchSkillFromGitHub is the simplest
  // path even if it costs the body fetch — the response is small and cached
  // by the operator action sequence (check → apply usually back-to-back).
  const branchUrl = rewriteRefInBlobUrl(skill.source_url, skill.source_version);
  const fetched   = await fetchSkillFromGitHub(branchUrl);
  return {
    skill_id: skill.id, origin: skill.origin,
    has_update:      fetched.sha !== skill.source_commit_sha,
    current_version: shortSha(skill.source_commit_sha),
    latest_version:  shortSha(fetched.sha),
  };
}

async function checkMarketplace(sb: Sb, skill: FactorySkillRow): Promise<UpdateCheckResult> {
  if (!skill.source_url?.startsWith("marketplace://")) {
    return {
      skill_id: skill.id, origin: skill.origin, has_update: false,
      current_version: skill.source_version, latest_version: null,
      reason: "Malformed source_url — can't locate the listing.",
    };
  }
  const listingId = skill.source_url.replace("marketplace://", "");
  const { data: listing } = await sb
    .from("marketplace_listings")
    .select("status, metadata")
    .eq("id", listingId)
    .maybeSingle();
  if (!listing) {
    return {
      skill_id: skill.id, origin: skill.origin, has_update: false,
      current_version: skill.source_version, latest_version: null,
      reason: "Marketplace listing has been deleted by the publisher.",
    };
  }
  if (listing.status !== "active") {
    return {
      skill_id: skill.id, origin: skill.origin, has_update: false,
      current_version: skill.source_version, latest_version: null,
      reason: `Listing is ${listing.status} — no further updates from publisher.`,
    };
  }
  const meta = (listing.metadata as Record<string, unknown> | null) ?? {};
  const latestPublishedAt = meta.published_at as string | undefined;
  if (!latestPublishedAt) {
    return {
      skill_id: skill.id, origin: skill.origin, has_update: false,
      current_version: skill.source_version, latest_version: null,
      reason: "Listing is missing published_at — can't compare versions.",
    };
  }
  return {
    skill_id: skill.id, origin: skill.origin,
    has_update:      !skill.source_version || latestPublishedAt > skill.source_version,
    current_version: skill.source_version,
    latest_version:  latestPublishedAt,
  };
}

// ── Apply ────────────────────────────────────────────────────────────────

export interface ApplyResult {
  ok:               true;
  skill_id:         string;
  origin:           string;
  applied_version:  string;
  new_body_length:  number;
}

export async function applySkillUpdate(sb: Sb, skill: FactorySkillRow): Promise<ApplyResult> {
  switch (skill.origin) {
    case "built-in":      return applyBuiltIn(sb, skill);
    case "github-import": return applyGitHubImport(sb, skill);
    case "marketplace":   return applyMarketplace(sb, skill);
    default:
      throw new Error(`Custom skills can't be updated — they have no upstream.`);
  }
}

async function applyBuiltIn(sb: Sb, skill: FactorySkillRow): Promise<ApplyResult> {
  const { data: catalog } = await sb
    .from("built_in_skills")
    .select("name, description, body, category, allowed_tools, source_url, version")
    .eq("slug", skill.slug)
    .maybeSingle();
  if (!catalog) throw new Error("Catalog row no longer exists for this slug.");

  const { error } = await sb
    .from("factory_skills")
    .update({
      name:           catalog.name,
      description:    catalog.description,
      body:           catalog.body,
      category:       catalog.category,
      allowed_tools:  catalog.allowed_tools ?? [],
      source_url:     catalog.source_url,
      source_version: catalog.version,
    })
    .eq("id", skill.id);
  if (error) throw new Error(error.message);

  return {
    ok: true, skill_id: skill.id, origin: skill.origin,
    applied_version: catalog.version as string,
    new_body_length: (catalog.body as string).length,
  };
}

async function applyGitHubImport(sb: Sb, skill: FactorySkillRow): Promise<ApplyResult> {
  if (!skill.source_url || !skill.source_version) {
    throw new Error("Missing source_url or source_version — can't update.");
  }
  const branchUrl = rewriteRefInBlobUrl(skill.source_url, skill.source_version);
  const fetched   = await fetchSkillFromGitHub(branchUrl);

  const { error } = await sb
    .from("factory_skills")
    .update({
      // Preserve the operator's category / disable-flags / model override —
      // those are local UX choices, not upstream truth. The body and
      // metadata baked into the file are upstream truth.
      name:                     fetched.frontmatter.name        ?? skill.name,
      description:              fetched.frontmatter.description ?? skill.description,
      body:                     fetched.body,
      allowed_tools:            fetched.frontmatter.allowedTools,
      source_url:               fetched.htmlUrl,
      source_commit_sha:        fetched.sha,
      source_version:           fetched.ref.ref,
    })
    .eq("id", skill.id);
  if (error) throw new Error(error.message);

  return {
    ok: true, skill_id: skill.id, origin: skill.origin,
    applied_version: shortSha(fetched.sha) ?? fetched.sha,
    new_body_length: fetched.body.length,
  };
}

async function applyMarketplace(sb: Sb, skill: FactorySkillRow): Promise<ApplyResult> {
  if (!skill.source_url?.startsWith("marketplace://")) {
    throw new Error("Malformed source_url for marketplace skill.");
  }
  const listingId = skill.source_url.replace("marketplace://", "");
  const { data: listing } = await sb
    .from("marketplace_listings")
    .select("status, metadata")
    .eq("id", listingId)
    .maybeSingle();
  if (!listing) throw new Error("Marketplace listing no longer exists.");
  if (listing.status !== "active") throw new Error(`Listing is ${listing.status} — can't update from it.`);
  const meta = (listing.metadata as Record<string, unknown> | null) ?? {};
  const sourceSkillId = meta.source_skill_id as string | undefined;
  if (!sourceSkillId) throw new Error("Listing is malformed — missing source_skill_id.");

  // Read the publisher's current skill row (note: cross-tenant read is OK
  // because marketplace publishing implies public availability).
  const { data: source } = await sb
    .from("factory_skills")
    .select("name, description, body, category, allowed_tools")
    .eq("id", sourceSkillId)
    .maybeSingle();
  if (!source) throw new Error("Publisher's source skill has been deleted.");

  const newVersion = (meta.published_at as string | undefined) ?? new Date().toISOString();

  const { error } = await sb
    .from("factory_skills")
    .update({
      name:           source.name,
      description:    source.description,
      body:           source.body,
      category:       source.category,
      allowed_tools:  source.allowed_tools ?? [],
      source_version: newVersion,
    })
    .eq("id", skill.id);
  if (error) throw new Error(error.message);

  return {
    ok: true, skill_id: skill.id, origin: skill.origin,
    applied_version: newVersion,
    new_body_length: (source.body as string).length,
  };
}

// ── Utilities ────────────────────────────────────────────────────────────

function compareSemver(a: string, b: string): number {
  // Naive semver: compares dotted numerics, ignores prerelease tags.
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function shortSha(sha: string | null): string | null {
  if (!sha) return null;
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

/**
 * Rewrites the ref segment of a GitHub blob URL. Used to swap the
 * install-time SHA back to the operator-original branch name so the
 * commits API resolves the latest commit of that branch.
 *
 * Tolerates URLs that already have a non-SHA ref (no-op in that case
 * since parseGitHubUrl will accept either).
 */
function rewriteRefInBlobUrl(url: string, newRef: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
    // /{owner}/{repo}/blob/{ref}/{...path}
    if (segs.length >= 4 && (segs[2] === "blob" || segs[2] === "tree")) {
      segs[3] = newRef;
      u.pathname = "/" + segs.join("/");
      return u.toString();
    }
  } catch { /* fall through */ }
  return url;
}

// Unused but exported in case consumers want to validate URL shapes.
export { parseGitHubUrl, GitHubImportError };
