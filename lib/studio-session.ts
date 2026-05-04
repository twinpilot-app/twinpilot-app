/**
 * Studio Wizard session helpers — manage the active dry-run draft per
 * (user, factory). Used by:
 *   - GET  /api/studio/session       — load or null
 *   - POST /api/wizard/chat          — append staged items as the LLM tools fire
 *   - POST /api/studio/sessions/[id]/confirm  — flush transactionally
 *   - DELETE /api/studio/sessions/[id]        — discard
 *
 * The helpers accept any SupabaseClient — pass a user-JWT-scoped one when
 * RLS should enforce auth (route handlers do this), or a service-role one
 * when you've already authorised the caller and need the write to bypass
 * RLS (the chat tools, which run with the service role for everything else).
 *
 * `version` on session rows always lives at "1" for now; bump in lockstep
 * with breaking changes to the StudioPlan shape so old rows don't crash
 * the UI.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import {
  type StudioPlan,
  type StagedAgent,
  type StagedPipeline,
  type StagedProject,
  type StagedBacklogItem,
  type StagedOperation,
  type DiscardedEntry,
  type StagedId,
  emptyStudioPlan,
  DEFAULT_AGENT_TOOLS,
} from "./studio-plan-types";

const PLAN_VERSION = "1";

export interface StudioSessionRow {
  id:           string;
  tenant_id:    string;
  factory_id:   string;
  user_id:      string;
  status:       "draft" | "confirmed" | "discarded";
  version:      string;
  plan:         StudioPlan;
  chat_history: unknown | null;
  created_at:   string;
  updated_at:   string;
  confirmed_at: string | null;
  discarded_at: string | null;
}

/* ── Read ─────────────────────────────────────────────────────────────── */

