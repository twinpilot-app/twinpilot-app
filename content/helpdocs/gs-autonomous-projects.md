---
title: Autonomous Projects
icon: 🤖
category: User Guides
order: 29
color: b
parent: gs-projects
---

# 🤖 Autonomous Projects

An **autonomous project** runs its backlog without you clicking *Start Sprint* each time. A scheduler picks the next `todo` item, dispatches a sprint, and repeats — until the backlog is empty or something stops the loop.

You'll know a project is autonomous because the card shows a `🤖 autonomous` badge next to its mode badge.

> **Scheduler:** A GitHub Actions cron (`.github/workflows/auto-drain-cron.yml`) ticks every 5 minutes and POSTs the auto-drain endpoint with the platform's `CRON_SECRET`. If you self-host or fork, set the repo secrets `COMMAND_CENTER_URL` and `CRON_SECRET` for the cron to fire — without them the workflow no-ops with a warning.
>
> Need to advance immediately? Use **Run next** on the kanban (button in the header when auto-drain is on). It runs the same per-project drain attempt without waiting for the next tick.

---

## ⚙️ Enabling

In **Project Settings** → toggle **Auto-drain backlog** ON. Pacing controls appear:

| Control | What It Does |
|---------|--------------|
| **Cooldown between sprints** | Minimum minutes between auto-dispatches, counted from the last sprint's completion. `0` = dispatch on next cron tick. |
| **Daily sprint cap** | Maximum auto-sprints in a rolling 24h window. `0` = unlimited. Anti-runaway when items happen to be cheap no-ops. |
| **When backlog is empty** | What to do when no `todo` items remain (see next section) |

Saving with auto-drain on also implicitly enables **auto-close sprints** so no-diff sprints don't stall the queue in `pending_save`.

---

## 🔄 What happens when the backlog is empty?

Three modes, picked in Project Settings under auto-drain:

| Mode | What happens when backlog drains |
|------|-----------------------------------|
| 🛑 **Halt and notify** | Cron skips with `backlog empty`. Notification fires once. Operator decides what's next (add items, run discovery manually, switch off auto-drain). |
| 🔍 **Run discovery once, then wait** | Cron dispatches one discovery sprint (uses the project's discovery pipeline) to generate new backlog items. After that sprint, the cron waits — even if backlog is still empty — until the operator reviews. Single-shot guard. |
| ♾️ **Keep running discovery** | Cron dispatches discovery sprints whenever the backlog drains, indefinitely. For pure-discovery projects (no kanban). Pace with cooldown + daily cap. |

**Defaults** (when nothing is picked):
- Project has a discovery pipeline configured → `Run discovery once, then wait`
- Project doesn't have a discovery pipeline → `Halt and notify`

---

## ⏸️ Editing the backlog without interruption

Auto-drain runs continuously. To edit the kanban — reorder items, drop tasks, write new ones — without dispatches firing in the middle:

1. Click **Pause** on the project card (Office) or the kanban header.
2. Edit freely. The cron skips this project with reason `paused by operator`.
3. Click **Resume** when done. Next tick picks up from the new state.

This is graceful — any sprint already in flight runs to completion. For an immediate cancel, use the red **Stop** button (only visible when a sprint is running).

---

## ⏰ Active Window

Restrict auto-drain to specific hours of the day. In Project Settings under auto-drain, set:

- **Start / end hour** (0–23) — `9` and `18` for 9 AM to 6 PM
- **Timezone** — IANA name like `America/Sao_Paulo`. Empty defaults to `UTC`

Wrap-around windows work: `22` to `6` runs from 10 PM through 6 AM. Useful for off-peak LLM pricing or "only during business hours" scenarios. Outside the window the cron skips with reason `outside active window — current hour N`.

---

## 🩺 Health Check (no-diff guard)

When the agent's output keeps matching what's already in the project (no commit produced), auto-drain would otherwise drain the backlog without making progress. Set **Halt after no-diff** to N to stop the loop after N consecutive no-commit sprints. Sends an `Auto-drain unproductive` notification so you can inspect the agent's output before resuming. Local-git mode only — uses `repo_tag` as the no-diff signal.

---

## 🛑 Hard-Stop

When a sprint is in flight on an autonomous project, an extra red **stop** button appears on the card. It cancels the running Trigger.dev pipeline immediately AND sets the auto-drain pause flag. Use sparingly — graceful pause (let the current sprint finish) is usually preferred. The button asks for confirmation before firing.

---

## ⏸️ Graceful Pause

The card has a **Pause** button (next to the start/sprint controls) that shows only on autonomous projects. Click it to:

- Stop new dispatches from the cron immediately
- Let the current sprint (if any) finish naturally
- Keep all your auto-drain settings — the toggle stays on, just gated

Click again to resume. The badge updates to `🤖 autonomous · paused` while the pause is set.

---

## 🛑 When the Loop Stops

The cron halts on its own in three cases:

| Trigger | What Happens | Notification |
|---------|--------------|:------------:|
| Backlog empty | Cron skips silently — you're done | 📬 `Auto-drain finished — {project}` (info) |
| Last sprint **failed** or **cancelled** | Cron skips, won't auto-retry | ⚠️ `Auto-drain halted — {project}` (warning) |
| Operator pressed Pause | Cron skips with reason `paused by operator` | (no notification — you initiated it) |

Notifications are deduped to **once per hour per project** so you get one ping per state change, not one per cron tick (cron runs every ~2 min).

---

## 🔁 Restarting After a Halt

When the loop halts on a failure:

1. Open the failed sprint in the project view, read the error
2. Fix the underlying issue (briefing, item description, integration credentials, etc)
3. Either:
   - Click **Start Sprint** manually to dispatch the next one (the cron will then resume on its own from there), OR
   - Release the failed sprint's locked backlog item back to `todo` from the kanban first if you want a clean retry

---

## 🎯 Briefing × Backlog Coherence

Autonomous projects run faster than a human can review every sprint, so a few defaults guard against drift:

- **Briefing snapshots per sprint.** Editing the project briefing only affects future sprints — past sprints keep the briefing they ran with for audit and replay.
- **No automatic conflict detection.** If a backlog item asks for the opposite of what the briefing says, the system follows the item (the kanban is your edit surface — keep them aligned). When you edit the briefing while items are queued, Project Settings shows a warning so you can review the kanban.
- **No automatic "project done" signal.** The cron stops naturally when the backlog is empty (and pings you with `Auto-drain finished`). You decide whether to add more items, switch off auto-drain, or call the project shipped.

---

## 💡 When To Use It

| Use Auto-Drain When | Use Manual Start When |
|--------------------|------------------------|
| Backlog has many small, well-scoped items | Each sprint deserves a custom briefing |
| You want hands-off execution overnight | You review per-sprint before starting |
| Items are independent (no item depends on another's output) | Items have hand-offs to operator decisions |
| Cost per item is predictable | You want a hard budget cap before each run |
