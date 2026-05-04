/**
 * GET /api/marketplace/listings/:id
 *   Returns factory listing metadata + a parsed index of agent YAMLs fetched
 *   from the publisher's GitHub repo at
 *   `/factories/{factory_slug}/agents/contracts/*.yaml` (HEAD of the verified
 *   branch). Used by the marketplace detail page to render the Store → Factory
 *   → Agent catalog. Public path — only `visibility='public'` listings are
 *   returned. Authorization: any authenticated user.
 *
 * PATCH /api/marketplace/listings/:id
 *   Body: { visibility: 'public' | 'private' }
 *   Flips the listing's visibility flag without disturbing status. Used by
 *   the Factory Manager Public/Private toggle. Authorization: caller must be
 *   owner/admin of the publisher tenant (the listing.publisher_id).
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import yaml from "js-yaml";

export const dynamic = "force-dynamic";

const AGENTS_DIR = "agents/contracts";
const SKILLS_DIR = "skills";
const PERSONA_PREVIEW_MAX = 280;

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

async function assertAuth(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized");
  const sb = serviceClient();
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error("Unauthorized");
  return { sb, user };
}

async function getCallerTenantIds(sb: ReturnType<typeof serviceClient>, userId: string): Promise<string[]> {
  const { data } = await sb.from("tenant_members").select("tenant_id").eq("user_id", userId);
  return (data ?? []).map((m) => m.tenant_id as string);
}

interface AgentYaml {
  slug: string;
  name?: string;
  version?: string;
  squad?: string;
  level?: string | null;
  origin?: string;
  icon?: string;
  tags?: string[];
  persona?: string;
  tools?: string[];
}

function previewText(text: string | undefined, max = PERSONA_PREVIEW_MAX): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : normalized.slice(0, max - 1).trimEnd() + "…";
}

async function listAgentFiles(
  owner: string,
  repo: string,
  branch: string,
  factorySlug: string,
): Promise<string[]> {
  // GitHub Contents API — list directory
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/factories/${factorySlug}/${AGENTS_DIR}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub list failed (${res.status})`);
  const entries = (await res.json()) as Array<{ name: string; type: string; path: string }>;
  return entries
    .filter((e) => e.type === "file" && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
    .map((e) => e.path);
}

async function fetchYaml(owner: string, repo: string, branch: string, path: string): Promise<AgentYaml | null> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const text = await res.text();
  try {
    return yaml.load(text) as AgentYaml;
  } catch {
    return null;
  }
}

interface SkillFrontmatter {
  name?:                   string;
  description?:            string;
  category?:               string;
  allowed_tools?:          string[];
  disable_model_invocation?: boolean;
}

interface ParsedSkill {
  slug:                     string;
  name:                     string;
  description:              string;
  category:                 string | null;
  allowed_tools:            string[];
  disable_model_invocation: boolean;
  body_preview:             string;
}

/**
 * List skill subdirectories under /factories/{slug}/skills/. Convention
 * mirrors the Anthropic canonical skills repo: each skill is a folder
 * containing SKILL.md (frontmatter YAML + markdown body), with optional
 * sibling assets we ignore for the listing preview. Skill slug = folder
 * name; SKILL.md is the source of truth.
 */
