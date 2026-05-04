---
title: Wizard
icon: 🪄
category: User Guides
order: 17
color: v
---

# 🪄 Wizard

The **Wizard** is an AI-powered assistant that helps you set up your factory through natural language conversation.

---

## 💬 What the Wizard Can Do

| Action | Description |
|--------|-------------|
| 🤖 **Create agents** | Describe a role → Wizard creates the agent with spec |
| 🔄 **Build pipelines** | Describe the workflow → Wizard generates the pipeline |
| 📁 **Set up projects** | Describe your idea → Wizard creates the project with brief |
| ⚙️ **Configure settings** | Ask about configuration → Wizard guides you |
| ❓ **Answer questions** | Ask about features → Wizard explains |

---

## 🚀 How to Use

1. Click the **Wizard button** (floating action button) on any page
2. Type your request in natural language
3. The Wizard uses your configured **LLM provider** to understand and execute
4. Results appear in your Studio — agents, pipelines, and projects are created automatically

---

## 💡 Example Prompts

```
"Create a developer agent that writes Python code and tests"

"Build a 5-step pipeline: research → spec → build → test → review"

"Set up a project for a meal planning app"

"What's the difference between Sequential and SIPOC mode?"
```

---

## ⚠️ Requirements

- At least one **LLM Provider** must be configured in **Providers**
- The Wizard uses the first available provider for its AI responses
- An active **factory** must be selected
