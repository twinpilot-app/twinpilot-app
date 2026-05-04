"use client";

/**
 * Review Sprint Modal — the "one-page report" of a sprint before it runs.
 *
 * Lifecycle:
 *   1. The Start Sprint modal calls `onReview(overrides)` from app/page.tsx,
 *      which closes Start and mounts this component with the overrides.
 *   2. On mount we POST /api/projects/[id]/sprint-plan with the overrides,
 *      compose + persist the SprintPlan, render every section.
 *   3. "Back" calls `onBack()` so the parent reopens Start with the same
 *      overrides preserved (zero state loss for the operator).
 *   4. "Confirm & Start" calls /api/projects/[id]/run with `{ planId }` to
 *      dispatch the sprint deterministically against the reviewed plan.
 *
 * The modal is the only review surface. There is no /projects/[id]/sprint-plan
 * page — preview-by-URL is intentionally left for a later iteration where we
 * also handle saving / sharing plans.
 */
import React, { useEffect, useState } from "react";
import { Session } from "@supabase/supabase-js";
import {
  AlertCircle, ChevronDown, ChevronRight, Play, ArrowLeft, Loader2,
  FileText, Zap, GitBranch, Users, Database, Layers, Settings, KeyRound, X,
  Cloud, FolderOpen, HardDrive, ListTodo,
} from "lucide-react";
import type { SprintPlan, SprintPlanStep } from "@/lib/sprint-plan-types";
import type { SprintRunOverrides } from "@/lib/types";

interface DBProjectMin {
  id:    string;
  slug:  string;
  name:  string;
}

