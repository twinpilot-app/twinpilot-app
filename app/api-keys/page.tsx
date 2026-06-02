"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import PageShell from "@/components/PageShell";
import { CiCdSection } from "@/components/CiCdSection";
import { useAuth } from "@/lib/auth-context";

export default function ApiKeysPage() {
  const router = useRouter();
  const { session, tenantId, loading } = useAuth();

  useEffect(() => {
    if (!loading && !session) router.replace("/login");
  }, [loading, session, router]);

  return (
    <PageShell
      active="api-keys"
      title="API Keys"
      description="Create and manage API keys for programmatic access. Keys are scoped per factory."
      maxWidth={720}
    >
      {loading ? (
        <div style={{ color: "var(--subtext0)", fontSize: 14 }}>Loading…</div>
      ) : !tenantId ? (
        <div style={{ color: "var(--subtext0)", fontSize: 14 }}>
          No tenant found. <a href="/onboard" style={{ color: "var(--blue)" }}>Set up your workspace first.</a>
        </div>
      ) : (
        <CiCdSection tenantId={tenantId} />
      )}
    </PageShell>
  );
}
