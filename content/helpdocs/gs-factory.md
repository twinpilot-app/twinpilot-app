---
title: Factory
icon: 🏭
category: User Guides
order: 21
color: b
parent: getting-started
---

# 🏭 Create a Factory

A **Factory** is your autonomous production unit — it groups agents, pipelines, and projects into a self-contained workspace.

---

## ➕ Creating Your First Factory

1. Go to **Factory Settings** in the sidebar
2. Click **+ New Factory**
3. Fill in:
   - **Name** — e.g., "My Software Factory"
   - **Slug** — auto-generated from name (URL-friendly)
4. Click **Create**

## 🎯 Selecting the Active Factory

The active factory is shown as a **neon badge** in the sidebar. Everything you do (agents, pipelines, projects) is scoped to the active factory.

Click the badge to switch between factories.

## 🔗 Factory Inheritance

Factories can **inherit** from other factories:
- Inherited agents and pipelines appear as read-only
- Clone inherited agents to customize them
- Useful for team-wide base configurations

## ⚙️ Factory Configuration

| Setting | Purpose |
|---------|---------|
| **Max concurrent projects** | Limits how many sprints can run simultaneously |
| **Squad visibility** | Show/hide agent groups in the Studio |
| **Default settings** | Inherited by new projects in this factory |
