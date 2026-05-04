"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import IntegrationsShell from "@/components/IntegrationsShell";
import CliAgentsSection from "@/components/CliAgentsSection";
import { useAuth } from "@/lib/auth-context";
import { brand } from "@/lib/brand";

export default function CliProvidersPage() {
  const router = useRouter();
  const { session, tenantId, loading } = useAuth();

  useEffect(() => {
    if (!loading && !session) router.replace("/login");
  }, [loading, session, router]);

  if (loading || !session) return null;

  return (
    <IntegrationsShell
      active="cli-providers"
      title="CLI Providers"
      description={
        <>
          Run Claude Code, Aider, and other coding CLIs inside {brand.name} pipelines. Agents
          discovered by the {brand.shortName} CLI reuse keys from API Providers by default — set a
          CLI-specific key below when you want a different account.
        </>
      }
      maxWidth={760}
    >
      {tenantId ? (
        <CliAgentsSection tenantId={tenantId} session={session} />
      ) : (
        <div style={{ color: "var(--subtext0)", fontSize: 13 }}>
          No tenant found. <a href="/onboard" style={{ color: "var(--blue)" }}>Set up your workspace first.</a>
        </div>
      )}
    </IntegrationsShell>
  );
}
