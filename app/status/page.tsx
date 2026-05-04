"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, Package, Terminal, CheckCircle2, AlertCircle, Cloud } from "lucide-react";
import PageShell from "@/components/PageShell";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";

interface CliVersionInfo {
  available:   boolean;
  packageName: string;
  version?:    string;
  publishedAt?: string | null;
}

interface DeployStatus {
  configured: boolean;
  reason?: string;
  projectId?: string;
  environment?: "prod" | "dev";
  deployment?: {
    shortCode?:  string;
    version?:    string;
    status?:     string;
    createdAt?:  string;
    deployedAt?: string;
  } | null;
  /** CLI bundle version last shipped via `workers deploy`. */
  deployedCliVersion?: string | null;
  deployedCliAt?:      string | null;
  error?: string;
}

/** Semver-like comparator. Returns negative if a < b, 0 if equal, positive if a > b. */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((x) => parseInt(x, 10));
  const pb = b.replace(/^v/, "").split(".").map((x) => parseInt(x, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (Number.isNaN(da) || Number.isNaN(db)) return 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const mins  = Math.round(diffMs / 60_000);
  const hours = Math.round(diffMs / 3_600_000);
  const days  = Math.round(diffMs / 86_400_000);
  if (mins   < 60)  return `${mins}m ago`;
  if (hours  < 24)  return `${hours}h ago`;
  if (days   < 30)  return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12)  return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/**
 * Platform status summary surface. Initial scope is intentionally
 * small — just the two revision tags users ask about most often:
 *   - current platform build (from NEXT_PUBLIC_APP_VERSION)
 *   - latest CLI available on npm (from /api/cli/version)
 *
 * Health probes (Supabase, Trigger.dev, JWT signing) belong here too
 * but live as a follow-up — see memory project_platform_health_and_versioning.
 */
export default function StatusPage() {
  const router = useRouter();
  const { session, tenantId, loading } = useAuth();
  const [cliVersion, setCliVersion] = useState<CliVersionInfo | null>(null);
  const [deploy, setDeploy] = useState<DeployStatus | null>(null);

  useEffect(() => {
    if (!loading && !session) router.replace("/login");
  }, [loading, session, router]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/cli/version")
      .then((r) => r.ok ? r.json() : null)
      .then((body: CliVersionInfo | null) => { if (!cancelled && body) setCliVersion(body); })
      .catch(() => { /* silent — CLI version is optional */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!tenantId || !session) return;
    let cancelled = false;
    fetch(`/api/workers/deploy-status?tenantId=${tenantId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((body: DeployStatus | null) => { if (!cancelled && body) setDeploy(body); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [tenantId, session]);

  if (loading || !session) return null;

  const platformRev = process.env.NEXT_PUBLIC_APP_VERSION;

  return (
    <PageShell
      active="status"
      title="Status"
      description="Platform revision, CLI release, and other at-a-glance system information."
      maxWidth={760}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Platform revision */}
        <StatusRow
          icon={<Activity size={16} color="var(--overlay1)" />}
          title="Platform"
          detail={
            platformRev
              ? <span style={{ fontFamily: "var(--font-mono)", color: "var(--subtext0)" }}>rev. {platformRev}</span>
              : <span style={{ color: "var(--overlay0)" }}>No revision tag configured</span>
          }
          status={platformRev ? "ok" : "warning"}
          footer={
            <>Powered by {brand.holdingName}.</>
          }
        />

        {/* CLI version */}
        <StatusRow
          icon={<Terminal size={16} color="var(--overlay1)" />}
          title={`${brand.shortName} CLI`}
          detail={
            !cliVersion
              ? <span style={{ color: "var(--overlay0)" }}>Checking npm…</span>
              : cliVersion.available && cliVersion.version
                ? <span style={{ fontFamily: "var(--font-mono)", color: "var(--subtext0)" }}>
                    v{cliVersion.version}
                    {cliVersion.publishedAt && <> · published {relativeTime(cliVersion.publishedAt)}</>}
                  </span>
                : <span style={{ color: "var(--peach)" }}>Not yet published on npm</span>
          }
          status={cliVersion?.available ? "ok" : cliVersion ? "warning" : "neutral"}
          footer={
            <>
              Package: <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{cliVersion?.packageName ?? brand.cli.packageName}</code>.
              Install with <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>npm i -g {brand.cli.packageName}</code>.
            </>
          }
        />

        {/* Worker deploy — live state of what's running on Trigger.dev
         *  cloud for this tenant. Pulls the latest deployment via the
         *  tenant's own PAT (same one the CLI uses for `workers status`). */}
        <StatusRow
          icon={<Cloud size={16} color="var(--overlay1)" />}
          title="Worker deploy"
          detail={
            !deploy
              ? <span style={{ color: "var(--overlay0)" }}>Checking Trigger.dev…</span>
              : !deploy.configured
                ? <span style={{ color: "var(--peach)" }}>{deploy.reason ?? "Not configured"}</span>
                : deploy.error
                  ? <span style={{ color: "var(--red)" }}>{deploy.error}</span>
                  : !deploy.deployment
                    ? <span style={{ color: "var(--peach)" }}>No deployments yet — run <code style={{ fontFamily: "var(--font-mono)" }}>{brand.cli.binName} workers deploy</code></span>
                    : (() => {
                        const latestCli   = cliVersion?.version;
                        const deployedCli = deploy.deployedCliVersion ?? null;
                        const isOutdated  = latestCli && deployedCli && compareVersions(deployedCli, latestCli) < 0;
                        return (
                          <span style={{ fontFamily: "var(--font-mono)", color: "var(--subtext0)" }}>
                            {deployedCli ? <>CLI v{deployedCli}</> : <>{deploy.deployment.version ?? deploy.deployment.shortCode ?? "?"}</>}
                            {deploy.environment && <> · {deploy.environment}</>}
                            {deploy.deployment.status && <> · {deploy.deployment.status.toLowerCase()}</>}
                            {(deploy.deployment.deployedAt ?? deploy.deployment.createdAt) && <> · {relativeTime(deploy.deployment.deployedAt ?? deploy.deployment.createdAt!)}</>}
                            {isOutdated && (
                              <span style={{
                                marginLeft: 6, padding: "1px 6px", borderRadius: 4,
                                background: "rgba(245,159,0,0.12)", color: "var(--peach)",
                                fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
                                fontFamily: "var(--font-sans)",
                              }}>
                                outdated → v{latestCli}
                              </span>
                            )}
                          </span>
                        );
                      })()
          }
          status={(() => {
            if (!deploy || !deploy.configured)        return "neutral";
            if (deploy.error || !deploy.deployment)   return "warning";
            if (deploy.deployment.status === "FAILED") return "warning";
            const latestCli   = cliVersion?.version;
            const deployedCli = deploy.deployedCliVersion ?? null;
            if (latestCli && deployedCli && compareVersions(deployedCli, latestCli) < 0) return "warning";
            if (deploy.deployment.status === "DEPLOYED") return "ok";
            return "neutral";
          })()}
          footer={
            deploy?.projectId
              ? <>Project: <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{deploy.projectId}</code>. Redeploy with <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{brand.cli.binName} workers deploy</code>.</>
              : <>Configure <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>TRIGGER_PROJECT_ID</code> and <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>TRIGGER_ACCESS_TOKEN</code> under Integrations → Processing to surface worker state here.</>
          }
        />
      </div>
    </PageShell>
  );
}

/* ─── Row component ─────────────────────────────────────────── */

function StatusRow({
  icon, title, detail, status, footer,
}: {
  icon:   React.ReactNode;
  title:  string;
  detail: React.ReactNode;
  status: "ok" | "warning" | "neutral";
  footer?: React.ReactNode;
}) {
  return (
    <div style={{
      padding: "14px 16px",
      background: "var(--mantle)",
      border: "1px solid var(--surface1)",
      borderRadius: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flexShrink: 0 }}>{icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{title}</div>
          <div style={{ fontSize: 12, marginTop: 2 }}>{detail}</div>
        </div>
        {status === "ok" && <CheckCircle2 size={14} color="var(--green)" />}
        {status === "warning" && <AlertCircle size={14} color="var(--peach)" />}
        {status === "neutral" && <Package size={14} color="var(--overlay0)" />}
      </div>
      {footer && (
        <div style={{
          marginTop: 10, paddingTop: 10,
          borderTop: "1px solid var(--surface0)",
          fontSize: 11, color: "var(--overlay0)", lineHeight: 1.5,
        }}>
          {footer}
        </div>
      )}
    </div>
  );
}
