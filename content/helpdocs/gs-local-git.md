---
title: Local + Git Mode
icon: 🔀
category: User Guides
order: 27
color: b
parent: gs-projects
---

# 🔀 Local + Git Mode

In **Local + Git** mode, your {{brand.shortName}} project IS a git working tree on your machine. Sprints commit + tag against the working tree itself, push to your configured GitHub repo, and the sprint history lives in `git log`. No staging dir, no cloud bucket — everything's in the repo.

Other modes for contrast:
- **Cloud** — agents and storage live on the platform; outputs land in the Supabase bucket; pushes to GitHub via API.
- **Local** — agents run on your machine, outputs land in `staging/sprint-N/` on disk; not a git repo.

> ✓ **Why pick Local + Git:** you want the project to BE a git repo, with each sprint as a real commit + tag you can `git checkout`. Best for code projects where you'd version sprint outputs anyway.

---

## ⚙️ Setup

1. **Project Settings → Orchestration / Storage Mode**
   - **Mode**: Local + Git
   - **Base path**: a directory on your machine (e.g. `C:\Users\you\Workspace\projects` or `~/projects`)
   - **Repository** (required): pick a destination from the factory's curated list. The URL is derived as `https://github.com/{owner}/{project.slug}`. The factory PAT is injected into the remote URL at push time (ephemerally — never persisted to `.git/config`).
   - **Branch**: usually `main` (project default)
   - **Auto-push commit + tag to origin** (default on): when off, sprints commit + tag locally and the project card shows a "ready to push" badge with the exact `git push` commands. Useful when you want to review the working tree before publishing each sprint.
   - **Use my own git credentials** (optional): when checked, the worker skips PAT injection and lets your local git config handle auth — keeps signed commits, SSH key, custom credential helpers. Pairs with a legacy free-text Repository URL field that becomes visible in this mode.

> 💡 **Why pick from a destination list instead of typing a URL?** Centralised auth: factory admin manages PATs once, projects reference them. No git CLI setup per operator. Same destination can also appear in your project's *export* destinations — flat model, no special-case filter.

2. **Working tree path** is auto-derived as:
   ```
   {base path}/TwinPilotProjects/{tenant}/{factory}/{project}/
   ```

