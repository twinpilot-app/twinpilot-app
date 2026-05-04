/**
 * Worker presence pre-flight via Supabase Realtime.
 *
 * The local CLI worker (`tp workers dev`) joins a presence channel
 * named `worker-presence:{tenantId}:{factoryId}` and tracks itself
 * with a small payload while it runs. Before dispatching a sprint in
 * local mode, the dispatcher checks the channel — if no presences are
 * tracked, the worker is offline and we refuse the dispatch
 * synchronously instead of submitting an orphan run to Trigger.dev.
 *
 * Why Realtime instead of a heartbeat row:
 *   - Zero database writes. The presence is purely in-memory on the
 *     Supabase Realtime cluster, expiring automatically when the
 *     worker's WebSocket drops.
 *   - Sub-second detection. The dispatcher subscribes briefly, reads
 *     the presence map, unsubscribes — done in <1 s on a healthy
 *     cluster.
 *   - No new tables, indexes, or migrations.
 *
 * The trade-off vs a heartbeat row:
 *   - Each dispatch opens a fresh WebSocket. On a serverless host
 *     this is fine — the function lifecycle exceeds the few hundred
 *     ms we need. On a long-running host we could cache the channel
 *     across dispatches; not worth the complexity right now.
 *   - Channel auth: by default Supabase Realtime channels are open
 *     to any authenticated client. The channel name carries the
 *     tenant id but isn't a strong security boundary on its own —
 *     RLS-equivalent channel policies (Realtime Authorization) can
 *     tighten this later if presence ever carries sensitive data.
 *     Today the payload is `{ version, since, factoryId }` only.
 */

import { createClient } from "@supabase/supabase-js";

const PRESENCE_TIMEOUT_MS = 1500;

export function workerPresenceChannelName(tenantId: string, factoryId: string | null): string {
  return factoryId
    ? `worker-presence:${tenantId}:${factoryId}`
    : `worker-presence:${tenantId}`;
}

export interface WorkerPresenceEntry {
  factoryId: string | null;
  version:   string | null;
  /** ISO timestamp the worker tracked at. */
  since:     string | null;
}

export interface WorkerPresenceResult {
  online:   boolean;
  /** All presences seen on the channel during the probe. Empty when offline. */
  entries:  WorkerPresenceEntry[];
  /** True when the probe timed out before the initial sync. We treat
   *  timeout as offline (fail-closed) — better to send the operator
   *  a "start your worker" hint than to dispatch a sprint that may
   *  never get claimed. */
  timedOut: boolean;
}

/**
 * Probe the presence channel for a tenant + factory. Opens a fresh
 * WebSocket, waits for the initial 'sync' event, reads the presence
 * state, then unsubscribes.
 *
 * Uses a service-role client so the server can read every channel
 * without per-tenant auth scaffolding. The actual presence content
 * is set by the CLI worker, which signs in with the tenant's anon
 * key + worker JWT.
 */
export async function checkWorkerPresence(
  tenantId: string,
  factoryId: string | null,
): Promise<WorkerPresenceResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { online: false, entries: [], timedOut: false };
  }

  const sb = createClient(url, key, {
    auth: { persistSession: false },
    realtime: {
      // Trim the heartbeat — we only stay connected for ~1.5 s.
      heartbeatIntervalMs: 30_000,
    },
  });
  const channelName = workerPresenceChannelName(tenantId, factoryId);
  const channel = sb.channel(channelName, {
    config: { presence: { key: "server-probe" } },
  });

  return new Promise<WorkerPresenceResult>((resolve) => {
    let settled = false;

    const finish = (result: WorkerPresenceResult) => {
      if (settled) return;
      settled = true;
      // Unsubscribe is async but we don't need to wait — just fire.
      void channel.unsubscribe().catch(() => undefined);
      void sb.removeAllChannels().catch(() => undefined);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({ online: false, entries: [], timedOut: true });
    }, PRESENCE_TIMEOUT_MS);

    channel
      .on("presence", { event: "sync" }, () => {
        clearTimeout(timeout);
        const state = channel.presenceState();
        const entries: WorkerPresenceEntry[] = [];
        for (const presences of Object.values(state)) {
          for (const p of presences as unknown as Record<string, unknown>[]) {
            entries.push({
              factoryId: (p.factoryId as string | null | undefined) ?? null,
              version:   (p.version   as string | null | undefined) ?? null,
              since:     (p.since     as string | null | undefined) ?? null,
            });
          }
        }
        // Filter out our own server-probe key — that's a presence we
        // contributed, not the worker we're trying to detect.
        const real = entries.filter((e) => e.version !== "server-probe");
        finish({ online: real.length > 0, entries: real, timedOut: false });
      })
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          finish({ online: false, entries: [], timedOut: status === "TIMED_OUT" });
        }
      });
  });
}
