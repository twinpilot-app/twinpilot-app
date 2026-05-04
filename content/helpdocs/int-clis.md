---
title: CLI Agents
icon: 🤖
category: User Guides
order: 12
color: r
parent: integrations
---

# 🤖 CLI Agents

Run pipeline steps through coding-agent CLIs (Claude Code, Codex, Gemini CLI) instead of direct API calls. Pays off when the CLI's **own subscription** is cheaper than per-token API billing, or when its proprietary tools (plan mode, prompt caching, sandbox) outperform raw model calls.

> **Conceptually**: an agent step picks a *route* — `API` ({{brand.shortName}} calls the provider directly), `CLI API` (a CLI runs locally with an API key), or `CLI SUBS` (a CLI runs locally using its own subscription/OAuth session). All three end up at the same model — the difference is **billing path** and **tooling layer**.

---

## 🎯 When CLI mode wins

| Situation | Recommended route |
|---|---|
| Operator already pays for **Claude Pro/Max**, **ChatGPT Plus/Pro**, or **Gemini Advanced** | **CLI SUBS** — zero token cost on top of their plan |
| You need claude-code's **plan mode** or **subagent isolation** | **CLI SUBS** or **CLI API** with `claude-code` |
| Cloud-mode dispatch with no operator machine | **API** — CLIs can't run in the cloud worker |
| Sprint runs on the operator's laptop and they have an API key handy | **CLI API** — the CLI binary handles agentic loops, but billing is per-token |

CLI SUBS only works in **Local** or **Local + Git** modes — there's no operator session in cloud workers.

---

## 🔑 Supported CLIs (first-party)

These three are tightly integrated. Each is a CLI from the same vendor that owns the model — subscription mode unlocks the operator's existing plan.

### Claude Code (Anthropic)

- **Binary**: `claude` (install: `npm i -g @anthropic-ai/claude-code`)
- **API key var**: `ANTHROPIC_API_KEY`
- **Subscription path**: `claude login` (OAuth → Pro/Max session)
- **MCP**: ✅ Native — {{brand.shortName}} writes `.mcp.json` and the CLI reads it.
- **Subagent isolation**: ✅ Native — {{brand.shortName}} writes `.claude/agents/{slug}.md` so each step runs in its own subagent context, no cross-contamination.
- **Per-step tuning**: effort (low/medium/high/max), plan mode (research-only, no writes), budget cap in USD. Configure via the Sliders icon in the Start Sprint modal.

### Codex (OpenAI)

- **Binary**: `codex` (install: `npm i -g @openai/codex` — Rust-based; the older TS CLI is EOL)
- **API key var**: `OPENAI_API_KEY`
- **Subscription path**: `codex login` (OAuth → ChatGPT Plus/Pro session, stored in `~/.codex/auth.json`)
- **MCP**: ✅ Wired since `0.2.37`. {{brand.shortName}} writes `{workdir}/.codex/config.toml` and pins `CODEX_HOME` to that directory so the per-sprint config is read instead of the operator's global one.
- **Subagent isolation**: ❌ No equivalent. The full briefing goes inline via stdin; the agent reads `CLAUDE.md` and `.tp/BRIEFING.md` from the workdir.
- **Per-step tuning**: not exposed yet (claude-code only).

### Gemini CLI (Google)

- **Binary**: `gemini` (install: `npm i -g @google/gemini-cli`)
- **API key var**: `GEMINI_API_KEY`
- **Subscription path**: `gemini auth` (OAuth → Google One AI Premium / Gemini Advanced)
- **MCP**: ✅ Wired since `0.2.37`. {{brand.shortName}} writes `{workdir}/.gemini/settings.json`; gemini reads it from cwd automatically.
- **Subagent isolation**: ❌ No equivalent. Briefing inline, same as codex.
- **Per-step tuning**: not exposed yet (claude-code only).

---

## ⚠️ Remaining differences between CLIs

MCP is now available for all three first-party CLIs. The remaining gap is **subagent isolation** — claude-code's `.claude/agents/{slug}.md` per-step containers don't have an equivalent in codex/gemini-cli. Each step's briefing goes inline via stdin and the agent reads `CLAUDE.md` + `.tp/BRIEFING.md` from disk:

| Capability | claude-code | codex / gemini-cli |
|---|:---:|:---:|
| Read sibling agent outputs (this sprint, MCP) | ✅ | ✅ |
| Read past-sprint artifacts (MCP) | ✅ | ✅ |
| `add_backlog_items` (discovery agents) | ✅ | ✅ |
| `query_knowledge` (RAG) | ✅ | ✅ |
| `read_project_settings`, `list_sprint_steps` | ✅ | ✅ |
| Subagent containment (each step in its own context) | ✅ via `.claude/agents/` | ❌ briefing-inline only |

**Practical guidance**:

- All three CLIs are now viable in Local, Local + Git, and Cloud modes.
- **Long pipelines (5+ steps) on codex/gemini** can drift more than on claude-code because there's no per-step subagent reset — the agent might pull context from earlier steps in the same conversation. Mitigation: each step gets a fresh CLI subprocess ({{brand.shortName}} does this regardless), so the only "drift" risk is within a step's own multi-turn loop.
- **Per-step Claude Code tuning** (effort/plan-mode/budget) only works for claude-code. Equivalents for codex/gemini are vendor-specific and not exposed yet.

---

## 🔧 Setup

### 1. Install the CLI on the operator's machine

Whichever CLI(s) you'll use — install globally so the worker can spawn the binary.

### 2. Pick auth mode per CLI

**Subscription (CLI SUBS)** — cheapest if you already pay for the plan:

