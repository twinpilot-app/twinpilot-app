/**
 * GET /api/factory/pip/inception/status?factoryId=...
 *
 * Pre-flight check used by Studio > PIP Manager > Run Inception. Tells
 * the UI whether the operator's tenant has installed the
 * pip-reverse-engineering pipeline listing.
 *
 * Detection follows the canonical ref pattern (CLAUDE.md rule 7): an
 * install is a `marketplace_installs` row pointing at the canonical
 * pipeline. No cloning required — after mig 196 fixed the worker JWT's
 * `tenants WHERE slug='built-in'` lookup, the resolver finds the 7 RE
 * agents in the built-in tenant via the canonical fallback, so a ref
 * install is enough to dispatch.
 *
 * Response 200: { installed, storeSlug: "built-in" }
 *   - installed:  true iff the tenant has a marketplace_installs row
 *                 keyed at the canonical pipeline listing.
 *   - storeSlug:  always "built-in" today; on the response so a future
 *                 third-party publisher can override. The UI deep-links
 *                 to /marketplace/stores/<storeSlug> rather than the
 *                 listing detail page because pipeline-typed listings
 *                 don't have a standalone detail view (they only render
 *                 inside the parent factory listing).
 */
import { NextRequest, NextResponse } from "next/server";
import { getUser, assertMember, errorResponse } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const PIP_PIPELINE_SLUG = "pip-reverse-engineering";

// Mig 200's 5 RE agent slugs. Surfaced for diagnostic / banner detail
// only — the canonical readiness signal is "marketplace_installs row
// for the pipeline listing exists" (covers ref + clone install paths
// uniformly). If we ever surface a missingSlugs hint in the UI again,
// this is the source.
//
// (kept exported so other PIP routes can import it instead of
// duplicating the list)
export const PIP_RE_AGENT_SLUGS = [
  "pip-scout",
  "pip-product-manager",
  "pip-architect",
  "pip-components-builder",
  "pip-composer",
] as const;

export async function GET(req: NextRequest) {
  try {
    const factoryId = new URL(req.url).searchParams.get("factoryId");
    if (!factoryId) {
      return NextResponse.json(
        { error: "factoryId query param is required", code: "VALIDATION_ERROR" },
        { status: 400 },
      );
    }

    const { user, sb } = await getUser(req);
    const { tenantId } = await assertMember(sb, user.id, factoryId, [
      "platform_admin", "admin",
    ]);

    // Resolve the canonical pipeline + its built-in marketplace listing
    // by id (not slug) — mig 193 dedupe-keys the listing on
    // metadata.source_pipeline_id, so resolving via the pipeline.id
    // dodges stale-listing-with-same-slug duplicates from prior reseeds.
    const { data: canonical } = await sb
      .from("pipelines")
      .select("id")
      .eq("slug", PIP_PIPELINE_SLUG)
      .is("tenant_id", null)
      .maybeSingle();

    let installed = false;
    if (canonical?.id) {
      const { data: listing } = await sb
        .from("marketplace_listings")
        .select("id")
        .eq("listing_type", "pipeline")
        .filter("metadata->>source_pipeline_id", "eq", canonical.id as string)
        .eq("status", "active")
        .eq("visibility", "public")
        .maybeSingle();
      if (listing?.id) {
        const { data: install } = await sb
          .from("marketplace_installs")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("listing_id", listing.id as string)
          .maybeSingle();
        installed = !!install;
      }
    }

    return NextResponse.json({
      installed,
      storeSlug: "built-in",
    });
  } catch (e) {
    return errorResponse(e);
  }
}
