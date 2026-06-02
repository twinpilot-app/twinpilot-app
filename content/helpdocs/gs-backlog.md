---
title: Project Backlog
icon: 📋
category: User Guides
order: 28
color: m
parent: gs-projects
---

# 📋 Project Backlog

The **backlog** is your project's queue of work. Each item describes one thing you want done; the system runs sprints that pick items up in order, mark them in-progress, and close them when the sprint succeeds.

---

## 🗂️ The Kanban

Open from any project's settings header → **Backlog**, or directly at `/projects/[id]/backlog`. Items live in three columns:

| Column | What It Means |
|--------|---------------|
| 📥 **Todo** | Available for the next sprint |
| 🔄 **Doing** | Locked to a sprint that's running |
| ✅ **Done** | Completed; the sprint succeeded |

Items move automatically:

1. You **drag** an item to a column, or **add** it via direct input.
2. When a sprint dispatches, selected items flip **todo → doing** atomically.
3. When that sprint completes, items flip **doing → done**.
4. Failed sprints leave items in **doing** so you can triage.

---

## ➕ Adding Items

Two paths:

- **Manual** — click *Add item* on the kanban, type a title (and optional description). Order is preserved by `order_index` (drag to reorder).
- **From PRD** — Project Settings → *Generate items from PRD* extracts a flat list of activities from the project's PRD via an LLM-backed extractor (uses your tenant's Anthropic API key). Items append after the existing kanban; nothing is replaced.

---

## 🚀 Picking Items for a Sprint

In the **Start Sprint** modal there's a **Backlog Focus** section. Check the items you want this sprint to address; they'll be locked to the sprint at dispatch and the agent will see them in its task input as the **authoritative scope** for that sprint.

When at least one item is selected, the project briefing reframes from *"source of truth"* to *"context for the sprint"* — agents follow the backlog items as the concrete deliverables, with the briefing as background.

---

## 🤖 Auto-Drain (Autonomous Projects)

Don't want to click *Start Sprint* every time? See **Autonomous Projects** for the auto-drain mode that pulls items from the backlog and dispatches sprints for you on a schedule.