3. **First sprint**: the worker runs `git init -b main`, sets local user/email, and adds the configured remote. If the remote repo exists with content (e.g. README from GitHub init), reconcile manually before the first sprint (see [Common issues](#common-issues)).

> ⚠ **Repository URL is required** in Local + Git. Without it, sprint dispatch fails fast with a 422. The same repo cannot also be in Output Destinations — {{brand.shortName}} filters it from the picker, since the working repo is the implicit auto-push target.

---

## 📂 What gets committed

Per sprint, the worker stages and commits these top-level paths:

```
_workspace/                 ← agent output (code, tests, configs, docs, specs, anything)
_audit/sprint-summary.md    ← sprint verdict + metrics (worker-written)
_audit/{agent}/             ← agent traces and per-agent summaries
README.md, .gitignore       ← only if present (first-sprint scaffolding)
```

Then tags the commit `sprint-N` and pushes branch + tag to your remote.

### What's NOT committed

These live at the project root but are gitignored / not in pathspec:

```
.tp/                        ← runtime secrets, MCP tokens, audit traces
.tp/audit/{agent}/          ← raw.log, events.jsonl, hooks.log (agent run traces)
.mcp.json                   ← regenerated each sprint
CLAUDE.md                   ← regenerated each sprint
.claude/                    ← claude-code state, regenerated each sprint
```

The runtime files are regenerated from your project's DB row every run — committing them just produces noise. The agent's actual outputs go in `_workspace/`; the per-sprint review goes in `_audit/sprint-summary.md`.

---

## 🏷️ Sprint = git tag

Each sprint produces:

1. **A single commit** `Sprint N: <title>` with all the agent outputs **and the sprint summary** (`_audit/sprint-summary.md`) from that sprint
2. **A tag** `sprint-N` pinning that commit

> Earlier versions emitted a second `sprint-N: post-run summary` commit + force-pushed the tag forward. That's gone — the summary is built before the commit so a single commit covers the whole sprint.

To review what sprint 3 produced:

```bash
git checkout sprint-3
ls _workspace/                  # what the agents wrote
cat _audit/sprint-summary.md    # the verdict + metrics
```

Or diff between sprints:

```bash
git diff sprint-2..sprint-3 -- _workspace/
```

The tag is the canonical "this is sprint N's frozen state". Operators can rely on it; agents can cross-reference past sprints via the MCP tool `read_sprint_artifact`.

---

## 📤 Manual push (auto-push off)

When **Auto-push** is unchecked in Project Settings:

```
Sprint dispatched
  → fetch + rebase against origin (still happens)
  → agents run, write _workspace/, _audit/
  → worker commits + tags sprint-N locally
  → ⏸ NO push — local commit + tag retained
Project card shows: "ready to push" badge
Tooltip: git push origin <branch> && git push origin sprint-N
```

The badge clears automatically once the next sprint dispatches and either re-pushes or pushes its own commit. If you want to push **before** the next sprint, run the commands from the tooltip in your project working tree.

> ✓ **When this is the right setting**: code reviews per sprint before they hit the upstream branch; CI gates that you'd rather trigger once you're sure; experimental branches where you want git-level control.

> ⚠ **What still pushes regardless**: the sprint **summary follow-up commit** still happens locally; only the network operation is gated. And **Output Destinations** (additional repos configured separately) follow their own `auto_push` per-destination — they're not affected by this toggle.

---

## 🛠️ Working between sprints

You can edit, commit, and push freely on your configured branch (e.g. `main`) between sprints. The worker reconciles before its own commit:

```
You: git commit -am "fix typo"
You: git push origin main
[time passes]
{{brand.shortName}} dispatches sprint-N:
  → git fetch origin --prune
  → git pull --rebase origin main           (integrates your commit)
  → worker stages + commits sprint-N        (parent: your commit)
  → git push origin main                    (fast-forward)
  → git tag sprint-N + push tag
```

Result: sprint-N's tag points at a commit that has your edit as ancestor. Linear history.

### What's safe

| Action between sprints | Safe? |
|---|---|
| Commit + push on configured branch | ✓ |
| Commit locally without pushing | ✓ |
| Merge a PR into your branch externally | ✓ |
| Push from another machine (laptop B, CI) | ✓ |

### What can bite

| Action between sprints | Behaviour |
|---|---|
| Force-push to remote | ✗ Rebase fails; sprint commit stays local; push fails. Reconcile manually before the next sprint. |
| Working on a feature branch when sprint dispatches | ⚠ Sprint commits + tags on whatever branch HEAD is on. The worker logs a warning and stays out of your way — switch back to the configured branch before the next sprint if that wasn't your intent. |
| Edit a file the agent regenerates (e.g. `_workspace/nomes.md`) | ⚠ Agent may overwrite. Your edit is in `git log` but may not survive in the working tree. |
| Commit `.tp/` or `.mcp.json` (gitignore them — {{brand.shortName}} doesn't inject one) | ⚠ Worker collisions when regenerating. Add them to your `.gitignore`. |

---

## 🧰 Manual mode (Prepare workspace)

If you want to drive the agents manually with `claude-code` instead of dispatching sprints, click **Prepare workspace** in Project Settings → CLI Agents (also available on the project card in the Office).

The worker writes the scaffolding without running any pipeline:

```
{project root}/
├── CLAUDE.md                   ← project briefing + rules
├── .mcp.json                   ← MCP server config
├── .tp/mcp-secrets.json        ← scoped JWT
└── .claude/agents/
    ├── intake.md               ← one file per agent in your project's pipelines
    ├── scout.md
    └── ...
```

Then `cd` into the project root and run `claude-code` (or any MCP-capable CLI). The agents are loaded; you prompt them directly. No sprint runs, no `agent_runs` rows in the DB, no automatic commits.

> Re-run **Prepare workspace** to refresh the scaffolding after editing personas in Studio. The DB is the source of truth; the on-disk files are renderings.

For details on what each file contains, see [Storage Layout](https://github.com/tirsasoftware/tirsa-factory/blob/main/docs/STORAGE-LAYOUT.md).

---

## 🚑 Common issues

### "This commit does not belong to any branch on this repository"

GitHub shows this when a sprint tag points at a commit not reachable from any branch. Causes:

- The remote's default branch (usually `main`) doesn't include the sprint commit
- The worker pushed the tag but couldn't push the branch (non-fast-forward)

Repair:

```bash
cd <your project working tree>
git fetch origin --prune
git log --oneline -10                              # confirm your local has the right history
git push origin main                               # push the branch first
git push --force origin sprint-N                   # then the tag (if it moved)
```

The worker now gates tag push on branch push success — this won't happen on new sprints, but legacy orphan tags from before need this manual repair.

### Branch name mismatch (legacy `master` vs `main`)

Old projects init'd with `master` as default. Run once:

```bash
cd <your project working tree>
git branch -M main
git push -u origin main
git push origin --tags
git push origin --delete master    # optional cleanup
```

The worker's pre-flight now `git init -b main` so new projects start on the configured branch.

### "Local + Git mode requires a repository URL"

You haven't filled in **Repository** in Project Settings → Orchestration / Storage Mode → Storage Location. Sprint dispatch refuses with a 422. Fill it in, then retry.

### Working repo appears in Output Destinations

It shouldn't — Local + Git filters it from the picker (it's the implicit auto-push target; listing it would be a no-op duplicate push). If you see it, the project's `repo_url` may not match any configured destination's `owner/{project.slug}` pattern. Open an issue.

### Worker pushed sprint commit but rebase failed

Logged in the worker output as `pull --rebase origin <branch> failed`. Reasons:
- You force-pushed remote, rewriting history
- Merge conflict between your edits and what the agent wants to commit

Reconcile manually:

```bash
cd <your project working tree>
git pull --rebase origin main          # resolve conflicts
git push origin main
git push --force origin sprint-N       # if the tag moved
```

---

## 🔗 Related

- [Storage Layout](https://github.com/tirsasoftware/tirsa-factory/blob/main/docs/STORAGE-LAYOUT.md) — full technical spec
- **Run a Sprint** — how sprint dispatch works
- **Backlog** — kanban + auto-drain in Local + Git
- **Output Destinations** — pushing to additional repos
