---
title: Pipelines
icon: 🔄
category: User Guides
order: 24
color: v
parent: gs-studio
---

# 🔄 Pipelines

Pipelines define the workflow — the sequence of agents that execute to produce a deliverable.

---

## ➕ Creating a Pipeline

1. Go to **Studio → Pipelines**
2. Click **+ New pipeline**
3. Enter **Name**, **Slug**, and **Description** in the compact header
4. Select **Mode**:

| Mode | Artifact Validation | Use Case |
|------|:-------------------:|----------|
| 🔵 **Sequential** | No | Simple workflows, prototyping |
| 🟠 **SIPOC** | Yes | Production workflows with quality gates |

> 💡 Click the **?** next to Mode for a detailed explanation of how agents communicate.

---

## 📦 Phases

Phases are containers that group steps:

1. Click **+ Phase** to create a new phase
2. **Name** it (auto-focused for immediate typing)
3. Phase **numbers** are auto-assigned by position
4. Click an agent card in the picker to **add it** to the active phase
5. **Remove** a phase to remove all its steps
6. **Empty phases** are cleaned on save

---

## 🤖 Agent Picker

The right panel shows all agents in your factory, grouped by squad:

- **Squad filter** — Toggle squads with **All** / **None** buttons
- **Search** — Filter agents by name
- **Specialist tree** — Super-specialists are collapsible under their parent
- **Click** an agent card to add it to the active phase
- **?** icon — Preview the agent's spec before adding

---

## 🟠 SIPOC Mode

When mode is **SIPOC**, click a step in the left panel to define contracts:

- **Inputs** — Which artifacts from previous steps are required/optional
- **Outputs** — What this step must produce (artifact, format, quality gate)
- **Acceptance criteria** — Conditions for the step to pass

Steps without contracts show a ⚠️ warning badge.

---

## 💾 Saving

The **Save/Create** button is in the header. Error messages appear inline next to it.