/** Load the active draft for (user, factory). Returns null if none. */
export async function getActiveSession(
  sb: SupabaseClient,
  userId: string,
  factoryId: string,
): Promise<StudioSessionRow | null> {
  const { data } = await sb
    .from("studio_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("factory_id", factoryId)
    .eq("status", "draft")
    .maybeSingle();
  if (!data) return null;
  return normaliseRow(data as Record<string, unknown>);
}

/** Load a session by id. */
export async function getSessionById(
  sb: SupabaseClient,
  sessionId: string,
): Promise<StudioSessionRow | null> {
  const { data } = await sb
    .from("studio_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (!data) return null;
  return normaliseRow(data as Record<string, unknown>);
}

/* ── Create / get-or-create ──────────────────────────────────────────── */

/**
 * Find an existing draft for (user, factory) or create one. Idempotent —
 * the partial unique index on (user_id, factory_id) WHERE status='draft'
 * guarantees only one ever exists per pair.
 */
export async function ensureActiveSession(
  sb: SupabaseClient,
  opts: { userId: string; factoryId: string; tenantId: string },
): Promise<StudioSessionRow> {
  const existing = await getActiveSession(sb, opts.userId, opts.factoryId);
  if (existing) return existing;

  const { data, error } = await sb
    .from("studio_sessions")
    .insert({
      tenant_id:  opts.tenantId,
      factory_id: opts.factoryId,
      user_id:    opts.userId,
      status:     "draft",
      version:    PLAN_VERSION,
      plan:       emptyStudioPlan(),
    })
    .select("*")
    .single();
  if (error || !data) throw new Error(`Could not create studio session: ${error?.message}`);
  return normaliseRow(data as Record<string, unknown>);
}

/* ── Mutate plan ─────────────────────────────────────────────────────── */

/** Replace the plan in full. Used by the append helpers below. */
async function writePlan(sb: SupabaseClient, sessionId: string, plan: StudioPlan): Promise<void> {
  const { error } = await sb
    .from("studio_sessions")
    .update({ plan, updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("status", "draft");
  if (error) throw new Error(`Could not update studio session plan: ${error.message}`);
}

export function newStagedId(entity: "agent" | "pipeline" | "project" | "backlog"): StagedId {
  return `staged:${entity}-${randomUUID()}` as StagedId;
}

export async function appendAgent(
  sb: SupabaseClient,
  sessionId: string,
  agent: Omit<StagedAgent, "id" | "createdAt" | "version" | "tools"> & Partial<Pick<StagedAgent, "id" | "createdAt" | "version" | "tools">>,
): Promise<StagedAgent> {
  const session = await requireDraft(sb, sessionId);
  const item: StagedAgent = {
    id:        agent.id ?? newStagedId("agent"),
    slug:      agent.slug,
    name:      agent.name,
    version:   agent.version ?? "1.0.0",
    squad:     agent.squad,
    level:     agent.level,
    icon:      agent.icon,
    tags:      agent.tags,
    persona:   agent.persona,
    tools:     agent.tools && agent.tools.length > 0 ? agent.tools : [...DEFAULT_AGENT_TOOLS],
    createdAt: agent.createdAt ?? new Date().toISOString(),
  };
  session.plan.agents.push(item);
  await writePlan(sb, sessionId, session.plan);
  return item;
}

export async function appendPipeline(
  sb: SupabaseClient,
  sessionId: string,
  pipeline: Omit<StagedPipeline, "id" | "createdAt"> & Partial<Pick<StagedPipeline, "id" | "createdAt">>,
): Promise<StagedPipeline> {
  const session = await requireDraft(sb, sessionId);
  const item: StagedPipeline = {
    id:          pipeline.id ?? newStagedId("pipeline"),
    name:        pipeline.name,
    slug:        pipeline.slug,
    description: pipeline.description,
    steps:       pipeline.steps,
    mode:        pipeline.mode,
    createdAt:   pipeline.createdAt ?? new Date().toISOString(),
  };
  session.plan.pipelines.push(item);
  await writePlan(sb, sessionId, session.plan);
  return item;
}

export async function appendProject(
  sb: SupabaseClient,
  sessionId: string,
  project: Omit<StagedProject, "id" | "createdAt"> & Partial<Pick<StagedProject, "id" | "createdAt">>,
): Promise<StagedProject> {
  const session = await requireDraft(sb, sessionId);
  const item: StagedProject = {
    id:         project.id ?? newStagedId("project"),
    name:       project.name,
    slug:       project.slug,
    brief:      project.brief,
    pipelineId: project.pipelineId,
    createdAt:  project.createdAt ?? new Date().toISOString(),
  };
  session.plan.projects.push(item);
  await writePlan(sb, sessionId, session.plan);
  return item;
}

export async function appendBacklogItem(
  sb: SupabaseClient,
  sessionId: string,
  item: Omit<StagedBacklogItem, "id" | "createdAt"> & Partial<Pick<StagedBacklogItem, "id" | "createdAt">>,
): Promise<StagedBacklogItem> {
  const session = await requireDraft(sb, sessionId);
  const out: StagedBacklogItem = {
    id:          item.id ?? newStagedId("backlog"),
    projectId:   item.projectId,
    title:       item.title,
    description: item.description,
    createdAt:   item.createdAt ?? new Date().toISOString(),
  };
  if (!Array.isArray(session.plan.backlogItems)) session.plan.backlogItems = [];
  session.plan.backlogItems.push(out);
  await writePlan(sb, sessionId, session.plan);
  return out;
}

export async function appendOperation(
  sb: SupabaseClient,
  sessionId: string,
  op: Omit<StagedOperation, "stagedAt"> & Partial<Pick<StagedOperation, "stagedAt">>,
): Promise<StagedOperation> {
  const session = await requireDraft(sb, sessionId);
  const item: StagedOperation = { ...op, stagedAt: op.stagedAt ?? new Date().toISOString() } as StagedOperation;
  session.plan.operations.push(item);
  await writePlan(sb, sessionId, session.plan);
  return item;
}

/* ── Discard ─────────────────────────────────────────────────────────── */

/**
 * Soft-discard a single staged item. The entry is removed from its array
 * and recorded under plan.discarded so the chat history can show
 * "you discarded X" — confirm filters discarded items out automatically.
 */
export async function discardItem(
  sb: SupabaseClient,
  sessionId: string,
  type: DiscardedEntry["type"],
  id: string,
  reason?: string,
): Promise<{ ok: boolean }> {
  const session = await requireDraft(sb, sessionId);
  const plan = session.plan;
  const at = new Date().toISOString();
  let removed = false;

  switch (type) {
    case "agent":
      plan.agents = plan.agents.filter((a) => { if (a.id === id) { removed = true; return false; } return true; });
      break;
    case "pipeline":
      plan.pipelines = plan.pipelines.filter((p) => { if (p.id === id) { removed = true; return false; } return true; });
      break;
    case "project":
      plan.projects = plan.projects.filter((p) => { if (p.id === id) { removed = true; return false; } return true; });
      break;
    case "backlog":
      plan.backlogItems = (plan.backlogItems ?? []).filter((b) => { if (b.id === id) { removed = true; return false; } return true; });
      break;
    case "operation":
      plan.operations = plan.operations.filter((_, i) => { if (String(i) === id) { removed = true; return false; } return true; });
      break;
  }

  if (!removed) return { ok: false };
  plan.discarded = plan.discarded ?? [];
  plan.discarded.push({ type, id, reason, at });
  await writePlan(sb, sessionId, plan);
  return { ok: true };
}

/** Cancel the whole session. Marks status=discarded, keeps the row for audit. */
export async function discardSession(sb: SupabaseClient, sessionId: string): Promise<void> {
  const { error } = await sb
    .from("studio_sessions")
    .update({ status: "discarded", discarded_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("status", "draft");
  if (error) throw new Error(`Could not discard studio session: ${error.message}`);
}

/* ── Internal ────────────────────────────────────────────────────────── */

async function requireDraft(sb: SupabaseClient, sessionId: string): Promise<StudioSessionRow> {
  const session = await getSessionById(sb, sessionId);
  if (!session) throw new Error(`Studio session ${sessionId} not found`);
  if (session.status !== "draft") throw new Error(`Studio session ${sessionId} is ${session.status}, cannot mutate`);
  return session;
}

function normaliseRow(row: Record<string, unknown>): StudioSessionRow {
  const plan = (row.plan as StudioPlan | null) ?? emptyStudioPlan();
  // Defensive: older rows might be missing operations/discarded keys, or
  // carry the legacy `squads` array from before squad-as-tag (just ignored).
  if (!Array.isArray(plan.agents))       plan.agents       = [];
  if (!Array.isArray(plan.pipelines))    plan.pipelines    = [];
  if (!Array.isArray(plan.projects))     plan.projects     = [];
  if (!Array.isArray(plan.backlogItems)) plan.backlogItems = [];
  if (!Array.isArray(plan.operations))   plan.operations   = [];
  delete (plan as unknown as { squads?: unknown }).squads;
  return {
    id:           row.id as string,
    tenant_id:    row.tenant_id as string,
    factory_id:   row.factory_id as string,
    user_id:      row.user_id as string,
    status:       row.status as "draft" | "confirmed" | "discarded",
    version:      row.version as string,
    plan,
    chat_history: row.chat_history ?? null,
    created_at:   row.created_at as string,
    updated_at:   row.updated_at as string,
    confirmed_at: (row.confirmed_at as string | null) ?? null,
    discarded_at: (row.discarded_at as string | null) ?? null,
  };
}
