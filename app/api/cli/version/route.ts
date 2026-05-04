/**
 * GET /api/cli/version — reports the latest published version of the CLI npm
 * package driven by the active brand. No server-side cache: each call hits
 * registry.npmjs.org fresh. npm's own CDN handles load; our traffic is
 * bounded by /cli page views which is never the hot path.
 *
 * Always returns 200: when the registry is unreachable or the package is
 * not yet published, returns { available: false } so the UI can degrade
 * gracefully.
 */
import { NextResponse } from "next/server";
import { brand } from "@/lib/brand";

export const dynamic = "force-dynamic";

interface NpmRegistryResponse {
  "dist-tags"?: { latest?: string };
  time?:        Record<string, string>;
  versions?:    Record<string, { version: string }>;
}

export async function GET() {
  const pkg = brand.cli.packageName;
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
      cache: "no-store",
      headers: { Accept: "application/vnd.npm.install-v1+json, application/json" },
    });
    if (!res.ok) {
      return NextResponse.json({ available: false, packageName: pkg });
    }
    const body = (await res.json()) as NpmRegistryResponse;
    const version = body["dist-tags"]?.latest ?? null;
    const publishedAt = version ? (body.time?.[version] ?? null) : null;
    if (!version) {
      return NextResponse.json({ available: false, packageName: pkg });
    }
    return NextResponse.json({
      available:   true,
      packageName: pkg,
      version,
      publishedAt,
    });
  } catch {
    return NextResponse.json({ available: false, packageName: pkg });
  }
}
