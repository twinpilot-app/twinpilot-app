---
title: Tools
icon: 🛠️
category: User Guides
order: 16
color: c
parent: integrations
---

# 🛠️ Tools

Tools are the capabilities available to your AI agents during execution. Each agent declares which tools it has access to.

---

## 📋 Built-in Tools

| Tool | Purpose | When Used |
|------|---------|-----------|
| 📖 `read_artifact` | Read output from previous pipeline steps | Agent needs context from prior work |
| 📋 `list_artifacts` | List available artifacts in the sprint | Agent exploring what's been produced |
| ✍️ `write_staging_artifact` | Write a sprint deliverable | Agent producing output (specs, reports) |
| 📄 `read_project_file` | Read a committed project file | Agent reading source code, configs |
| 📝 `write_project_file` | Write a project file | Agent writing code, docs, tests |
| 📂 `list_project_files` | List files in the project | Agent exploring project structure |
| 🆘 `escalate_to_human` | Pause pipeline for human review | Agent needs help or can't proceed |
| 🚀 `github_push_sprint` | Push sprint output to GitHub | Shipping code as a branch/PR |
| ✅ `mark_sprint_saved` | Mark sprint as saved | After push or download |

---

## 🔧 How Tools Work

1. When an agent starts, its tools are **resolved** from the spec
2. Tools are passed to the LLM as **function definitions**
3. The LLM calls tools during its reasoning loop
4. Each tool call is executed by the runtime and the result returned to the LLM
5. The cycle repeats until the agent produces its final output

---

## 🎯 Tool Selection per Agent

In the Studio, when creating or editing an agent:

1. Scroll to the **Tools** section
2. Toggle tools on/off
3. **Select all** / **Unselect all** for quick configuration
4. The agent will only have access to the selected tools during execution

> 💡 Most agents need at least `read_artifact` and `list_artifacts` to consume output from previous steps.
