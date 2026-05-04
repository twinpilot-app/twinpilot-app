"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Stub route — the sidebar's "Integrations" link goes here. We redirect
 * to the last integration the user visited (stored in localStorage), or
 * to /orchestration as a sensible default.
 *
 * This keeps the per-integration URLs stable (deep links, bookmarks)
 * while giving the sidebar a single entry point that makes the current
 * "Integrations" area feel like one coherent section.
 */
const LAST_VISITED_KEY = "twinpilot.integrations.last";
const DEFAULT_ROUTE    = "/orchestration";

export default function IntegrationsIndex() {
  const router = useRouter();
  useEffect(() => {
    let target = DEFAULT_ROUTE;
    try {
      const stored = localStorage.getItem(LAST_VISITED_KEY);
      if (stored && stored.startsWith("/")) target = stored;
    } catch { /* localStorage unavailable — use default */ }
    router.replace(target);
  }, [router]);

  return null;
}
