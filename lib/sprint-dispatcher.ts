import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveTriggerKey,
  type TriggerExecutionMode,
} from "@/lib/trigger-key-resolver";
import { mintWorkerToken } from "@/lib/worker-jwt";
import { checkWorkerPresence } from "@/lib/worker-presence";

const TRIGGER_API = "https://api.trigger.dev";
const TRIGGER_TASK_ID = "run-pipeline";

export type DispatchSprintInput = {
  sb: SupabaseClient;
  projectId: string;
  factoryId: string;
  tenantId: string;
  projectSlug: string;
  /** Sprint UUID — passed through to Trigger.dev's payload by callers
   *  that want the worker to know which sprint it's running. The
   *  dispatcher itself doesn't use this for the pre-flight presence
   *  check (that lives on Realtime, scoped to tenant + factory). */
  sprintId?: string;
  /** Merged verbatim into the Trigger.dev `payload` along with projectId/projectSlug. */
  payload: Record<string, unknown>;
  cliExecutionMode?: TriggerExecutionMode;
  /** Final project.status after a successful Trigger.dev dispatch. Defaults to "running". */
  runningStatus?: "running";
};

export type DispatchSprintResult =
  | {
      ok: true;
      triggerRunId: string | null;
      priorStatus: string | null;
    }
  | {
      ok: false;
      reason:
        | "no-key"
        | "no-slot"
        | "no-worker"
        | "project-not-found"
        | "factory-mismatch"
        | "project-busy"
        | "trigger-rejected"
        | "trigger-error";
      detail?: string;
      priorStatus?: string | null;
    };

/**
 * Unified sprint dispatcher.
 *
 * Encapsulates the sequence shared by POST /run, /approve, and /continue:
 *   1. Resolve the per-tenant Trigger.dev secret (dev vs prod).
 *   2. Atomically reserve a concurrency slot in the factory (setting
 *      project.status to "running").
 *   3. POST the pipeline run to Trigger.dev.
 *   4. On Trigger.dev failure, revert project.status to its prior value
 *      so the slot is released.
 *
 * Does not mutate the sprint row — callers own sprint lifecycle.
 */
