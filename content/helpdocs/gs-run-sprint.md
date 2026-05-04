---
title: Run Sprint
icon: ▶️
category: User Guides
order: 32
color: g
parent: gs-office
---

# ▶️ Run a Sprint

A **sprint** is one execution of a pipeline for a project. Here's how to configure and launch one.

---

## 🚀 Starting a Sprint

1. Find your project in the **Office** queue
2. Click **Start Sprint**
3. Configure the sprint in the modal:

### ⚡ Orchestration Mode

| Mode | Where It Runs | CLI Subs? | API Keys? |
|------|:-------------:|:---------:|:---------:|
| 💻 **Local** | Your machine | ✅ Yes | Optional |
| ☁️ **Cloud** | Trigger.dev containers | ❌ No | Required |

Switching mode **resets all step routing** to the mode's default.

### 🤖 Step Routing

Each step can be individually routed:

| Route | Description | Works Local | Works Cloud |
|-------|-------------|:-----------:|:-----------:|
| 🔵 **API** | Direct LLM call | ✅ | ✅ |
| 🟢 **CLI API** | CLI with API key | ✅ | ✅ |
| 🟡 **CLI SUBS** | CLI with subscription | ✅ | ❌ |

> See [CLI Agents](https://github.com/tirsasoftware/tirsa-factory/blob/main/services/command-center/content/helpdocs/int-clis.md) for the full matrix of supported CLIs (claude-code, codex, gemini-cli), auth modes, MCP support, and per-step Claude Code tuning (effort / plan-mode / budget).

### 📝 Optional Configuration

| Option | Description |
|--------|-------------|
| **Sprint briefing** | Additional instructions for this specific sprint |
| **Per-step instructions** | Custom instruction per agent (override or append) |
| **Cross-sprint context** | Include artifacts from previous sprints |
| **Resume step** | For paused sprints — start from a specific step |
| **Bypass gates** | Skip human approval (for testing) |

4. Click **Run**

---

## 📊 Sprint Lifecycle

```
▶️ Start
    ↓
🔄 Step 1 (Agent A) → Artifact
    ↓
🔄 Step 2 (Agent B) → Artifact
    ↓
🛡️ Human Gate (if configured)
    ↓  ← Approve / Reject
🔄 Step 3 (Agent C) → Artifact
    ↓
✅ Complete (or 📦 Pending Save)
```

### Status Reference

| Status | Icon | Meaning |
|--------|------|---------|
| **Queued** | ⏳ | Waiting to start |
| **Running** | 🔄 | Pipeline executing |
| **Waiting** | 🛡️ | Paused at human gate |
| **Pending Save** | 📦 | Done — push, download, or discard |
| **Completed** | ✅ | Saved and finished |
| **Failed** | ❌ | Agent error — check logs |
| **Paused** | ⏸️ | Manually paused |
| **Cancelled** | 🚫 | Manually cancelled |

---

## 🛡️ Human Gates

When a pipeline step has a human gate:

1. The pipeline **pauses** after the agent completes
2. You receive a **notification** (in-app + Telegram if configured)
3. Telegram includes **Approve / Reject** inline buttons
4. **Approve** → pipeline continues to next step
5. **Reject** → pipeline pauses (configurable behavior)

---

## 📦 After Completion

When a sprint finishes:

| Action | Description |
|--------|-------------|
| 🐙 **Push to GitHub** | Creates a `sprint/{num}` branch with output |
| 📥 **Download** | Download artifacts as a zip file |
| 🗑️ **Discard** | Delete sprint output |

If GitHub is configured for auto-push, output is pushed automatically on completion.
