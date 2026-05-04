---
title: Built-In agents
icon: 🤖
category: User Guides
order: 28
color: g
parent: gs-projects
---

# 🤖 Built-In agents

The platform ships a small set of canonical agents under the **Built-In** organisation in the Marketplace. Install the **Built-In Templates** factory once into your tenant and you get the whole team. Today there are two:

| Agent | Slug | Role | Where it runs |
|---|---|---|---|
| **Product Owner** | `product-owner` | Maintains the kanban — adds, refines, re-prioritises items based on briefing + recent outcomes | Discovery sprints |
| **Pipeline Composer** | `pipeline-composer` | Designs the next execution sprint pipeline by picking from the factory catalog | Discovery sprints (last step) |

Together they form an **autonomous discovery loop**: PO keeps the backlog focused; Composer designs the team for the next execution sprint. The kanban is the shared state; verdicts close the loop.

---

## ⚙️ Setup

1. **Marketplace → Stores → Built-In → Built-In Templates → Install** into the factory you want
2. Both agents appear in **Studio** under that factory
3. **Project Settings → Pipeline → Discovery** — wire the agents in this order: `product-owner` first (populates kanban) → `pipeline-composer` last (reads populated kanban)
4. **Project Settings → CLI Agents** → check **Auto-compose** if you want execution sprints to consume the pipeline-composer's proposals automatically

---

## 🧑‍💼 Product Owner

**What it does**: every discovery sprint, the PO reads the existing kanban + recent outcomes, then refines or adds items.

**MCP tools used**:
- `read_backlog_items` — load current state (always called first)
- `read_sprint_outcomes` — see what shipped or stalled in the last 5 sprints
- `update_backlog_items` — refine titles, sharpen descriptions, re-prioritise via `order_index`, mark stale items as cancelled, apply tags
- `add_backlog_items` — only for genuinely new work (compares titles to avoid duplicates)

**Tags**: PO uses `metadata.tags` (string array, slug-case) to group related items — `auth-revamp`, `onboarding-flow`, `perf-budget`. Reuses existing tags before inventing new ones. Multi-tag per item allowed. The kanban card shows the first 3 tags as `#tag` chips.

> 🔍 **Filter by tag**: the kanban page has a tag filter bar above the columns. Each unique tag in the project becomes a clickable chip with a count. Click to scope the kanban to that tag; click multiple for OR logic; click `untagged` to see items without any tag; click `clear` to reset.

**Sprint history badge** on each card (`🔁 N`): tooltip lists every sprint that touched the item plus its outcome. Maintained automatically by a postgres trigger — no manual bookkeeping.

**Anti-loops**: persona explicitly tells the agent to:
- Never re-emit items already in done/cancelled
- Compare new items against current state (lowercase + trimmed match)
- Stay focused on the briefing
- Not split tasks unnecessarily

---

## 🧠 Pipeline Composer

**What it does**: composes the next execution sprint's pipeline. Picks agents from the factory catalog, optionally suggests model + reasoning effort + plan-mode per step.

**Tools used**:
- `propose_pipeline` — emits an ordered list of `{ agent, model?, effort?, plan_mode? }` to `sprints.composed_pipeline`. The next execution sprint dispatcher reads this when **Auto-compose** is on.

**Validation**: every agent slug must exist in the factory catalog at consumption time. Renamed/deleted agent → fall back to project default pipeline (proposal stays on the discovery sprint for audit).

**When to wire**: as the **last** step of the discovery pipeline. PO populates the kanban first; Composer reads the populated kanban + briefing + outcome history to decide the team.

> See **Auto-compose** in Project Settings → CLI Agents to toggle the consumer side. When off, proposals are stored but next execution still uses the project default.

---

## 📋 Recommended discovery pipeline

```
[ scout / domain-explorer ]   ← optional, project-specific
[ product-owner            ]   ← maintains kanban
[ pipeline-composer            ]   ← designs next execution
```

The first slot is optional — for early-stage projects the PO can decompose the briefing on its own. For mature projects, having a domain-aware agent populate findings first lets the PO refine instead of inventing from scratch.

---

## 🚑 Common issues

### "PO keeps adding duplicates"

Persona didn't read kanban first, OR comparison was too strict (e.g., the agent worded the same idea differently). Tighten the role: "Read all todo+doing+done items. If a NEW item rephrases an existing one, skip — refine the existing item via update_backlog_items instead."

### "Sprint history badge missing on items from before this update"

Trigger only fires on UPDATEs that change `sprint_id` after migration 132 was applied. Pre-existing items keep an empty history until the next sprint touches them.

### "Tags don't show up in kanban"

Card renders the first 3 tags. Items with 0 tags show no chips. Tags live at `metadata.tags` (string array). Apply them via Studio edit, or let the PO emit them.

### "Meta-composer proposed an agent we just deleted"

Validation at consumption time catches this — the execution dispatcher logs a warning and falls back to the default pipeline. Re-run discovery to refresh the proposal.

---

## 🔗 Related

- **Backlog** — operator-facing kanban (where tags + sprint history surface)
- **Execution modes** — manual / kanban-manual / kanban-auto
- **Auto-pipeline (Auto-compose)** — consumer toggle for pipeline-composer proposals
