---
title: Execution modes
icon: ⚙️
category: User Guides
order: 24
color: e
parent: gs-projects
---

# ⚙️ Execution modes

Project Settings → Execution mode picks **how sprints are triggered** for the project. Three options:

| Mode | Briefing source | Who picks the workload | Cadence |
|---|---|---|---|
| **Manual** | Free-form text per sprint | Operator types it | Operator clicks Start |
| **Kanban (manual)** | Kanban backlog items | Operator selects items in the Start Sprint modal | Operator clicks Start |
| **Kanban (autonomous)** | Kanban backlog items | Dispatcher picks the first todo each tick | Cron loop (5min) within constraints |

---

## 🎯 Discovery vs Execution

Independent of mode, **every sprint runs as one of two intents**:

| Intent | Pipeline | When it fires |
|---|---|---|
| **Execution** | `execution_pipeline_id` (or default `pipeline_id`) | Backlog has pending items, OR operator selected items |
| **Discovery** | `discovery_pipeline_id` (or default `pipeline_id`) | Backlog empty AND project allows discovery sprints |

Smart fallback in `/api/projects/[id]/run`:

```
operator picked items?              → execution (explicit)
no selection but backlog has todos? → execution (auto-pick first todo)
backlog empty?                      → discovery
```

The Start Sprint modal mirrors this. The badge above the steps shows the resolved intent + the source pipeline so there's no surprise at dispatch.

---

## 📥 Discovery → backlog

Discovery agents can populate the kanban using the `add_backlog_items` MCP tool. Each item lands in `todo` with `source='agent'` and `created_by_sprint_id` stamped for audit.

- **Wiring**: an agent only emits items if its persona instructs it to. Built-in personas don't auto-call the tool — give your discovery agents the `add_backlog_items` tool and a clear instruction in the role.
- **Visibility**: items show up in `/projects/[id]/backlog` with the same UI as manually-typed items. Source attribution lives on the row (`source='agent'`, `created_by_agent`); the kanban view treats them uniformly so the operator can edit/delete just like any other item.
- **Verdict**: discovery sprints don't *require* backlog output to succeed — an agent that returned only a doc still passes the verdict. The audit summary records `backlog_items_added: N` so you can see whether the discovery actually delivered.

> See **Auto-pipeline (pipeline-composer)** for an agent that uses discovery output to design the next execution sprint's pipeline.

---

## 🔁 Per-mode walkthrough

### Manual

- No kanban. Each sprint = type a briefing, click Start.
- Intent is always **execution** unless backlog is empty (then discovery if a discovery pipeline is configured).
- Useful for: one-shot projects, exploratory work, environments where a kanban is overkill.

### Kanban (manual)

- Operator curates the kanban (typed manually + agent-emitted in discovery sprints).
- Start Sprint modal shows the backlog list; operator ticks one or more items.
- If operator clicks Start without ticking, dispatcher auto-picks the first todo (smart fallback). Modal warns about this with the item title visible.
- Intent: execution when there are todos; discovery when empty.

### Kanban (autonomous)

- Dispatcher cron runs every 5 minutes per project; pulls one `todo` item, atomically locks it (`status='doing'`, `sprint_id=…`), spawns one sprint per attempt.
- Constraints (Project Settings → Auto-drain):
  | Constraint | What it does |
  |---|---|
  | Cooldown (minutes) | Min delay between consecutive auto-drain dispatches |
  | Daily cap | Max sprints per day |
  | Active window | Hour range + timezone where the cron is allowed |
  | On-empty policy | What to do when no todos: `halt` (default), `discover_once` (one discovery, then halt), `discover_continuous` (keep running discovery) |
  | Approval gate | When set, completed sprints set `awaiting_approval`; cron skips until operator clicks Approve |
  | Unproductive guard | (local-git only) Halt after N consecutive sprints with no commit |
  | Pause | Manual flag to halt the cron without changing the mode |

- **One item per sprint** by design. Want N items at once? Group them under a parent item or temporarily flip to manual mode.
- **Periodic discovery** (Project Settings → Auto-drain → "every N execution sprints, force a discovery"): off by default. When set, every Nth execution dispatch is replaced with a discovery sprint so the product-owner refreshes the kanban without draining it. Discovery doesn't consume todo items.

---

## 🚑 Common confusions

### "I clicked Start without selecting items but it ran execution, not discovery"

Smart fallback. Backlog had pending todos so the dispatcher picked the first one. Confirms you can run "next item" without a tick.

### "Auto-drain stopped firing"

Check in order: pause flag, approval gate, daily cap reached, cooldown, active window, unproductive guard, on-empty policy. The cron skip reasons land in the GitHub Actions run log.

### "Discovery sprint succeeded but backlog stayed empty"

The discovery agent didn't call `add_backlog_items`. Check the agent persona — does it tell the agent to emit items, and does it have the tool granted? Items are optional output; verdict won't fail you.

### "I want to refresh the backlog without draining it"

Click the **✨ Run discovery** icon on the project card (next to Start) — dispatches a discovery sprint right now, regardless of backlog state. The product-owner reads existing items + recent outcomes and refines them in place. Or set **Periodic discovery** in Auto-drain settings to schedule the cadence automatically.

### "Switched mode mid-project, settings look weird"

Some kanban-only fields stay around when you switch back to Manual. They don't break anything but clutter the modal. Clear them in Auto-drain settings if needed.

---

## 🔗 Related

- **Backlog** — operator-facing kanban
- **Auto-pipeline (pipeline-composer)** — uses discovery output to compose the next execution pipeline
- **Run a Sprint** — full Start Sprint walkthrough