export async function dispatchSprint(
  input: DispatchSprintInput,
): Promise<DispatchSprintResult> {
  const {
    sb,
    projectId,
    factoryId,
    tenantId,
    projectSlug,
    payload,
    cliExecutionMode,
    runningStatus = "running",
  } = input;

  const triggerKey = await resolveTriggerKey(sb, tenantId, cliExecutionMode);
  if (!triggerKey) {
    return { ok: false, reason: "no-key" };
  }

  // ── Pre-flight worker presence check (local mode only) ───────────
  // Replaces the previous post-dispatch poll: we ask Supabase Realtime
  // whether a `tp workers dev` session is currently tracking presence
  // on the tenant/factory channel. If not, refuse synchronously — no
  // slot acquisition, no Trigger.dev orphan, no sprint row to clean
  // up later. ~500 ms median, 1.5 s timeout (fail-closed). Cloud mode
  // skips: Trigger.dev's own scheduler handles managed-worker queueing.
  if (cliExecutionMode === "local") {
    const presence = await checkWorkerPresence(tenantId, factoryId);
    if (!presence.online) {
      return {
        ok: false,
        reason: "no-worker",
        detail: presence.timedOut
          ? "Could not reach the worker presence channel within 1.5s — assuming offline. Start `tp workers dev` and retry."
          : "Local Trigger.dev worker is not running. Start it with `tp workers dev` and retry.",
      };
    }
  }

  // Atomic slot acquire — sets project.status = "running" up front.
  // The slot RPC is the single source of truth for "can this project
  // start a sprint right now?".
  const { data: slotRows, error: slotErr } = await sb.rpc(
    "try_acquire_factory_slot",
    {
      p_factory_id: factoryId,
      p_project_id: projectId,
      p_target_status: "running",
    },
  );

  if (slotErr) {
    return {
      ok: false,
      reason: "trigger-error",
      detail: `Slot acquire failed: ${slotErr.message}`,
    };
  }

  type SlotRow = { acquired: boolean; reason: string | null; prior_status: string | null };
  const slot = (Array.isArray(slotRows) ? slotRows[0] : slotRows) as SlotRow | null;
  if (!slot || slot.acquired !== true) {
    const rawReason = slot?.reason ?? "no-slot";
    const reason =
      rawReason === "project-not-found" ||
      rawReason === "factory-mismatch" ||
      rawReason === "project-busy"
        ? rawReason
        : "no-slot";
    return {
      ok: false,
      reason,
      priorStatus: slot?.prior_status ?? null,
    };
  }

  const priorStatus = (slot.prior_status as string | null) ?? null;

  // Mint a tenant-scoped JWT for the worker. Post-Stage 5 this is
  // mandatory: the worker has no SUPABASE_SERVICE_ROLE_KEY and will
  // refuse to start without a JWT. A mint failure means the platform
  // is misconfigured (missing SUPABASE_JWT_SECRET) — release the slot
  // and surface the error instead of dispatching a job that will die
  // inside Trigger.dev.
  //
  // 12h TTL covers realistic long sprints (human-gate waits, multi-
  // step pipelines). Pipeline maxDuration is 24h; this is well within it.
  let supabaseJwt: string;
  let supabaseJwtExpiresAt: number;
  try {
    const minted = mintWorkerToken({ tenantId, factoryId, ttlSeconds: 60 * 60 * 12 });
    supabaseJwt = minted.token;
    supabaseJwtExpiresAt = minted.expiresAt;
  } catch (err) {
    // Keep full technical detail in platform logs — tenant users can't
    // act on OpenSSL / env-var configuration problems. Give them a
    // ticketable reference they can forward to support.
    const errorId = `mint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    console.error(`[sprint-dispatcher] ${errorId} worker JWT mint failed for tenant ${tenantId}/factory ${factoryId}:`, err);
    await releaseSlot(sb, projectId, priorStatus);
    return {
      ok: false,
      reason: "trigger-error",
      detail: `We couldn't start this sprint because the platform's worker-token signing is misconfigured. This is not something you can fix from your workspace. Please contact support and share this reference: ${errorId}`,
      priorStatus,
    };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

  try {
    const triggerRes = await fetch(
      `${TRIGGER_API}/api/v1/tasks/${TRIGGER_TASK_ID}/trigger`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${triggerKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: {
            projectId,
            projectSlug,
            ...payload,
            supabaseJwt,
            supabaseJwtExpiresAt,
            ...(supabaseUrl ? { supabaseUrl } : {}),
          },
        }),
      },
    );

    if (!triggerRes.ok) {
      const detail = await triggerRes.text();
      await releaseSlot(sb, projectId, priorStatus);
      return { ok: false, reason: "trigger-rejected", detail, priorStatus };
    }

    const triggerBody = (await triggerRes.json()) as { id?: string };
    const triggerRunId = triggerBody.id ?? null;

    if (triggerRunId) {
      // Slot RPC already set status = "running"; only update if the
      // caller wanted something different (currently nobody does).
      if (runningStatus !== "running") {
        await sb.from("projects")
          .update({ status: runningStatus })
          .eq("id", projectId);
      }
    } else {
      await releaseSlot(sb, projectId, priorStatus);
    }

    return { ok: true, triggerRunId, priorStatus };
  } catch (e) {
    await releaseSlot(sb, projectId, priorStatus);
    return {
      ok: false,
      reason: "trigger-error",
      detail: (e as Error).message,
      priorStatus,
    };
  }
}

async function releaseSlot(
  sb: SupabaseClient,
  projectId: string,
  priorStatus: string | null,
): Promise<void> {
  await sb.from("projects")
    .update({ status: priorStatus ?? "idle" })
    .eq("id", projectId);
}