export default function ReviewSprintModal({
  project, overrides, session, onBack, onDispatched,
}: {
  project:      DBProjectMin;
  overrides:    SprintRunOverrides;
  session:      Session;
  onBack:       () => void;
  onDispatched: () => void;
}) {
  const [plan, setPlan]       = useState<SprintPlan | null>(null);
  const [planId, setPlanId]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [expandedStep, setExpandedStep]       = useState<Set<number>>(new Set());
  const [expandedSection, setExpandedSection] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${project.id}/sprint-plan`, {
          method: "POST",
          headers: {
            Authorization:  `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(overrides),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; plan?: SprintPlan; planId?: string };
        if (cancelled) return;
        if (!res.ok || !body.plan || !body.planId) {
          setError(body.error ?? `Failed to compose plan (HTTP ${res.status}).`);
        } else {
          setPlan(body.plan);
          setPlanId(body.planId);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? "Network error.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [project.id, overrides, session.access_token]);

  async function confirmAndStart() {
    if (!planId) return;
    setDispatching(true); setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/run`, {
        method: "POST",
        headers: {
          Authorization:  `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ planId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; triggered?: boolean };
      if (!res.ok || !body.triggered) {
        setError(body.error ?? `Dispatch failed (HTTP ${res.status}).`);
        setDispatching(false);
        return;
      }
      onDispatched();
    } catch (e) {
      setError((e as Error).message ?? "Network error.");
      setDispatching(false);
    }
  }

  function toggleStep(step: number) {
    setExpandedStep((prev) => {
      const next = new Set(prev);
      if (next.has(step)) next.delete(step); else next.add(step);
      return next;
    });
  }

  function toggleSection(stepKey: number, title: string) {
    const key = `${stepKey}:${title}`;
    setExpandedSection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <div style={backdropStyle}>
      <div style={dialogStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              {plan ? `Review Sprint ${plan.sprint.num}` : "Review Sprint"}
            </div>
            <div style={{ fontSize: 11, color: "var(--overlay0)" }}>
              {project.name}
              {plan && <> · Composed {new Date(plan.composedAt).toLocaleString()} · Base <code style={codeStyle}>{plan.sprint.baseRef}</code></>}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={onBack} disabled={dispatching} style={ghostBtnStyle}>
              <ArrowLeft size={13} /> Back
            </button>
            <button onClick={confirmAndStart} disabled={!plan || dispatching} style={primaryBtnStyle}>
              {dispatching
                ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Starting…</>
                : <><Play size={13} /> Confirm & Start</>}
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {loading && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--overlay0)", fontSize: 13 }}>
              <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> Composing plan…
            </div>
          )}

          {error && (
            <div style={errBoxStyle}>
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          {!loading && plan && (
            <>
              {plan.warnings.length > 0 && (
                <div style={warnBoxStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, marginBottom: 6 }}>
                    <AlertCircle size={13} /> Warnings ({plan.warnings.length})
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                    {plan.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              <ProjectBlock plan={plan} />
              <ProjectSettingsBlock plan={plan} />
              <IntegrationsBlock plan={plan} />
              <ExecutionBlock plan={plan} />
              <StorageOutputBlock plan={plan} project={project} />
              <BacklogBlock plan={plan} />
              <SprintOverridesBlock plan={plan} />
              <KnowledgeBlock plan={plan} />
              <CrossSprintBlock plan={plan} />

              <SectionTitle icon={<Layers size={14} />} label={`Steps (${plan.steps.length})`} />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {plan.steps.map((step) => (
                  <StepCard
                    key={step.step}
                    step={step}
                    expanded={expandedStep.has(step.step)}
                    onToggle={() => toggleStep(step.step)}
                    expandedSections={expandedSection}
                    onToggleSection={(title) => toggleSection(step.step, title)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Footer (mirrors header actions for long plans) */}
        {!loading && plan && (
          <div style={footerStyle}>
            <button onClick={onBack} disabled={dispatching} style={ghostBtnStyle}>
              <ArrowLeft size={13} /> Back
            </button>
            <button onClick={confirmAndStart} disabled={dispatching} style={primaryBtnStyle}>
              {dispatching
                ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Starting…</>
                : <><Play size={13} /> Confirm & Start</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Blocks ────────────────────────────────────────────────────────────── */

function ProjectBlock({ plan }: { plan: SprintPlan }) {
  return (
    <>
      <SectionTitle icon={<FileText size={14} />} label="Project" />
      <div style={gridStyle}>
        <KV k="Name"      v={plan.project.name} />
        <KV k="Slug"      v={plan.project.slug} mono />
        <KV k="Pipeline"  v={`${plan.project.pipeline.name} (${plan.project.pipeline.stepCount} steps)`} />
        <KV k="Factory"   v={plan.project.factory.slug} mono />
        <KV k="Tenant"    v={plan.project.tenant.slug} mono />
        {plan.project.domain  && <KV k="Domain"   v={plan.project.domain} />}
        {plan.project.repoUrl && <KV k="Repo"     v={plan.project.repoUrl} mono />}
      </div>
      {plan.project.intakeBrief && (
        <>
          <div style={subHeaderStyle}>Intake brief (project-level — base for sprint)</div>
          <pre style={preStyle}>{plan.project.intakeBrief}</pre>
        </>
      )}
    </>
  );
}

function ProjectSettingsBlock({ plan }: { plan: SprintPlan }) {
  const s = plan.projectSettings;
  const hasAny =
       s.focus || s.defaultProvider || s.defaultModel
    || s.budgetUsd !== undefined || s.timeoutAgentMs !== undefined
    || s.guidelines || s.protocolOverride || s.onRejection
    || s.detailedMonitoring !== undefined || s.useDna !== undefined
    || s.categoryProviders || s.categoryModels
    || (s.agentConfigs && Object.keys(s.agentConfigs).length > 0)
    || s.cliAgents;

  if (!hasAny) return null;

  return (
    <>
      <SectionTitle icon={<Settings size={14} />} label="Project Settings" />
      <div style={gridStyle}>
        {s.focus              && <KV k="Focus"             v={s.focus} />}
        {s.defaultProvider    && <KV k="Default provider"  v={s.defaultProvider} />}
        {s.defaultModel       && <KV k="Default model"     v={s.defaultModel} mono />}
        {s.budgetUsd !== undefined        && <KV k="Budget"          v={`$${s.budgetUsd}`} />}
        {s.timeoutAgentMs !== undefined   && <KV k="Agent timeout"   v={`${s.timeoutAgentMs}ms`} />}
        {s.onRejection         && <KV k="On rejection"     v={s.onRejection} />}
        {s.detailedMonitoring !== undefined && <KV k="Detailed monitoring" v={s.detailedMonitoring ? "On" : "Off"} />}
        {s.useDna !== undefined          && <KV k="Use DNA"         v={s.useDna ? "On" : "Off"} />}
        {s.protocolOverride    && <KV k="Protocol override" v="Yes (full text below)" />}
      </div>

      {(s.categoryProviders || s.categoryModels) && (
        <>
          <div style={subHeaderStyle}>Category overrides</div>
          <div style={gridStyle}>
            {s.categoryProviders?.planning    && <KV k="Planning provider"   v={s.categoryProviders.planning} />}
            {s.categoryModels?.planning       && <KV k="Planning model"      v={s.categoryModels.planning} mono />}
            {s.categoryProviders?.development && <KV k="Development provider" v={s.categoryProviders.development} />}
            {s.categoryModels?.development    && <KV k="Development model"    v={s.categoryModels.development} mono />}
            {s.categoryProviders?.governance  && <KV k="Governance provider" v={s.categoryProviders.governance} />}
            {s.categoryModels?.governance     && <KV k="Governance model"    v={s.categoryModels.governance} mono />}
          </div>
        </>
      )}

      {s.guidelines && (
        <>
          <div style={subHeaderStyle}>Guidelines (project-level)</div>
          <pre style={preStyle}>{s.guidelines}</pre>
        </>
      )}

      {s.protocolOverride && (
        <>
          <div style={subHeaderStyle}>Agent Protocol Override (replaces default for ALL agents)</div>
          <pre style={preStyle}>{s.protocolOverride}</pre>
        </>
      )}

      {s.agentConfigs && Object.keys(s.agentConfigs).length > 0 && (
        <>
          <div style={subHeaderStyle}>Per-agent overrides ({Object.keys(s.agentConfigs).length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {Object.entries(s.agentConfigs).map(([slug, cfg]) => (
              <div key={slug} style={cardRowStyle}>
                <span style={{ fontWeight: 600 }}>{slug}</span>
                {cfg.disabled && <span style={pillStyle("amber")}>Disabled</span>}
                {cfg.provider && <span style={smallText}>provider: {cfg.provider}</span>}
                {cfg.model    && <span style={smallText}>model: <code style={codeStyle}>{cfg.model}</code></span>}
                {cfg.maxTokens !== undefined  && <span style={smallText}>max_tokens: {cfg.maxTokens}</span>}
                {cfg.maxToolRounds !== undefined && <span style={smallText}>rounds: {cfg.maxToolRounds}</span>}
                {cfg.timeoutMs !== undefined  && <span style={smallText}>timeout: {cfg.timeoutMs}ms</span>}
                {cfg.guidelines && <span style={smallText}>+guidelines</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {s.cliAgents && (
        <>
          <div style={subHeaderStyle}>CLI Agents config</div>
          <div style={gridStyle}>
            <KV k="Enabled"       v={s.cliAgents.enabled ? "Yes" : "No"} />
            {s.cliAgents.defaultCli       && <KV k="Default CLI"      v={s.cliAgents.defaultCli} mono />}
            {s.cliAgents.executionBackend && <KV k="Backend"          v={s.cliAgents.executionBackend} />}
            {s.cliAgents.localBasePath    && <KV k="Local base path"  v={s.cliAgents.localBasePath} mono />}
            {s.cliAgents.defaultMaxTurns !== undefined && <KV k="Default max turns" v={String(s.cliAgents.defaultMaxTurns)} />}
            {s.cliAgents.mcpEnabled !== undefined      && <KV k="MCP enabled"   v={s.cliAgents.mcpEnabled ? "Yes" : "No"} />}
            {s.cliAgents.hooksEnabled !== undefined    && <KV k="Hooks enabled" v={s.cliAgents.hooksEnabled ? "Yes" : "No"} />}
          </div>

          {s.cliAgents.agentOverrides && Object.keys(s.cliAgents.agentOverrides).length > 0 && (
            <>
              <div style={subHeaderStyle}>Per-agent CLI overrides ({Object.keys(s.cliAgents.agentOverrides).length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {Object.entries(s.cliAgents.agentOverrides).map(([slug, ov]) => (
                  <div key={slug} style={cardRowStyle}>
                    <span style={{ fontWeight: 600 }}>{slug}</span>
                    <span style={pillStyle(ov.enabled ? "green" : "amber")}>{ov.enabled ? "Enabled" : "Disabled"}</span>
                    <span style={smallText}>cli: {ov.cli}</span>
                    {ov.authMode  && <span style={smallText}>auth: {ov.authMode}</span>}
                    {ov.model     && <span style={smallText}>model: <code style={codeStyle}>{ov.model}</code></span>}
                    {ov.max_turns !== undefined && <span style={smallText}>turns: {ov.max_turns}</span>}
                    {ov.effort    && <span style={smallText}>effort: {ov.effort}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

function IntegrationsBlock({ plan }: { plan: SprintPlan }) {
  const t = plan.tenantIntegrations;
  return (
    <>
      <SectionTitle icon={<KeyRound size={14} />} label="Integrations Available (names only — no values)" />
      <div style={gridStyle}>
        <KV k="GitHub"           v={t.githubConfigured  ? "Configured" : "Not configured"} />
        <KV k="Trigger.dev"      v={t.triggerConfigured ? "Configured" : "Not configured"} />
        <KV k="Provider keys"    v={t.providerKeys.length > 0 ? `${t.providerKeys.length} found` : "None"} />
      </div>
      {t.providerKeys.length > 0 && (
        <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--overlay0)" }}>
          {t.providerKeys.join(" · ")}
        </div>
      )}
    </>
  );
}

function ExecutionBlock({ plan }: { plan: SprintPlan }) {
  return (
    <>
      <SectionTitle icon={<Zap size={14} />} label="Execution (this sprint)" />
      <div style={gridStyle}>
        <KV k="Gates"      v={plan.execution.bypassGates ? "Bypassed" : "Enforced"} />
        <KV k="Max turns"  v={String(plan.execution.defaultMaxTurns)} />
        <KV k="Budget"     v={plan.execution.budgetUsd !== undefined ? `$${plan.execution.budgetUsd}` : "—"} />
        <KV k="Detailed monitoring" v={plan.execution.detailedMonitoring ? "On" : "Off"} />
        {plan.execution.startFromStep !== undefined && <KV k="Start at step" v={String(plan.execution.startFromStep)} />}
        {plan.execution.endAtStep      !== undefined && <KV k="End at step"   v={String(plan.execution.endAtStep)}   />}
      </div>

      {plan.sprint.originalBriefing && (
        <>
          <div style={subHeaderStyle}>Original briefing for this sprint</div>
          <pre style={preStyle}>{plan.sprint.originalBriefing}</pre>
        </>
      )}

      {plan.sprint.runNote && (
        <>
          <div style={subHeaderStyle}>Run note (operator)</div>
          <pre style={preStyle}>{plan.sprint.runNote}</pre>
        </>
      )}
    </>
  );
}

function SprintOverridesBlock({ plan }: { plan: SprintPlan }) {
  const o = plan.sprintOverrides;
  const has =
    o.provider || o.model
    || o.maxTurnsOverride !== undefined
    || (o.contextSprintIds && o.contextSprintIds.length > 0)
    || (o.stepRoutingOverrides && Object.keys(o.stepRoutingOverrides).length > 0)
    || (o.agentInstructions && Object.keys(o.agentInstructions).length > 0);
  if (!has) return null;
  return (
    <>
      <SectionTitle icon={<FileText size={14} />} label="Sprint Overrides (set in Start Sprint modal)" />
      <div style={gridStyle}>
        {o.provider && <KV k="Provider override" v={o.provider} />}
        {o.model    && <KV k="Model override"    v={o.model} mono />}
        {o.maxTurnsOverride !== undefined && <KV k="Max turns override" v={String(o.maxTurnsOverride)} />}
        {o.contextSprintIds && o.contextSprintIds.length > 0 && <KV k="Context sprints" v={`${o.contextSprintIds.length} selected`} />}
        {o.contextCategories && o.contextCategories.length > 0 && <KV k="Context categories" v={o.contextCategories.join(", ")} />}
      </div>

      {o.stepRoutingOverrides && Object.keys(o.stepRoutingOverrides).length > 0 && (
        <>
          <div style={subHeaderStyle}>Per-step routing overrides ({Object.keys(o.stepRoutingOverrides).length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {Object.entries(o.stepRoutingOverrides).map(([stepNum, r]) => (
              <div key={stepNum} style={cardRowStyle}>
                <span style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>#{stepNum}</span>
                <span style={pillStyle(r.mode === "api" ? "blue" : r.mode === "cli-api" ? "violet" : "green")}>{r.mode}</span>
                {r.cli   && <span style={smallText}>cli: {r.cli}</span>}
                {r.model && <span style={smallText}>model: <code style={codeStyle}>{r.model}</code></span>}
              </div>
            ))}
          </div>
        </>
      )}

      {o.agentInstructions && Object.keys(o.agentInstructions).length > 0 && (
        <>
          <div style={subHeaderStyle}>Per-step instructions ({Object.keys(o.agentInstructions).length})</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {Object.entries(o.agentInstructions).map(([stepNum, instr]) => (
              <div key={stepNum} style={cardRowStyle}>
                <span style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>#{stepNum}</span>
                {instr.override && <span style={pillStyle("amber")}>Override</span>}
                <span style={{ flex: 1, minWidth: 0, color: "var(--subtext0)" }}>
                  {instr.text.length > 140 ? `${instr.text.slice(0, 140)}…` : instr.text}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/**
 * Storage & Output — always-visible block covering: where artifacts will land
 * (resolved storage path including tenant/factory/project segments), the
 * provenance of the local base path (configured vs homedir fallback), git
 * status for local-git (auto-commit / auto-push), and the destination list
 * with explicit handling for the empty / tenant-legacy-fallback cases.
 *
 * The data behind this block — execution.localBasePathSource, gitAutoPush,
 * destinationsResolution — is filled in by the sprint-plan composer; the
 * rendering here is purely presentational.
 */
function StorageOutputBlock({ plan, project }: { plan: SprintPlan; project: DBProjectMin }) {
  const { mode, backend, localBasePath, localBasePathSource, gitAutoCommit, gitAutoPush } = plan.execution;
  const tenantSlug  = plan.project.tenant.slug;
  const factorySlug = plan.project.factory.slug;
  const projectSlug = project.slug;
  const sprintNum   = plan.sprint.num;

  // Resolved artifact path the worker will actually use, by mode.
  let storagePath: string;
  if (mode === "cloud") {
    storagePath = `Supabase Storage / TwinPilotBucket / TwinPilotProjects/${tenantSlug}/${factorySlug}/${projectSlug}/staging/sprint-${sprintNum}`;
  } else if (mode === "local") {
    storagePath = `${localBasePath ?? "~"}/TwinPilotProjects/${tenantSlug}/${factorySlug}/${projectSlug}/staging/sprint-${sprintNum}`;
  } else {
    // local-git: artifacts at project root, versioned via .git
    storagePath = `${localBasePath ?? "~"}/TwinPilotProjects/${tenantSlug}/${factorySlug}/${projectSlug}/`;
  }

  const ModeIcon  = mode === "cloud" ? Cloud : mode === "local" ? FolderOpen : GitBranch;
  const modeColor = mode === "cloud" ? "blue" : mode === "local" ? "green" : "mauve";
  const modeLabel = mode === "cloud" ? "Cloud" : mode === "local" ? "Local" : "Local + Git";

  const sourceLabel: Record<NonNullable<typeof localBasePathSource>, string> = {
    "sprint":          "from sprint override",
    "project":         "from project setting",
    "tenant":          "from tenant storage backend",
    "homedir-default": "homedir fallback (~/TwinPilotProjects)",
  };

  return (
    <>
      <SectionTitle icon={<HardDrive size={14} />} label="Storage & Output" />

      <div style={gridStyle}>
        <KV k="Mode" v={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ModeIcon size={11} />
            <span style={pillStyle(modeColor)}>{modeLabel}</span>
            <span style={{ fontSize: 10, color: "var(--overlay0)" }}>(backend: {backend})</span>
          </span>
        } />
        <KV k="Where" v={storagePath} mono />
        {mode !== "cloud" && localBasePathSource && (
          <KV k="Path source" v={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span>{sourceLabel[localBasePathSource]}</span>
              {localBasePathSource === "homedir-default" && (
                <span style={pillStyle("amber")}>fallback</span>
              )}
            </span>
          } />
        )}
        {mode === "local-git" && (
          <>
            <KV k="Auto-commit" v={
              <span style={pillStyle(gitAutoCommit ? "green" : "amber")}>{gitAutoCommit ? "On" : "Off (manual)"}</span>
            } />
            <KV k="Auto-push" v={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={pillStyle(gitAutoPush ? "green" : "amber")}>{gitAutoPush ? "On" : "Manual"}</span>
                {!gitAutoPush && <span style={{ fontSize: 10, color: "var(--overlay0)" }}>(auto-push lands in Phase 5)</span>}
              </span>
            } />
          </>
        )}
      </div>

      {/* Destinations — always rendered. The composer fills
          destinationsResolution so empty / fallback cases are surfaced
          explicitly instead of just rendering an empty list. */}
      <div style={subHeaderStyle}>
        Destinations ({plan.outputDestinations.length})
        {plan.destinationsResolution === "tenant-legacy" && (
          <span style={{ ...pillStyle("amber"), marginLeft: 8 }}>tenant fallback</span>
        )}
        {plan.destinationsResolution === "none" && (
          <span style={{ ...pillStyle("red"), marginLeft: 8 }}>none configured</span>
        )}
      </div>

      {plan.outputDestinations.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {plan.outputDestinations.map((d) => (
            <div key={d.id} style={cardRowStyle}>
              <span style={{ fontWeight: 600 }}>{d.label}</span>
              <span style={smallText}>{d.type}</span>
              <span style={pillStyle(d.auto_push ? "green" : "amber")}>
                {d.auto_push ? "Auto-push" : "Manual export"}
              </span>
              <span style={{ color: "var(--overlay1)", fontSize: 11 }}>{d.sublabel}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--peach)", lineHeight: 1.5 }}>
          No destinations selected for this project. The sprint runs, but
          there&apos;s nowhere to push artifacts. Pick destinations under{" "}
          <strong>Project Settings → Output Destinations</strong>.
        </div>
      )}
    </>
  );
}

/**
 * Backlog focus — items the operator picked in the Start Sprint modal.
 * Hidden when the sprint isn't backlog-driven so the legacy flow stays
 * uncluttered. Each item shows title + description preview; the
 * order_index drives the list order to match what the agent will see.
 */
function BacklogBlock({ plan }: { plan: SprintPlan }) {
  const items = plan.backlogItems ?? [];
  if (items.length === 0) return null;
  return (
    <>
      <SectionTitle icon={<ListTodo size={14} />} label={`Backlog focus (${items.length} item${items.length === 1 ? "" : "s"})`} />
      <div style={{ fontSize: 11, color: "var(--overlay0)", marginBottom: 8, lineHeight: 1.5 }}>
        These items will flip <code style={codeStyle}>todo → doing</code> at dispatch and <code style={codeStyle}>doing → done</code> on success.
        The agents see them after the original briefing as a single bundle (one sprint = one commit).
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((it, i) => (
          <div key={it.id} style={{
            display: "flex", flexDirection: "column", gap: 3,
            padding: "8px 10px", borderRadius: 7,
            background: "var(--surface0)", border: "1px solid var(--surface1)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)", width: 18 }}>
                #{i + 1}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.4 }}>
                {it.title}
              </span>
            </div>
            {it.description && (
              <div style={{ fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4, marginLeft: 24 }}>
                {it.description}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function KnowledgeBlock({ plan }: { plan: SprintPlan }) {
  if (!plan.knowledgeBase.enabled) return null;
  return (
    <>
      <SectionTitle icon={<Database size={14} />} label={`Knowledge Base (${plan.knowledgeBase.instances.length} instance${plan.knowledgeBase.instances.length !== 1 ? "s" : ""})`} />
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {plan.knowledgeBase.instances.map((i) => (
          <div key={i.id} style={cardRowStyle}>
            <span style={{ fontWeight: 600 }}>{i.name}</span>
            <span style={smallText}>{i.sourceCount} source{i.sourceCount !== 1 ? "s" : ""}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "var(--overlay0)", marginTop: 6 }}>
        Agents reach the KB via <code style={codeStyle}>search_knowledge</code> — content is fetched at runtime, not embedded in the plan.
      </div>
    </>
  );
}

function CrossSprintBlock({ plan }: { plan: SprintPlan }) {
  if (plan.crossSprintArtifacts.length === 0) return null;
  const bySprint = new Map<number, typeof plan.crossSprintArtifacts>();
  for (const a of plan.crossSprintArtifacts) {
    const arr = bySprint.get(a.sprintNum) ?? [];
    arr.push(a);
    bySprint.set(a.sprintNum, arr);
  }
  return (
    <>
      <SectionTitle icon={<Users size={14} />} label={`Cross-sprint Context (${plan.crossSprintArtifacts.length} artifact${plan.crossSprintArtifacts.length !== 1 ? "s" : ""})`} />
      {[...bySprint.entries()].sort((a, b) => a[0] - b[0]).map(([num, arts]) => (
        <div key={num} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay1)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>Sprint {num}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {arts.map((a) => (
              <div key={a.ref} style={cardRowStyle}>
                <span style={{ fontWeight: 600 }}>{a.agent}</span>
                <span style={pillStyle("blue")}>{a.category}</span>
                <code style={{ ...codeStyle, fontSize: 10, color: "var(--overlay0)" }}>{a.ref}</code>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/* ── Step card (collapsible per step + per section) ────────────────────── */

function StepCard({
  step, expanded, onToggle, expandedSections, onToggleSection,
}: {
  step: SprintPlanStep;
  expanded: boolean;
  onToggle: () => void;
  expandedSections: Set<string>;
  onToggleSection: (title: string) => void;
}) {
  const routingLabel =
    step.routing.mode === "api" ? "API"
    : step.routing.mode === "cli-api" ? `CLI · API (${step.routing.cli})`
    : `CLI · SUBS (${step.routing.cli})`;

  return (
    <div style={stepCardStyle}>
      <button
        onClick={onToggle}
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          width: "100%", textAlign: "left", padding: "12px 14px",
          display: "flex", alignItems: "center", gap: 10, color: "inherit",
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {step.agent.icon && <span style={{ fontSize: 18 }}>{step.agent.icon}</span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>#{step.step}</span>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{step.agent.name}</span>
            <span style={{ fontSize: 10, color: "var(--overlay0)", fontFamily: "var(--font-mono)" }}>{step.agent.slug}</span>
            {step.phaseName && <span style={{ fontSize: 10, color: "var(--overlay1)", textTransform: "uppercase", letterSpacing: "0.04em" }}>· {step.phaseName}</span>}
            {step.gate === "human" && <span style={pillStyle("amber")}>Human gate</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 3, fontSize: 11 }}>
            <span style={pillStyle(step.routing.mode === "api" ? "blue" : step.routing.mode === "cli-api" ? "violet" : "green")}>{routingLabel}</span>
            {step.model.effective && <span style={{ color: "var(--overlay1)", fontFamily: "var(--font-mono)" }}>{step.model.effective}</span>}
            {!step.model.effective && step.model.source === "session-default" && <span style={{ color: "var(--overlay1)" }}>session default</span>}
            {step.model.note && <span style={{ color: "var(--yellow)", fontSize: 10 }}>· {step.model.note}</span>}
          </div>
        </div>
      </button>

      {expanded && (
        <div style={{ padding: "0 14px 14px 40px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={gridStyle}>
            <KV k="Tools"       v={step.agent.tools.length > 0 ? step.agent.tools.join(", ") : "—"} mono />
            <KV k="Max turns"   v={String(step.limits.maxTurns)} />
            {step.limits.effort     && <KV k="Effort"    v={step.limits.effort} />}
            {step.limits.budgetUsd  !== undefined && <KV k="Budget"    v={`$${step.limits.budgetUsd}`} />}
            {step.limits.timeoutSecs !== undefined && <KV k="Timeout"   v={`${step.limits.timeoutSecs}s`} />}
            {step.model.provider && <KV k="Provider"  v={step.model.provider} />}
            {step.model.requested && <KV k="Requested model" v={step.model.requested} mono />}
            {step.model.effective && <KV k="Effective model" v={step.model.effective} mono />}
            <KV k="Model source" v={step.model.source} />
          </div>

          {step.operatorInstruction && (
            <div>
              <div style={subHeaderStyle}>
                Operator instruction (this step){step.operatorInstruction.override ? " · OVERRIDE" : ""}
              </div>
              <pre style={preStyle}>{step.operatorInstruction.text}</pre>
            </div>
          )}

          {step.agent.persona && (
            <CollapsibleSection title="Persona" open={expandedSections.has(`${step.step}:Persona`)} onToggle={() => onToggleSection("Persona")}>
              <pre style={preStyle}>{step.agent.persona}</pre>
            </CollapsibleSection>
          )}

          {step.agent.guidelines && (
            <CollapsibleSection title="Guidelines" open={expandedSections.has(`${step.step}:Guidelines`)} onToggle={() => onToggleSection("Guidelines")}>
              <pre style={preStyle}>{step.agent.guidelines}</pre>
            </CollapsibleSection>
          )}

          <div style={subHeaderStyle}>Task sent to the agent</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {step.task.sections.map((s) => {
              const key = `${step.step}:${s.title}`;
              const open = expandedSections.has(key) || s.collapsed === false;
              return (
                <CollapsibleSection key={s.title} title={s.title} open={open} onToggle={() => onToggleSection(s.title)}>
                  <pre style={preStyle}>{s.content}</pre>
                </CollapsibleSection>
              );
            })}
          </div>

          {step.inputs.additional.length > 0 && (
            <div>
              <div style={subHeaderStyle}>Upstream refs (placeholders — resolved at runtime)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {step.inputs.additional.map((r) => (
                  <div key={`${r.step}-${r.agent}`} style={cardRowStyle}>
                    <span style={{ fontWeight: 600 }}>{r.agent}</span>
                    <span style={smallText}>step {r.step}</span>
                    <code style={{ ...codeStyle, fontSize: 10 }}>{r.ref}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CollapsibleSection({
  title, open, onToggle, children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ border: "1px solid var(--surface1)", borderRadius: 8, background: "var(--surface0)" }}>
      <button
        onClick={onToggle}
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          width: "100%", textAlign: "left", padding: "8px 12px",
          display: "flex", alignItems: "center", gap: 8, color: "inherit",
          fontSize: 12, fontWeight: 600,
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
      </button>
      {open && <div style={{ padding: "0 12px 12px" }}>{children}</div>}
    </div>
  );
}

/* ── Shared primitives ─────────────────────────────────────────────────── */

function SectionTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 22, marginBottom: 10 }}>
      {icon} {label}
    </div>
  );
}

function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 10, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{k}</span>
      <span style={{ fontSize: 12, color: "var(--text)", fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

function pillStyle(tone: "blue" | "violet" | "green" | "amber" | "red" | "mauve"): React.CSSProperties {
  const map = {
    blue:   { bg: "rgba(20,99,255,0.12)",  fg: "#5b9aff" },
    violet: { bg: "rgba(124,92,252,0.12)", fg: "var(--mauve)" },
    mauve:  { bg: "rgba(203,166,247,0.12)", fg: "var(--mauve)" },
    green:  { bg: "rgba(28,191,107,0.12)", fg: "var(--green)" },
    amber:  { bg: "rgba(245,159,0,0.12)",  fg: "var(--peach)" },
    red:    { bg: "rgba(243,139,168,0.14)", fg: "var(--red)" },
  }[tone];
  return {
    display: "inline-flex", alignItems: "center", gap: 3,
    padding: "1px 7px", borderRadius: 99,
    background: map.bg, color: map.fg,
    fontSize: 10, fontWeight: 700,
    textTransform: "uppercase", letterSpacing: "0.04em",
  };
}

/* ── Styles ────────────────────────────────────────────────────────────── */

const backdropStyle: React.CSSProperties = {
  position: "fixed", inset: 0,
  background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)",
  display: "flex", alignItems: "center", justifyContent: "center",
  zIndex: 200, padding: 16,
};

const dialogStyle: React.CSSProperties = {
  background: "var(--mantle)", border: "1px solid var(--surface0)",
  borderRadius: 14, width: "min(960px, 96vw)", height: "min(92vh, 920px)",
  display: "flex", flexDirection: "column",
  boxShadow: "0 32px 80px rgba(0,0,0,0.55)",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  gap: 12, padding: "16px 20px",
  borderBottom: "1px solid var(--surface0)",
  background: "var(--crust)",
};

const bodyStyle: React.CSSProperties = {
  flex: 1, overflowY: "auto",
  padding: "20px 24px 24px",
};

const footerStyle: React.CSSProperties = {
  display: "flex", justifyContent: "flex-end", gap: 8,
  padding: "12px 20px",
  borderTop: "1px solid var(--surface0)",
  background: "var(--crust)",
};

const primaryBtnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "8px 16px", borderRadius: 8, border: "none",
  background: "var(--blue)", color: "#fff",
  fontSize: 12, fontWeight: 700,
  cursor: "pointer", fontFamily: "var(--font-sans)",
};

const ghostBtnStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 5,
  padding: "8px 14px", borderRadius: 8,
  border: "1px solid var(--surface1)", background: "transparent",
  color: "var(--subtext1)", fontSize: 12,
  cursor: "pointer", fontFamily: "var(--font-sans)",
};

const warnBoxStyle: React.CSSProperties = {
  padding: "10px 14px", borderRadius: 8, marginBottom: 16,
  background: "rgba(245,159,0,0.08)", border: "1px solid rgba(245,159,0,0.25)",
  color: "var(--peach)", fontSize: 12, lineHeight: 1.5,
};

const errBoxStyle: React.CSSProperties = {
  padding: "10px 14px", borderRadius: 8, marginBottom: 16,
  background: "rgba(228,75,95,0.08)", border: "1px solid rgba(228,75,95,0.25)",
  color: "var(--red)", fontSize: 12,
  display: "flex", alignItems: "center", gap: 6,
};

const gridStyle: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: 14, padding: "12px 14px",
  background: "var(--base)", border: "1px solid var(--surface0)",
  borderRadius: 10, marginBottom: 8,
};

const cardRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
  padding: "7px 12px", background: "var(--base)",
  border: "1px solid var(--surface0)", borderRadius: 8,
};

const stepCardStyle: React.CSSProperties = {
  background: "var(--base)", border: "1px solid var(--surface0)",
  borderRadius: 10, overflow: "hidden",
};

const preStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.55,
  color: "var(--subtext0)", background: "var(--crust)",
  padding: "10px 12px", borderRadius: 6,
  margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
  maxHeight: 420, overflowY: "auto",
  border: "1px solid var(--surface1)",
};

const subHeaderStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: "var(--overlay1)",
  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, marginTop: 8,
};

const codeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: 11,
  color: "var(--text)", background: "var(--surface0)",
  padding: "1px 6px", borderRadius: 4,
};

const smallText: React.CSSProperties = {
  fontSize: 11, color: "var(--overlay0)",
};

// X is imported but unused here — keep for future close button if we add one
void X;
