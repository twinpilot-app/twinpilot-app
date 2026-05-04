"use client";

import { useEffect, useState } from "react";
import { useAuth } from "./auth-context";

/**
 * Checks which integrations are configured for the current tenant.
 * Returns badge severity per sidebar section so the sidebar can show alerts.
 *
 * - "red"    → required integration missing (Trigger.dev)
 * - "orange" → recommended integration missing (GitHub)
 * - null     → all configured (or still loading)
 */

export interface IntegrationAlerts {
  platforms: "red" | "orange" | null; // maps to orchestration sidebar badge
  providers: null; // providers are always optional, no alert
}

export function useIntegrationStatus(): IntegrationAlerts & { loaded: boolean } {
  const { tenantId, session } = useAuth();
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!tenantId || !session) return;
    fetch(`/api/settings/integrations?tenantId=${tenantId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (res) => {
        if (res.ok) {
          const body = (await res.json()) as { configured: string[] };
          setConfigured(new Set(body.configured));
        }
      })
      .finally(() => setLoaded(true));
  }, [tenantId, session]);

  if (!loaded) return { platforms: null, providers: null, loaded: false };

  // Required: Trigger.dev project ID + at least one secret key (dev or prod)
  const triggerOk =
    configured.has("trigger:TRIGGER_PROJECT_ID") &&
    (configured.has("trigger:TRIGGER_DEV_SECRET_KEY") ||
     configured.has("trigger:TRIGGER_PROD_SECRET_KEY") ||
     configured.has("trigger:TRIGGER_SECRET_KEY"));

  // Recommended: GitHub token + owner (for Storage section)
  const githubOk =
    configured.has("github:GITHUB_TOKEN") &&
    configured.has("github:GITHUB_OWNER");

  let platforms: "red" | "orange" | null = null;
  if (!triggerOk) {
    platforms = "red";
  } else if (!githubOk) {
    platforms = "orange";
  }

  return { platforms, providers: null, loaded: true };
}
