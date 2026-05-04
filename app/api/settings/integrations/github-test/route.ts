/**
 * POST /api/settings/integrations/github-test
 *
 * Validates GitHub credentials by creating a temporary private repo and
 * immediately deleting it. Returns a detailed pass/fail result.
 *
 * Body: { tenantId: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

interface TestStep { name: string; ok: boolean; detail: string }

function ghFetch(path: string, token: string, options?: RequestInit) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tirsa-factory",
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
}

export async function POST(req: NextRequest) {
  let tenantId: string;
  try {
    const body = await req.json() as { tenantId?: string };
    tenantId = body.tenantId ?? "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });

  const steps: TestStep[] = [];
  const sb = getServiceClient();

  // ── 1. Load credentials ───────────────────────────────────────────────────
  let token = "";
  let owner = "";
  try {
    const { data: rows } = await sb
      .from("tenant_integrations")
      .select("var_name, secret_value")
      .eq("tenant_id", tenantId)
      .eq("service_id", "github");

    for (const row of rows ?? []) {
      if (row.var_name === "GITHUB_TOKEN") token = row.secret_value as string;
      if (row.var_name === "GITHUB_OWNER") {
        owner = (row.secret_value as string)
          .replace(/^https?:\/\/github\.com\//i, "")
          .replace(/\/+$/, "")
          .trim();
      }
    }
  } catch (e: unknown) {
    return NextResponse.json({ error: `DB read failed: ${(e as Error).message}` }, { status: 500 });
  }

  if (!token) {
    steps.push({ name: "Credentials", ok: false, detail: "GITHUB_TOKEN not configured in Settings" });
    return NextResponse.json({ ok: false, steps });
  }
  if (!owner) {
    steps.push({ name: "Credentials", ok: false, detail: "GITHUB_OWNER not configured in Settings" });
    return NextResponse.json({ ok: false, steps });
  }
  steps.push({ name: "Credentials", ok: true, detail: `Token present · Owner: ${owner}` });

  // ── 2. Authenticate ───────────────────────────────────────────────────────
  let authLogin = "";
  {
    const authRes = await ghFetch("/user", token);
    if (!authRes.ok) {
      steps.push({
        name: "Authentication",
        ok: false,
        detail: authRes.status === 401
          ? "Token is invalid or expired — generate a new one at github.com/settings/tokens"
          : `Auth failed (HTTP ${authRes.status})`,
      });
      return NextResponse.json({ ok: false, steps });
    }
    const me = await authRes.json() as { login: string };
    authLogin = me.login;

    const scopes = authRes.headers.get("x-oauth-scopes") ?? "";
    const hasRepo = scopes.split(",").map((s) => s.trim()).some((s) => s === "repo");
    const isFineGrained = authRes.headers.get("x-oauth-scopes") === null;

    if (!isFineGrained && !hasRepo) {
      steps.push({
        name: "Authentication",
        ok: false,
        detail: `@${authLogin} authenticated, but PAT is missing the "repo" scope (current: "${scopes || "none"}"). Regenerate at github.com/settings/tokens`,
      });
      return NextResponse.json({ ok: false, steps });
    }
    const scopeNote = isFineGrained ? "fine-grained PAT" : `scopes: ${scopes || "none"}`;
    steps.push({ name: "Authentication", ok: true, detail: `Authenticated as @${authLogin} · ${scopeNote}` });
  }

  // ── 3. Resolve owner type ─────────────────────────────────────────────────
  let ownerType: "org" | "user" = "user";
  {
    const res = await ghFetch(`/users/${encodeURIComponent(owner)}`, token);
    if (!res.ok) {
      steps.push({
        name: "Owner",
        ok: false,
        detail: res.status === 404
          ? `Owner "${owner}" not found — check GITHUB_OWNER in Settings`
          : `Owner lookup failed (HTTP ${res.status})`,
      });
      return NextResponse.json({ ok: false, steps });
    }
    const ownerData = await res.json() as { type: string };
    ownerType = ownerData.type === "Organization" ? "org" : "user";
    steps.push({ name: "Owner", ok: true, detail: `${owner} is a GitHub ${ownerType}` });
  }

  // ── 4. Org access probe ───────────────────────────────────────────────────
  if (ownerType === "org") {
    const probeRes = await ghFetch(`/orgs/${encodeURIComponent(owner)}/repos?per_page=1`, token);
    if (probeRes.status === 403) {
      steps.push({
        name: "Org access",
        ok: false,
        detail: `Token cannot access org "${owner}" (HTTP 403). Authorize PAT for org SSO at github.com/settings/tokens → Configure SSO → Authorize next to ${owner}`,
      });
      return NextResponse.json({ ok: false, steps });
    }
    steps.push({ name: "Org access", ok: true, detail: `Token can read org ${owner}` });
  }

  // ── 5. Create test repo ───────────────────────────────────────────────────
  const testRepoName = `tirsa-perm-test-${Date.now()}`;
  let repoCreated = false;
  {
    const path = ownerType === "org"
      ? `/orgs/${encodeURIComponent(owner)}/repos`
      : "/user/repos";

    const res = await ghFetch(path, token, {
      method: "POST",
      body: JSON.stringify({ name: testRepoName, private: true, auto_init: false, description: "Temporary permission test — safe to delete" }),
    });

    if (!res.ok) {
      let hint = `HTTP ${res.status}`;
      if (res.status === 403) {
        hint = ownerType === "org"
          ? `Cannot create repos in org "${owner}". Check: PAT has "repo" scope, PAT is authorized for org SSO, org allows member repo creation`
          : `Cannot create personal repos. Check PAT has "repo" scope`;
      } else if (res.status === 404) {
        hint = `Org "${owner}" not reachable — authorize PAT for org SSO at github.com/settings/tokens`;
      }
      steps.push({ name: "Create repo", ok: false, detail: `Failed: ${hint}` });
      return NextResponse.json({ ok: false, steps });
    }
    repoCreated = true;
    steps.push({ name: "Create repo", ok: true, detail: `Created ${owner}/${testRepoName}` });
  }

  // ── 6. Cleanup ────────────────────────────────────────────────────────────
  let deleteWarning: string | null = null;
  if (repoCreated) {
    const res = await ghFetch(`/repos/${encodeURIComponent(owner)}/${testRepoName}`, token, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      deleteWarning = `Could not auto-delete ${owner}/${testRepoName} (HTTP ${res.status}). Please delete it manually at github.com/${owner}/${testRepoName}`;
      steps.push({ name: "Cleanup", ok: true, detail: `⚠ ${deleteWarning}` });
    } else {
      steps.push({ name: "Cleanup", ok: true, detail: `Deleted ${owner}/${testRepoName}` });
    }
  }

  const allOk = steps.filter((s) => s.name !== "Cleanup").every((s) => s.ok);
  return NextResponse.json({ ok: allOk, steps, warning: deleteWarning ?? undefined });
}