async function listSkillDirs(
  owner: string,
  repo: string,
  branch: string,
  factorySlug: string,
): Promise<string[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/factories/${factorySlug}/${SKILLS_DIR}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
    cache:   "no-store",
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub list (skills) failed (${res.status})`);
  const entries = (await res.json()) as Array<{ name: string; type: string; path: string }>;
  return entries.filter((e) => e.type === "dir").map((e) => e.path);
}

/**
 * Parse a SKILL.md file fetched from GitHub. Frontmatter is YAML
 * between `---` delimiters at the top of the file; everything after
 * is the body markdown. We cap the body preview to ~400 chars for
 * the listing card so the operator gets a feel without scrolling.
 */
function parseSkillFile(slug: string, raw: string): ParsedSkill | null {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    // Skill without frontmatter — fall back to slug as name + first
    // 400 chars of body. Still parseable, just less informative.
    return {
      slug,
      name:                     slug,
      description:              "",
      category:                 null,
      allowed_tools:            [],
      disable_model_invocation: false,
      body_preview:             previewText(raw, 400),
    };
  }
  let parsed: SkillFrontmatter = {};
  try {
    parsed = (yaml.load(fmMatch[1]) as SkillFrontmatter | null) ?? {};
  } catch {
    parsed = {};
  }
  return {
    slug,
    name:                     parsed.name ?? slug,
    description:              parsed.description ?? "",
    category:                 parsed.category ?? null,
    allowed_tools:            Array.isArray(parsed.allowed_tools) ? parsed.allowed_tools : [],
    disable_model_invocation: parsed.disable_model_invocation === true,
    body_preview:             previewText(fmMatch[2], 400),
  };
}

async function fetchSkill(owner: string, repo: string, branch: string, dirPath: string): Promise<ParsedSkill | null> {
  const slug = dirPath.split("/").pop() ?? "";
  const url  = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${dirPath}/SKILL.md`;
  const res  = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const text = await res.text();
  return parseSkillFile(slug, text);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { sb, user } = await assertAuth(req);
    const { id } = await params;

    const { data: listing } = await sb
      .from("marketplace_listings")
      .select("id, name, description, avatar, category_slug, metadata, store_id, factory_repo_id")
      .eq("id", id)
      .eq("status", "active")
      .eq("visibility", "public")
      .maybeSingle();
    if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 });

    const m = (listing.metadata as Record<string, unknown> | null) ?? {};
    const sourceFactoryId = m.source_factory_id as string | undefined;

    // Two paths to source the agent catalog:
    //   1. Repo-backed (legacy / operator-published): fetch YAMLs from
    //      GitHub at /factories/{slug}/agents/contracts/*.yaml.
    //   2. DB-backed (platform-canonical / Built-In): read directly from
    //      agent_definitions where factory_id = source_factory_id. No
    //      GitHub round-trip; the seed migration is the source of truth.
    // A listing must have exactly one of factory_repo_id OR source_factory_id.
    if (!listing.factory_repo_id && !sourceFactoryId) {
      return NextResponse.json({ error: "Listing is not backed by a repo or a source factory" }, { status: 400 });
    }

    const { data: store } = await sb
      .from("marketplace_stores")
      .select("id, slug, name, avatar, verified")
      .eq("id", listing.store_id as string)
      .maybeSingle();

    // Look up which agents from this listing the caller already has in
    // any of their tenants. Two signals merge into installedSlugs:
    //   1. agent_definitions.origin_id = listing.id  — clone-installed agents
    //   2. marketplace_installs (kind='agent') keyed by listing — direct
    //      ref-installed agents
    //   3. marketplace_installs (kind='pipeline') — every step agent of a
    //      pipeline this tenant ref-installed counts as available
    const callerTenantIds = await getCallerTenantIds(sb, user.id);
    const installedSlugs = new Set<string>();
    if (callerTenantIds.length > 0) {
      const { data: installedClones } = await sb
        .from("agent_definitions")
        .select("slug")
        .eq("origin_id", id)
        .in("tenant_id", callerTenantIds);
      for (const r of installedClones ?? []) installedSlugs.add(r.slug as string);

      // Direct agent refs — translate source_id back to slug via the
      // canonical agent_definitions row (typically built-in tenant).
      const { data: agentRefs } = await sb
        .from("marketplace_installs")
        .select("source_id")
        .eq("kind", "agent")
        .eq("listing_id", id)
        .in("tenant_id", callerTenantIds);
      const refAgentIds = (agentRefs ?? []).map((r) => r.source_id as string);
      if (refAgentIds.length > 0) {
        const { data: refAgentRows } = await sb
          .from("agent_definitions")
          .select("slug")
          .in("id", refAgentIds);
        for (const r of refAgentRows ?? []) installedSlugs.add(r.slug as string);
      }

      // Pipeline-derived agent refs — every step's agent slug counts as
      // installed when its parent pipeline ref is in this tenant.
      const { data: pipelineRefs } = await sb
        .from("marketplace_installs")
        .select("source_id")
        .eq("kind", "pipeline")
        .in("tenant_id", callerTenantIds);
      const refPipelineIds = (pipelineRefs ?? []).map((r) => r.source_id as string);
      if (refPipelineIds.length > 0) {
        const { data: refPipelineRows } = await sb
          .from("pipelines")
          .select("steps")
          .in("id", refPipelineIds);
        for (const p of refPipelineRows ?? []) {
          const steps = (p.steps as Array<{ agent?: string }> | null) ?? [];
          for (const s of steps) if (s.agent) installedSlugs.add(s.agent);
        }
      }
    }

    // Skill adoption signals — same shape as agents:
    //  · factory_skills.origin_id = listing.id (clone-installed)
    //  · marketplace_installs (kind='skill') keyed by listing — direct ref-installed
    const installedSkillSlugs = new Set<string>();
    if (callerTenantIds.length > 0) {
      const { data: cloneSkills } = await sb
        .from("factory_skills")
        .select("slug, factories!inner(tenant_id)")
        .eq("origin_id", id)
        .in("factories.tenant_id", callerTenantIds);
      for (const r of cloneSkills ?? []) installedSkillSlugs.add(r.slug as string);

      const { data: skillRefs } = await sb
        .from("marketplace_installs")
        .select("source_id")
        .eq("kind", "skill")
        .eq("listing_id", id)
        .in("tenant_id", callerTenantIds);
      const refSkillIds = (skillRefs ?? []).map((r) => r.source_id as string);
      if (refSkillIds.length > 0) {
        const { data: refSkillRows } = await sb
          .from("factory_skills")
          .select("slug")
          .in("id", refSkillIds);
        for (const r of refSkillRows ?? []) installedSkillSlugs.add(r.slug as string);
      }
    }

    type AgentCard = {
      slug: string;
      name: string;
      icon: string | null;
      squad: string | null;
      level: string | null;
      version: string | null;
      persona_preview: string;
      tools: string[];
      tags: string[];
      installed: boolean;
    };
    type SkillCard = {
      slug:                     string;
      name:                     string;
      description:              string;
      category:                 string | null;
      allowed_tools:            string[];
      disable_model_invocation: boolean;
      body_preview:             string;
      installed:                boolean;
    };
    let agents: AgentCard[] = [];
    let skills: SkillCard[] = [];

    // ── DB-backed path (Built-In) ───────────────────────────────────────
    if (sourceFactoryId && !listing.factory_repo_id) {
      const { data: dbAgents, error: agErr } = await sb
        .from("agent_definitions")
        .select("slug, name, level, squad, version, spec, tags, icon")
        .eq("factory_id", sourceFactoryId);
      if (agErr) {
        return NextResponse.json({
          listing: {
            id: listing.id,
            name: listing.name,
            description: listing.description,
            avatar: listing.avatar,
            category_slug: listing.category_slug,
            store: store ?? null,
            repo: null,
          },
          agents: [],
          warning: `Could not load agents from DB: ${agErr.message}`,
        });
      }
      agents = (dbAgents ?? []).map((a) => {
        const spec = (a.spec as Record<string, unknown> | null) ?? {};
        const description = (spec.description as string | undefined) ?? "";
        return {
          slug:            a.slug as string,
          name:            (a.name as string) ?? (a.slug as string),
          icon:            (a.icon as string | null) ?? null,
          squad:           (a.squad as string | null) ?? null,
          level:           (a.level as string | null) ?? null,
          version:         (a.version as string | null) ?? null,
          persona_preview: previewText(description),
          tools:           Array.isArray(spec.tools) ? (spec.tools as string[]) : [],
          tags:            Array.isArray(a.tags) ? (a.tags as string[]) : [],
          installed:       installedSlugs.has(a.slug as string),
        };
      }).sort((a, b) => a.slug.localeCompare(b.slug));

      // DB-backed skills — same factory, factory_skills table. Built-In
      // skills land here when the canonical built-in factory listing is
      // viewed; tenant-cloned copies are surfaced separately in Studio.
      const { data: dbSkills } = await sb
        .from("factory_skills")
        .select("id, slug, name, description, category, allowed_tools, disable_model_invocation, body")
        .eq("factory_id", sourceFactoryId)
        .is("project_id", null);
      skills = (dbSkills ?? []).map((s) => ({
        slug:                     s.slug as string,
        name:                     (s.name as string) ?? (s.slug as string),
        description:              (s.description as string) ?? "",
        category:                 (s.category as string | null) ?? null,
        allowed_tools:            Array.isArray(s.allowed_tools) ? (s.allowed_tools as string[]) : [],
        disable_model_invocation: (s.disable_model_invocation as boolean) ?? false,
        body_preview:             previewText((s.body as string | undefined), 400),
        installed:                installedSkillSlugs.has(s.slug as string),
      })).sort((a, b) => a.slug.localeCompare(b.slug));

      // Pipelines published by the same store that "belong" to this
      // factory — heuristic: every step's agent slug exists in this
      // factory's agent_definitions. Cleanly filters Built-In Discovery
      // (5 agents all in templates) into the Built-In Templates listing.
      const factoryAgentSlugs = new Set(agents.map((a) => a.slug));
      const { data: pipelineListings } = await sb
        .from("marketplace_listings")
        .select("id, name, description, metadata")
        .eq("store_id", listing.store_id as string)
        .eq("listing_type", "pipeline")
        .eq("status", "active")
        .eq("visibility", "public")
        .order("name");

      type PipelineCard = {
        id:          string;
        name:        string;
        description: string | null;
        intent:      string;
        squad:       string | null;
        steps:       Array<{ step: number | undefined; agent_slug: string; agent_name: string; agent_icon: string | null }>;
        installed:   boolean;
      };

      const pipelines: PipelineCard[] = [];
      let installedListingIds = new Set<string>();
      if (callerTenantIds.length > 0 && pipelineListings && pipelineListings.length > 0) {
        const listingIds = pipelineListings.map((p) => p.id as string);
        // Two adoption signals: legacy clones (transactions row exists)
        // and new refs (marketplace_installs row exists).
        const [{ data: txs }, { data: refs }] = await Promise.all([
          sb.from("marketplace_transactions")
            .select("listing_id")
            .in("buyer_id", callerTenantIds)
            .in("listing_id", listingIds),
          sb.from("marketplace_installs")
            .select("listing_id")
            .eq("kind", "pipeline")
            .in("tenant_id", callerTenantIds)
            .in("listing_id", listingIds),
        ]);
        installedListingIds = new Set([
          ...((txs ?? []).map((t) => t.listing_id as string)),
          ...((refs ?? []).map((r) => r.listing_id as string)),
        ]);
      }

      // Resolve agent display names — reuse the agents we already loaded
      // for this factory; they're the only ones the listing concerns.
      const agentByslug = new Map<string, { name: string; icon: string | null }>();
      for (const a of agents) agentByslug.set(a.slug, { name: a.name, icon: a.icon });

      for (const pl of pipelineListings ?? []) {
        const meta = (pl.metadata as Record<string, unknown> | null) ?? {};
        const sourceId = meta.source_pipeline_id as string | undefined;
        if (!sourceId) continue;
        const { data: srcPl } = await sb
          .from("pipelines").select("steps").eq("id", sourceId).maybeSingle();
        const rawSteps = (srcPl?.steps as Array<{ step?: number; agent?: string }> | null) ?? [];
        // Only include the pipeline if every step's agent lives in this factory.
        const allInFactory = rawSteps.length > 0 && rawSteps.every((s) => s.agent && factoryAgentSlugs.has(s.agent));
        if (!allInFactory) continue;

        pipelines.push({
          id:          pl.id as string,
          name:        pl.name as string,
          description: (pl.description as string | null) ?? null,
          intent:      (meta.intent as string | undefined) ?? "discovery",
          squad:       (meta.squad as string | undefined) ?? null,
          steps: rawSteps.map((s) => {
            const a = s.agent ? agentByslug.get(s.agent) : undefined;
            return {
              step:       s.step,
              agent_slug: s.agent ?? "",
              agent_name: a?.name ?? s.agent ?? "?",
              agent_icon: a?.icon ?? null,
            };
          }),
          installed: installedListingIds.has(pl.id as string),
        });
      }

      return NextResponse.json({
        listing: {
          id: listing.id,
          name: listing.name,
          description: listing.description,
          avatar: listing.avatar,
          category_slug: listing.category_slug,
          store: store ?? null,
          repo: null,  // DB-backed: no repo metadata
        },
        agents,
        pipelines,
        skills,
      });
    }

    // ── Repo-backed path (operator-published) ───────────────────────────
    const repoOwner = m.repo_owner as string | undefined;
    const repoName = m.repo_name as string | undefined;
    const repoBranch = m.repo_branch as string | undefined;
    const factorySlug = m.factory_slug as string | undefined;

    if (!repoOwner || !repoName || !repoBranch || !factorySlug) {
      return NextResponse.json({ error: "Listing metadata incomplete" }, { status: 500 });
    }

    try {
      const [files, skillDirs] = await Promise.all([
        listAgentFiles(repoOwner, repoName, repoBranch, factorySlug),
        listSkillDirs(repoOwner, repoName, repoBranch, factorySlug),
      ]);
      const [parsedAgents, parsedSkills] = await Promise.all([
        Promise.all(files.map((p) => fetchYaml(repoOwner, repoName, repoBranch, p))),
        Promise.all(skillDirs.map((d) => fetchSkill(repoOwner, repoName, repoBranch, d))),
      ]);
      agents = parsedAgents
        .filter((y): y is AgentYaml => !!y && typeof y.slug === "string")
        .map((y) => ({
          slug: y.slug,
          name: y.name ?? y.slug,
          icon: y.icon ?? null,
          squad: y.squad ?? null,
          level: (y.level as string | null) ?? null,
          version: y.version ?? null,
          persona_preview: previewText(y.persona),
          tools: Array.isArray(y.tools) ? y.tools : [],
          tags: Array.isArray(y.tags) ? y.tags : [],
          installed: installedSlugs.has(y.slug),
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
      skills = parsedSkills
        .filter((s): s is ParsedSkill => !!s)
        .map((s) => ({
          ...s,
          installed: installedSkillSlugs.has(s.slug),
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
    } catch (err) {
      return NextResponse.json({
        listing: {
          id: listing.id,
          name: listing.name,
          description: listing.description,
          avatar: listing.avatar,
          category_slug: listing.category_slug,
          store: store ?? null,
          repo: { owner: repoOwner, name: repoName, branch: repoBranch, factory_slug: factorySlug },
        },
        agents:  [],
        skills:  [],
        warning: `Could not load content from GitHub: ${(err as Error).message}`,
      });
    }

    return NextResponse.json({
      listing: {
        id: listing.id,
        name: listing.name,
        description: listing.description,
        avatar: listing.avatar,
        category_slug: listing.category_slug,
        store: store ?? null,
        repo: { owner: repoOwner, name: repoName, branch: repoBranch, factory_slug: factorySlug },
      },
      agents,
      skills,
    });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { sb, user } = await assertAuth(req);
    const { id } = await params;
    const body = (await req.json()) as { visibility?: string };

    if (body.visibility !== "public" && body.visibility !== "private") {
      return NextResponse.json({ error: "visibility must be 'public' or 'private'" }, { status: 400 });
    }

    // Lookup listing → publisher_id is the tenant that owns the listing.
    const { data: listing } = await sb
      .from("marketplace_listings")
      .select("id, publisher_id")
      .eq("id", id)
      .maybeSingle();
    if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 });

    const { data: member } = await sb
      .from("tenant_members")
      .select("role")
      .eq("tenant_id", listing.publisher_id as string)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!member || !["platform_admin", "admin"].includes(member.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await sb
      .from("marketplace_listings")
      .update({ visibility: body.visibility, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, visibility: body.visibility });
  } catch (e: unknown) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg }, { status: msg === "Unauthorized" ? 401 : 500 });
  }
}
