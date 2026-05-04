---
title: Projects
icon: 📁
category: User Guides
order: 25
color: v
parent: gs-studio
---

# 📁 Projects

Projects tie a **pipeline** to a **brief** and **configuration**. They're the unit of work that gets executed as sprints.

---

## ➕ Creating a Project

1. Go to **Studio → Projects** (or click **+ New project** from the Office)
2. Choose mode:
   - 🆕 **New project** — Start from a brief or idea
   - 📎 **Adopt existing** — Factory takes over an existing codebase
3. Enter **Name** and **Brief** (the instruction your agents will receive)
4. Click **Create**

---

## ⚙️ Project Settings

Click the ⚙️ gear icon on a project card to configure:

| Section | What You Configure |
|---------|-------------------|
| 📝 **Briefing** | The main instruction for agents |
| 🔄 **Pipeline** | Which pipeline to use |
| 🧠 **LLM** | Default and per-role provider/model |
| 🤖 **CLI Agents** | Enable CLI mode, select CLI per agent |
| 🎯 **Agent Configs** | Per-agent provider, model, guidelines |
| 💰 **Budget** | Max USD spend per sprint |
| 🐙 **GitHub** | Branch name, auto-push on completion |
| 📚 **Knowledge** | Attached knowledge base instances |
| 📊 **Monitoring** | Detailed execution logging |

---

## 📌 Project Lifecycle

```
Created → Ready → Queued → Running → Completed
                                   → Pending Save
                                   → Failed
                                   → Paused (manual or gate)
```

Each sprint execution follows this lifecycle. A project can have multiple sprints over time.
