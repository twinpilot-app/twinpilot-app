---
title: Claude Code on {{brand.shortName}}
icon: 🛠️
category: User Guides
order: 29
color: m
parent: int-clis
---

# 🛠️ Claude Code on {{brand.shortName}}

If you've used **Claude Code** as a standalone CLI, you already know the primitives — subagents (`.claude/agents/*.md`), skills (`.claude/skills/*.md`), `CLAUDE.md`, hooks. {{brand.shortName}} doesn't replace any of them; it **wraps** them so you stop hand-crafting per-project plumbing.

This page lists what {{brand.shortName}} does for you on top of stock Claude Code, so you know what you're getting and what stays in your control.

---

## 🧱 The runtime stays the runtime

{{brand.shortName}} doesn't fork or patch Claude Code. Every sprint spawns the same `claude` binary you'd run by hand, in the same workdir layout it expects:

- `CLAUDE.md` at the project root
- `.claude/agents/{slug}.md` for the agent in flight
- `.mcp.json` for tool access
- `.tp/BRIEFING.md` with the sprint task

You can drop into the workdir mid-sprint, run `claude` manually against the same files, and get the same result. **No lock-in.**

---

## 🚀 What {{brand.shortName}} adds

### 1. Per-sprint subagent assembly

Stock Claude Code: **you** write `.claude/agents/{slug}.md` for each role you want to delegate to. One per project, edited by hand.

{{brand.shortName}}: agents live in your **factory catalog** (DB-backed). At sprint dispatch the worker materialises the right `.claude/agents/{slug}.md` for the step, with:

- the agent's persona (from the catalog),
- the **sprint-specific task** (your briefing or the backlog item title + description),
- project-level + agent-level **guidelines** (style guides, security rules),
- the right `tools:` allowlist so the subagent sees every MCP tool {{brand.shortName}} ships.

You edit the persona once in the catalog; every project that uses that agent gets the update on the next sprint.

### 2. MCP tools — already wired, project-scoped

Stock Claude Code: you author your own MCP server, configure `.mcp.json`, manage credentials.

{{brand.shortName}}: a managed MCP server runs alongside every sprint, scoped to the current project + tenant. Tools the agent can call out of the box:

| Tool | Use |
|---|---|
| `write_sprint_workspace`, `write_sprint_docs`, `write_sprint_audit` | Persist deliverables / docs / audit trails to the sprint's storage layer |
| `read_artifact`, `list_artifacts` | Read sibling agents' outputs from the same sprint |
| `read_project_file`, `list_project_files` | Read files committed to the project repo |
| `read_backlog_items`, `update_backlog_items`, `add_backlog_items` | Inspect / refine / extend the kanban (discovery agents) |
| `read_sprint_outcomes` | Learn from recent sprint verdicts |
| `propose_pipeline` | Compose the next execution sprint (pipeline-composer pattern) |
| `consult_agent` | Ask another agent in the same factory a focused question — one-shot, no tools |
| `escalate_to_human` | Operator notification when the agent is genuinely stuck |
| `search_knowledge`, `fetch_url`, `list_knowledge_sources` | RAG (when knowledge sources are configured) |

Tenant isolation is enforced via short-lived JWTs — no cross-tenant data access through any of these tools.

### 3. Workspace prep, every time

Stock Claude Code: it's on you to clone the repo, configure git identity, install deps, set the right branch. If credentials are wrong, you fix it.

{{brand.shortName}}: before the first agent runs in a sprint, the worker:

- resolves your project's repo (working repository or destination),
- clones it with the GitHub token injected (private repos work without prompting),
- sets git identity, checks out your configured working branch,
- writes `.gitignore` rules for sprint scratch dirs.

Failures here are caught **before** any LLM cost — you see a clear `workspace prep failed` error, not a confusing agent failure.

### 4. Modes for where the work runs

Stock Claude Code: runs locally on your machine, period.

{{brand.shortName}}: same `claude` binary, three layouts:

- **Local** — workdir on your machine, persistent across sprints, source pulled from GitHub.
- **Local + Git** — workdir IS the git working tree; sprint output committed + tagged inline.
- **Cloud** — `claude` runs in a managed worker (subscription mode disabled here — use API path or a CLI that fits Cloud).

Mode switches per project; per-sprint override available when factory settings allow it.

### 5. Per-step routing, tuning, audit

Stock Claude Code: one sprint = one invocation, one model, one effort level.

{{brand.shortName}}: each step in your pipeline picks its own:

- **Route**: API direct, CLI with API key, or CLI subscription (Pro/Max plan).
- **Model override** (e.g., haiku for triage, sonnet for the implementation step).
- **Effort** (low/medium/high/max — claude-code only).
- **Plan mode** — research-only, no file writes (claude-code only).
- **Budget cap** — soft USD limit per step (claude-code only).

Every run lands on the **Twin Dashboard** with token in/out, real $ vs subscription estimate, wall time, and the agent's audit trail.

### 6. Sprint lifecycle done for you

The post-flight that you'd normally script:

- Captures every agent's stdout/stderr to the sprint audit area.
- Aggregates a `sprint-summary.md` with verdict, agent runs, cost rollup, files changed.
- (Local + Git) commits the work + tags `sprint-N` + optionally pushes (with auto-push toggle).
- Records a structured **outcome verdict** (`success` / `partial` / `no-output` / `failed`) with reason, surfaced as badges in the dashboard.

### 7. Agent-to-agent on demand

Inside any sprint, an agent can call `consult_agent("security-reviewer", "is this auth pattern OK?")` and get a focused text answer from another agent in the factory — without dispatching a full pipeline step. The consultation is recorded as a sub-run, billable and traceable, but bounded (no recursion, ~1500 token answer cap).

### 8. Backlog + auto-drain

A kanban per project, two execution modes:

- **Manual** — operator picks items per sprint.
- **Kanban (autonomous)** — a cron picks the next item, dispatches a sprint, respects cooldown / daily cap / active hours / approval gate / budget brake.

Discovery sprints can populate the kanban (via `add_backlog_items`); the **product-owner** built-in agent reviews and refines on a schedule.

---

## 🎚️ What stays in your control

- The **persona** of every agent (DB or YAML).
- The **pipeline shape** (which agents in what order, with what model).
- The **storage backend** (Supabase bucket, local filesystem, local-git repo).
- The **CLIs you use** (Claude Code, Codex, Gemini CLI — or pure API mode).
- The **provider keys** — your tenant's API keys live in your tenant_integrations.
- **Hard spending limits** — set those at your provider's console (Anthropic, OpenAI, Google). {{brand.shortName}}'s budget brake is a soft helper, not a billing guarantee.

---

## 🧭 When to leave Claude Code's primitives alone

Some things you should NOT route through {{brand.shortName}}:

- **One-off interactive sessions** — `claude` standalone, in a terminal, with your own `.claude/agents/` files. {{brand.shortName}} is for repeatable pipelines.
- **Skills triggered by you (`/slash-style`)** — those belong in a skill file, not a sprint pipeline. Add them to `.claude/skills/` directly in your repo.
- **Hooks for deterministic ops** (linting, formatting, gitignore enforcement) — Claude Code's hooks (`settings.json`) handle these without LLM cost. {{brand.shortName}} doesn't try to replace them.

---

## 🔗 Related

- **CLI Agents** (`int-clis`) — installation, subscription vs API key, supported CLIs
- **Built-In agents** (`gs-built-in-agents`) — pipeline-composer + product-owner, what they do
- **Run a Sprint** (`gs-run-sprint`) — Start Sprint walkthrough end-to-end