```bash
claude login          # Anthropic Pro/Max
codex login           # ChatGPT Plus/Pro
gemini auth           # Google One AI Premium
```

The CLI stores credentials in its own dotfile (`~/.claude.json`, `~/.codex/auth.json`, `~/.gemini/`). {{brand.shortName}} doesn't see them.

**API key (CLI API)** — pay per token, but works the same in cloud and local:

Go to **Settings → CLI Providers** and paste the relevant key. {{brand.shortName}} stores it encrypted, scoped per tenant, and injects it as the appropriate env var only when the step runs.

### 3. Route a step

Open the Start Sprint modal → click a step's routing pills (API / CLI API / CLI SUBS) → pick the CLI from the dropdown. Routing decisions persist on the sprint plan; you can review/change them before dispatch.

> ✅ **Tip**: route discovery sprints through claude-code (full MCP) and execution sprints through whichever CLI matches your subscription. Mix is fine — each step is independent.

---

## 🎚️ Per-step Claude Code tuning

When a step is routed to claude-code, the row gains a **Sliders icon** that opens an inline tuning panel:

| Knob | Effect | Default |
|---|---|---|
| **Effort** | Maps to `--effort` — controls thinking budget. low / medium / high / max. | unset (CLI default) |
| **Plan mode** | Swaps `--dangerously-skip-permissions` for `--permission-mode plan`. The agent researches and proposes but **does not write files**. | off |
| **Budget $** | `--max-budget-usd` cap per step. Falls back to project-level budget when unset. | unset |

**When to use plan mode**: discovery sprints where one agent should produce a *proposal* (markdown plan, structured analysis) without touching `_workspace/`. Pairs well with discovery intent. **Don't enable on execution steps** — the sprint will produce no committed output and the verdict will mark it as `no-output`.

---

## 🧱 Other CLIs (experimental)

`aider`, `plandex`, `goose`, `amp` appear in CLI dropdowns tagged **experimental** — `buildCommand` stubs exist but the path isn't validated end-to-end (no smoke testing, no MCP scaffolding for `aider`/`amp`, no per-step tuning). They're **wrapper-style**: no proprietary subscription, no proprietary models — just orchestration over the same APIs the platform already calls.

Use them at your own risk if you specifically prefer their UX (e.g., aider's git-aware diffs). `goose` and `plandex` are MCP-capable already if you need MCP via these. We'll promote any of them to first-class once an operator validates and reports back.

---

## 🔒 Workspace credentials

When you run **Prepare workspace** (dashboard button) or `tp prepare workspace` (CLI), the platform writes a small credentials file to your local working tree:

```
{project-workdir}/.tp/mcp-secrets.json   ← chmod 0600, gitignored
```

The file holds a short-lived token your CLI uses to call platform tools (read sprint artifacts, write to the backlog, propose pipelines, etc.). It expires automatically; re-running Prepare rotates it.

**What's in there**:
- The platform's public Supabase URL and anon key (same values published in any front-end build).
- A token scoped to **your tenant only** — every query is filtered server-side so it can never read or write another tenant's data, even if the token is leaked.

**What is protected by the token's tenant scope**: cross-tenant data access. Per-row authorisation is checked on the platform side; the token just says "this operator is acting as tenant X for the next 30 minutes."

**What the token does NOT grant**: schema changes, deletion of tenants/factories you don't own, or any escalated platform admin action.

**Operator hygiene**:
- Don't commit `.tp/` (already gitignored — re-running Prepare regenerates the file).
- Don't share the file or paste its contents anywhere; treat it like an SSH key.
- Re-run Prepare workspace whenever you suspect leakage. The previous token expires automatically within 30 minutes regardless.

> 🛠️ For platform engineers: the internal threat model is documented in `docs/MCP-SECURITY.md` (private).

---

## 🚑 Common issues

### "spawn claude ENOENT" (or codex/gemini)

The CLI binary isn't on the worker's `PATH`. On the operator's machine, check `which claude` (or `where claude` on Windows). On Windows specifically, npm-installed CLIs land as `.cmd` shims — {{brand.shortName}}'s worker handles the `.cmd` suffix automatically since `0.2.34`.

### Subscription mode falls back to API key

Symptom: codex/gemini-cli runs but burns API tokens instead of subscription quota. Cause: the worker's env had `OPENAI_API_KEY` / `GEMINI_API_KEY` set, which used to leak into the CLI's subprocess. Fixed in `0.2.36` — the env strip in OAuth mode now also clears those vars before spawning. Update with `twin-pilot self-update` if you're on an older CLI.

### "model not available for your subscription"

Codex/Gemini in CLI SUBS mode don't accept `--model` overrides — your plan dictates available models. {{brand.shortName}} omits `--model` automatically when authMode is OAuth. If you see this anyway, check the agent config for a hard-coded model override and clear it.

### Discovery agent didn't add backlog items

If on CLI ≥ `0.2.37`: the MCP server may have failed health-check on the operator's machine. Run `npx tsx <path>/mcp-server.ts` directly to reproduce the error. Common causes: missing `tsx` binary on PATH, broken `.tp/mcp-secrets.json` (regenerate by re-dispatching the sprint), Supabase JWT expired.

If on CLI `< 0.2.37`: codex/gemini-cli couldn't reach MCP at all. Update with `twin-pilot self-update`.

---

## 🔗 Related

- [LLM Providers](https://github.com/tirsasoftware/tirsa-factory/blob/main/services/command-center/content/helpdocs/int-providers.md) — API key configuration
- **Run a Sprint** — step routing UI walkthrough
- **Local + Git Mode** — when CLI SUBS shines
- **Storage Layout** — what each agent reads/writes
