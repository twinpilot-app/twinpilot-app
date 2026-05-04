/**
 * POST /api/marketplace/import-skill
 *
 * Per-skill adoption from a factory listing — parallel to
 * /api/marketplace/import for agents. The factory listing exposes
 * skills as sub-items (DB-backed under factory_skills, or repo-backed
 * under /factories/{slug}/skills/{skill}/SKILL.md), and this endpoint
 * lets the operator adopt one skill at a time without installing the
 * whole factory.
 *
 * Two modes (migration 171 + 172):
 *
 *   · INSTALL (ref) — marketplace_installs row only (kind='skill').
 *     Worker materialises the canonical body at sprint dispatch when
 *     the skill is enabled for a project. Updates from the publisher
 *     propagate.
 *   · CLONE (copy) — copies the skill into the tenant's factory_skills
 *     with origin='marketplace' + origin_id stamped. Operator owns +
 *     edits the local copy.
 *
 * Body: {
 *   listingId:        string,                      // factory or skill-only listing
 *   skillSlug:        string,                      // skill to adopt
 *   targetFactoryId:  string,                      // tenant factory to install into
 *   mode?:            "install" | "clone",         // default: install
 *   onConflict?:      "replace" | "cancel"         // for clone slug clashes
 * }
 *
 * Authorization: caller must be admin of the target factory's tenant.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import yaml from "js-yaml";

export const dynamic = "force-dynamic";

const SKILLS_DIR = "skills";

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

interface SkillBody {
  name?:                     string;
  description?:              string;
  category?:                 string | null;
  allowed_tools?:            string[];
  disable_model_invocation?: boolean;
  body:                      string;
}

function parseFrontmatter(raw: string, fallbackSlug: string): SkillBody | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return { name: fallbackSlug, body: raw };
  let parsed: Partial<SkillBody> = {};
  try {
    parsed = (yaml.load(m[1]) as Partial<SkillBody> | null) ?? {};
  } catch {
    parsed = {};
  }
  return {
    name:                     parsed.name ?? fallbackSlug,
    description:              parsed.description ?? "",
    category:                 (parsed.category as string | null | undefined) ?? null,
    allowed_tools:            Array.isArray(parsed.allowed_tools) ? parsed.allowed_tools : [],
    disable_model_invocation: parsed.disable_model_invocation === true,
    body:                     m[2] ?? "",
  };
}

async function fetchSkillFromRepo(
  owner: string,
  repo:  string,
  branch: string,
  factorySlug: string,
  skillSlug:   string,
): Promise<SkillBody | null> {
  const url  = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/factories/${factorySlug}/${SKILLS_DIR}/${skillSlug}/SKILL.md`;
  const res  = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return parseFrontmatter(await res.text(), skillSlug);
}

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = serviceClient();
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json() as {
      listingId?:       string;
      skillSlug?:       string;
      targetFactoryId?: string;
      mode?:            "install" | "clone";
      onConflict?:      "replace" | "cancel";
    };
    const listingId       = body.listingId?.trim();
    const skillSlug       = body.skillSlug?.trim();
    const targetFactoryId = body.targetFactoryId?.trim();
    const mode            = body.mode ?? "install";
    const onConflict      = body.onConflict ?? null;

    if (!listingId || !skillSlug || !targetFactoryId) {
      return NextResponse.json({ error: "listingId, skillSlug, targetFactoryId are required" }, { status: 400 });
    }

    // Authorize target factory
    const { data: factory } = await sb
      .from("factories")
      .select("id, tenant_id")
      .eq("id", targetFactoryId)
      .maybeSingle();
    if (!factory) return NextResponse.json({ error: "Factory not found" }, { status: 404 });
    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", factory.tenant_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member || !["platform_admin", "admin"].includes(member.role as string)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Load the listing — must be public + active
    const { data: listing } = await sb
      .from("marketplace_listings")
      .select("id, listing_type, metadata, factory_repo_id")
      .eq("id", listingId)
      .eq("status", "active")
      .eq("visibility", "public")
      .maybeSingle();
    if (!listing) return NextResponse.json({ error: "Listing not found or not installable" }, { status: 404 });

    // Resolve the source skill — DB-backed (factory listing) or repo-backed.
    const meta = (listing.metadata as Record<string, unknown> | null) ?? {};
    const sourceFactoryId = meta.source_factory_id as string | undefined;
    let sourceSkillId: string | null   = null;
    let sourceSkill:   SkillBody | null = null;

    if (sourceFactoryId && !listing.factory_repo_id) {
      // DB-backed: look up the canonical skill row.
      const { data: row } = await sb
        .from("factory_skills")
        .select("id, name, description, category, allowed_tools, disable_model_invocation, body")
        .eq("factory_id", sourceFactoryId)
        .eq("slug", skillSlug)
        .is("project_id", null)
        .maybeSingle();
      if (!row) return NextResponse.json({ error: `Skill "${skillSlug}" not found in this listing.` }, { status: 404 });
      sourceSkillId = row.id as string;
      sourceSkill = {
        name:                     row.name as string,
        description:              (row.description as string) ?? "",
        category:                 (row.category as string | null) ?? null,
        allowed_tools:            Array.isArray(row.allowed_tools) ? (row.allowed_tools as string[]) : [],
        disable_model_invocation: (row.disable_model_invocation as boolean) ?? false,
        body:                     (row.body as string) ?? "",
      };
    } else if (listing.factory_repo_id) {
      // Repo-backed: fetch SKILL.md, parse, but DON'T have a canonical
      // factory_skills row to ref against. Refs only work for DB-backed
      // listings; repo-backed listings always clone (the publisher's
      // repo IS the source of truth, but we materialise locally because
      // the worker doesn't fetch from GitHub at sprint dispatch).
      if (mode === "install") {
        return NextResponse.json({
          error: "Repo-backed skill listings only support clone mode today. Use mode='clone' to copy the skill into your factory.",
          code:  "REPO_REF_NOT_SUPPORTED",
        }, { status: 422 });
      }
      const repoOwner   = meta.repo_owner   as string | undefined;
      const repoName    = meta.repo_name    as string | undefined;
      const repoBranch  = meta.repo_branch  as string | undefined;
      const factorySlug = meta.factory_slug as string | undefined;
      if (!repoOwner || !repoName || !repoBranch || !factorySlug) {
        return NextResponse.json({ error: "Listing metadata incomplete for repo fetch." }, { status: 500 });
      }
      sourceSkill = await fetchSkillFromRepo(repoOwner, repoName, repoBranch, factorySlug, skillSlug);
      if (!sourceSkill) {
        return NextResponse.json({ error: `Skill "${skillSlug}" not found in publisher repo.` }, { status: 404 });
      }
    } else {
      return NextResponse.json({ error: "Listing is not backed by a repo or a source factory." }, { status: 400 });
    }

    // ── INSTALL (ref) — DB-backed only ────────────────────────────────
    if (mode === "install") {
      if (!sourceSkillId) {
        return NextResponse.json({ error: "Cannot ref-install repo-backed skills." }, { status: 422 });
      }
      // Idempotent: if the same listing + skillSlug already has a ref,
      // return alreadyInstalled. The unique constraint on
      // (tenant_id, listing_id) means we can't have duplicate rows for
      // the SAME listing — but per-skill within a factory listing needs
      // a separate identity. We use a synthetic listing_id key per
      // (listing_id, skill_slug) by stuffing both into a JSON metadata
      // row. To keep the schema clean, we still store the listing_id
      // verbatim and disambiguate by source_id (the canonical skill id).
      const { data: existing } = await sb
        .from("marketplace_installs")
        .select("id")
        .eq("tenant_id", factory.tenant_id)
        .eq("listing_id", listingId)
        .eq("kind", "skill")
        .eq("source_id", sourceSkillId)
        .maybeSingle();
      if (existing) {
        return NextResponse.json({
          ok:               true,
          alreadyInstalled: true,
          installId:        existing.id,
          message:          `Skill "${sourceSkill.name ?? skillSlug}" is already installed.`,
        });
      }
      const { data: inserted, error: insErr } = await sb
        .from("marketplace_installs")
        .insert({
          tenant_id:  factory.tenant_id,
          factory_id: targetFactoryId,
          listing_id: listingId,
          kind:       "skill",
          source_id:  sourceSkillId,
        })
        .select("id")
        .single();
      if (insErr) {
        // Unique violation when this tenant already installed the SAME
        // listing as a different kind (factory listing-wide install).
        // Surface gracefully — caller doesn't care which row wins.
        if ((insErr as { code?: string }).code === "23505") {
          return NextResponse.json({
            ok: true, alreadyInstalled: true,
            message: `Skill already installed as part of this listing.`,
          });
        }
        return NextResponse.json({ error: `Install failed: ${insErr.message}` }, { status: 500 });
      }
      return NextResponse.json({
        ok:        true,
        mode:      "install",
        installId: inserted!.id,
        skillSlug,
        skillName: sourceSkill.name ?? skillSlug,
        message:   `Skill "${sourceSkill.name ?? skillSlug}" installed (reference).`,
      });
    }

    // ── CLONE (copy) ──────────────────────────────────────────────────
    // Detect existing clone in the target factory by slug. Same Slice 3
    // pattern as agents/pipelines.
    const { data: collision } = await sb
      .from("factory_skills")
      .select("id, slug, name")
      .eq("factory_id", targetFactoryId)
      .eq("slug", skillSlug)
      .is("project_id", null)
      .maybeSingle();
    if (collision) {
      if (onConflict === "cancel") {
        return NextResponse.json({
          skipped: true, reason: "conflict-cancel",
          message: `Clone cancelled — kept existing skill "${collision.name}".`,
        });
      }
      if (onConflict !== "replace") {
        return NextResponse.json({
          error: `A skill named "${collision.name}" already exists in this factory.`,
          conflict: {
            kind:          "skill" as const,
            slug:          skillSlug,
            existing_id:   collision.id,
            existing_name: collision.name,
            scope:         "factory",
          },
        }, { status: 409 });
      }
      const { error: delErr } = await sb.from("factory_skills").delete().eq("id", collision.id);
      if (delErr) {
        return NextResponse.json({ error: `Replace failed (delete): ${delErr.message}` }, { status: 500 });
      }
    }

    const { data: cloned, error: cloneErr } = await sb
      .from("factory_skills")
      .insert({
        factory_id:               targetFactoryId,
        project_id:               null,
        slug:                     skillSlug,
        name:                     sourceSkill.name ?? skillSlug,
        description:              sourceSkill.description ?? "",
        category:                 sourceSkill.category ?? null,
        allowed_tools:            sourceSkill.allowed_tools ?? [],
        disable_model_invocation: sourceSkill.disable_model_invocation ?? false,
        body:                     sourceSkill.body,
        origin:                   "marketplace",
        origin_id:                listingId,
      })
      .select("id, slug, name")
      .single();
    if (cloneErr) {
      return NextResponse.json({ error: `Clone failed: ${cloneErr.message}` }, { status: 500 });
    }

    return NextResponse.json({
      ok:        true,
      mode:      "clone",
      skillId:   cloned!.id,
      skillSlug: cloned!.slug,
      skillName: cloned!.name,
      message:   `Skill "${cloned!.name}" cloned into your factory.`,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
