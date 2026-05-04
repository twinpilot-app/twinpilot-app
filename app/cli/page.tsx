"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Terminal, Copy, Check, ExternalLink, ArrowRight, Package, Wrench, Laptop } from "lucide-react";
import PageShell from "@/components/PageShell";
import { CliInstancesSection } from "@/components/CliInstancesSection";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";

interface CliVersionInfo {
  available:   boolean;
  packageName: string;
  version?:    string;
  publishedAt?: string | null;
}

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = now - then;
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

type Tab = "setup" | "authenticated";

export default function CliIntegrationPage() {
  const router = useRouter();
  const { session, tenantId, loading } = useAuth();
  const [version, setVersion] = useState<CliVersionInfo | null>(null);
  const [tab, setTab] = useState<Tab>("setup");

  useEffect(() => {
    if (!loading && !session) router.replace("/login");
  }, [loading, session, router]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/cli/version")
      .then((r) => r.ok ? r.json() : null)
      .then((body: CliVersionInfo | null) => { if (!cancelled && body) setVersion(body); })
      .catch(() => { /* silent — the badge just won't render */ });
    return () => { cancelled = true; };
  }, []);

  if (loading || !session) return null;

  return (
    <PageShell
      active="cli"
      title={`${brand.shortName} CLI`}
      description="Run pipelines from your terminal. Install once, then authorize to connect it to this workspace."
      maxWidth={760}
    >
      <TabBar current={tab} onChange={setTab} />

          {tab === "authenticated" && (
            tenantId
              ? <CliInstancesSection tenantId={tenantId} />
              : <div style={{ color: "var(--subtext0)", fontSize: 13 }}>
                  No tenant found. <a href="/onboard" style={{ color: "var(--blue)" }}>Set up your workspace first.</a>
                </div>
          )}

          {tab === "setup" && <>

          <StepCard
            num={1}
            title="Install"
            description="Install the CLI globally via npm. Requires Node.js 20 or newer."
          >
            <CommandBlock cmd={`npm i -g ${brand.cli.packageName}`} />
            {version?.available && version.version && (
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                marginTop: 10, padding: "4px 10px", borderRadius: 999,
                background: "rgba(28,191,107,0.08)", border: "1px solid rgba(28,191,107,0.25)",
                fontSize: 11, color: "var(--green)", fontFamily: "var(--font-mono)",
              }}>
                <Package size={11} />
                <span>Latest: <strong>v{version.version}</strong></span>
                {version.publishedAt && (
                  <span style={{ color: "var(--overlay0)", fontFamily: "var(--font-sans)" }}>
                    · published {relativeTime(version.publishedAt)}
                  </span>
                )}
              </div>
            )}
            {version && !version.available && (
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                marginTop: 10, padding: "4px 10px", borderRadius: 999,
                background: "rgba(245,159,0,0.08)", border: "1px solid rgba(245,159,0,0.25)",
                fontSize: 11, color: "var(--peach)", fontFamily: "var(--font-mono)",
              }}>
                <Package size={11} />
                <span>Not yet published on npm</span>
              </div>
            )}
            <div style={{ display: "flex", gap: 14, marginTop: 12 }}>
              <a href={`https://www.npmjs.com/package/${brand.cli.packageName}`} target="_blank" rel="noreferrer" style={linkStyle}>
                npm <ExternalLink size={12} />
              </a>
              <a href={brand.urls.github} target="_blank" rel="noreferrer" style={linkStyle}>
                Source <ExternalLink size={12} />
              </a>
              <a href={brand.urls.docs} target="_blank" rel="noreferrer" style={linkStyle}>
                Docs <ExternalLink size={12} />
              </a>
            </div>
          </StepCard>

          <StepCard
            num={2}
            title="Authorize"
            description={`Log in from your terminal — the CLI opens a browser window to pick a workspace and stores a profile in ~/.twinpilot/config.json.`}
          >
            <CommandBlock cmd={`${brand.cli.binName} login`} />
            <p style={{ color: "var(--overlay0)", fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
              Or click below to open the authorization page directly — the CLI polls until you pick a workspace.
            </p>
            <a
              href="/cli-auth"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8,
                padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: "var(--blue)", color: "#fff", textDecoration: "none",
              }}
            >
              <Terminal size={13} /> Authorize in browser <ArrowRight size={13} />
            </a>
          </StepCard>

          <StepCard
            num={3}
            title="Prepare the worker"
            description="The worker is the orchestrator that runs your sprints. Extract the bundle and fetch env vars first; --reinstall is recommended after a CLI upgrade so node_modules tracks the new version."
          >
            <CommandBlock cmd={`${brand.cli.binName} workers prepare --reinstall`} />
            <p style={{ color: "var(--overlay0)", fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
              Then start the worker according to your execution mode:
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <div style={{
                padding: "10px 12px", borderRadius: 8,
                background: "var(--surface0)", border: "1px solid var(--surface1)",
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                  Local / Local-Git
                </div>
                <CommandBlock cmd={`${brand.cli.binName} workers dev`} />
                <p style={{ color: "var(--overlay0)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
                  Long-running daemon in this terminal. Sprints execute here.
                </p>
              </div>
              <div style={{
                padding: "10px 12px", borderRadius: 8,
                background: "var(--surface0)", border: "1px solid var(--surface1)",
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                  Cloud
                </div>
                <CommandBlock cmd={`${brand.cli.binName} workers deploy`} />
                <p style={{ color: "var(--overlay0)", fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
                  Pushes to your Trigger.dev cloud project. Sprints execute remotely.
                </p>
              </div>
            </div>
          </StepCard>

          <StepCard
            num={4}
            title="Switch workspaces (optional)"
            description="Each login saves a profile keyed by tenant/factory. Switch the active profile without re-authenticating."
          >
            <CommandBlock cmd={`${brand.cli.binName} profiles`} label="List saved profiles" />
            <div style={{ height: 8 }} />
            <CommandBlock cmd={`${brand.cli.binName} use <tenant>/<factory>`} label="Switch active profile" />
          </StepCard>

          <StepCard
            num={5}
            title="Run a pipeline"
            description="With a profile active and a worker running, trigger a project from scratch or continue an existing one."
          >
            <CommandBlock cmd={`${brand.cli.binName} from-scratch "Your idea in a sentence"`} />
            <div style={{ height: 8 }} />
            <CommandBlock cmd={`${brand.cli.binName} status`} label="Check running projects" />
            <div style={{ height: 8 }} />
            <CommandBlock cmd={`${brand.cli.binName} pending`} label="List human gates awaiting approval" />
          </StepCard>

          <div style={{
            marginTop: 32, padding: "14px 18px", borderRadius: 10,
            background: "var(--surface0)", border: "1px solid var(--surface1)",
            fontSize: 12, color: "var(--subtext0)", lineHeight: 1.7,
          }}>
            <strong style={{ color: "var(--text)" }}>Stay current.</strong>{" "}
            New CLI versions ship every few days. Check the version banner above and run{" "}
            <code style={codeInline}>{brand.cli.binName} self-update</code> to grab the latest{" "}
            (alias for <code style={codeInline}>npm i -g {brand.cli.packageName}@latest</code>).
            After upgrading, re-run <code style={codeInline}>{brand.cli.binName} workers prepare --reinstall</code>{" "}
            so the worker bundle tracks the new version.
          </div>

          <div style={{
            marginTop: 12, padding: "14px 18px", borderRadius: 10,
            background: "var(--surface0)", border: "1px solid var(--surface1)",
            fontSize: 12, color: "var(--subtext0)", lineHeight: 1.7,
          }}>
            <strong style={{ color: "var(--text)" }}>CI/CD?</strong>{" "}
            Generate an API key on the <a href="/api-keys" style={{ color: "var(--blue)" }}>API Keys</a> page
            and set <code style={codeInline}>TWINPILOT_API_KEY</code>,{" "}
            <code style={codeInline}>TWINPILOT_TENANT</code>, and{" "}
            <code style={codeInline}>TWINPILOT_FACTORY</code> in your runner — the CLI uses those instead of
            the saved profile.
          </div>

          </>}
    </PageShell>
  );
}

/* ── TabBar ─────────────────────────────────────── */

function TabBar({ current, onChange }: { current: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string; icon: React.FC<{ size?: number }> }[] = [
    { id: "setup",         label: "Setup",         icon: Wrench },
    { id: "authenticated", label: "Authenticated", icon: Laptop },
  ];
  return (
    <div style={{
      display: "flex", gap: 4,
      borderBottom: "1px solid var(--surface0)",
      marginBottom: 24,
    }}>
      {tabs.map((t) => {
        const isActive = current === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "10px 16px",
              background: "transparent", border: "none",
              cursor: "pointer",
              color: isActive ? "var(--text)" : "var(--subtext0)",
              fontSize: 13, fontWeight: isActive ? 600 : 500,
              fontFamily: "var(--font-sans)",
              borderBottom: `2px solid ${isActive ? "var(--blue)" : "transparent"}`,
              marginBottom: -1,
            }}
          >
            <Icon size={14} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Helpers ─────────────────────────────────────── */

const linkStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4,
  color: "var(--blue)", fontSize: 12, textDecoration: "none",
};

const codeInline: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 11,
  padding: "1px 5px", borderRadius: 4,
  background: "var(--base)", border: "1px solid var(--surface1)",
  color: "var(--text)",
};

function StepCard({ num, title, description, children }: {
  num: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      marginBottom: 20, padding: 20, borderRadius: 12,
      background: "var(--mantle)", border: "1px solid var(--surface1)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{
          width: 22, height: 22, borderRadius: 6,
          background: "var(--blue)", color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 700, flexShrink: 0,
        }}>{num}</div>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
      </div>
      <p style={{ color: "var(--subtext0)", fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
        {description}
      </p>
      {children}
    </div>
  );
}

function CommandBlock({ cmd, label }: { cmd: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  return (
    <div>
      {label && (
        <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 4, fontWeight: 600 }}>
          {label}
        </div>
      )}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 14px", borderRadius: 8,
        background: "var(--surface0)", border: "1px solid var(--surface1)",
        fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text)",
      }}>
        <span style={{ color: "var(--overlay0)" }}>$</span>
        <span style={{ flex: 1, overflow: "auto", whiteSpace: "nowrap" }}>{cmd}</span>
        <button
          onClick={copy}
          title="Copy"
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: copied ? "var(--green)" : "var(--overlay1)",
            display: "flex", padding: 4, flexShrink: 0,
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}
