---
title: Agents
icon: 🤖
category: User Guides
order: 23
color: v
parent: gs-studio
---

# 🤖 Agents

Agents are AI personas — each with a defined role, capabilities, and tools.

---

## ➕ Creating an Agent

1. Go to **Studio → Agents**
2. Click **+ New agent**
3. Fill in:

| Field | Description |
|-------|-------------|
| 🎨 **Icon** | Choose from the emoji catalog |
| 📝 **Name** | Display name (e.g., "Architect Agent") |
| 🔑 **Slug** | Machine identifier (auto-generated) |
| 👥 **Squad** | Optional group label (e.g., "engineering") |

4. **Specialization**:
   - **Generic** — No special level
   - **Specialist** — A primary role agent
   - **Super-specialist** — Nested under a parent specialist

5. **Runtime & Autonomy**:
   - ⚡ **auto** — Runs without human approval
   - 🛡️ **human** — Requires sign-off at gates

6. Write the **Description** — Who the agent is and what it does
7. Select **Tools** — Capabilities the agent can use
8. Click **Create**

---

## 📋 Agent Spec

Each agent's specification is stored as structured data:

| Field | Purpose |
|-------|---------|
| `description` | Who the agent is, what it does _(injected into LLM prompt)_ |
| `output_types` | What the agent can produce (capability labels) |
| `suggested_inputs` | What it typically consumes (hints) |
| `tools` | Available tool function names |
| `autonomy` | `auto` or `human` |
| `guardrails` | Constraints — what NOT to do |
| `sla` | Expected turnaround time |

---

## 🔄 Import / Export / Clone

| Action | How |
|--------|-----|
| 📥 **Import YAML** | Click "Import YAML" → upload file or paste content |
| 📤 **Export YAML** | Click the download icon on any agent card |
| 📋 **Clone** | Click the copy icon → creates a `-copy` duplicate |

---

## 👥 Squad Visibility

Use the **squad filter** to show/hide groups of agents. Toggle **All** / **None** for quick selection. Visibility is saved per-factory.

---

## 🌳 Specialist Tree

- **Specialists** appear as top-level cards
- **Super-specialists** are collapsible children nested under their parent
- In the pipeline builder, the same tree structure appears for agent selection
