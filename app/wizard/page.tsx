"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import PageShell from "@/components/PageShell";
import { WizardSection } from "@/components/WizardSection";
import { useAuth } from "@/lib/auth-context";

export default function WizardPage() {
  const router = useRouter();
  const { session, tenantId, loading } = useAuth();

  useEffect(() => {
    if (!loading && !session) router.replace("/login");
  }, [loading, session, router]);

  return (
    <PageShell
      active="wizard"
      title="Wizard"
      description="Guided setup for pipelines, agents, and integrations. Pick up where you left off."
      maxWidth={680}
    >
      {loading ? (
        <div style={{ color: "var(--subtext0)", fontSize: 14 }}>Loading…</div>
      ) : !tenantId ? (
        <div style={{ color: "var(--subtext0)", fontSize: 14 }}>
          No tenant found. <a href="/onboard" style={{ color: "var(--blue)" }}>Set up your workspace first.</a>
        </div>
      ) : (
        <WizardSection tenantId={tenantId} collapsible={false} />
      )}
    </PageShell>
  );
}
