---
title: Triggers
icon: ⚡
category: User Guides
order: 26
color: a
parent: gs-studio
---

# ⚡ Triggers

Triggers define **how and when** sprints are started. They complement the manual "Start Sprint" button with automated and event-driven execution.

---

## 🎯 Trigger Sources

| Source | How It Works |
|--------|-------------|
| 🖱️ **Manual (UI)** | Click **Start Sprint** in the Office |
| 💻 **CLI** | `{{brand.cli.packageName}} run --project <slug>` |
| 🔗 **API** | `POST /api/projects/{id}/run` with auth header |
| 🐙 **GitHub Webhook** | _Wire-up tracked_ — webhook today only emits CI notifications; sprint dispatch coming. |
| 🤖 **Auto-Drain** | Per-project — backlog cron picks the next item every ~2 min. See **Autonomous Projects**. |

The **Triggers** page in the sidebar is the unified observability surface — for each source, see total dispatched count, last-30-days count, last-fired-at, and the project that last used it.

---

## 🐙 GitHub Webhook Triggers

When configured, GitHub events can automatically start sprints:

### Setup

1. In your GitHub repo → **Settings → Webhooks → Add webhook**
2. **Payload URL**: `https://your-domain/api/webhooks/github`
3. **Content type**: `application/json`
4. **Events**: Select "Workflow runs"

### What Happens

| GitHub Event | {{brand.name}} Action |
|-------------|---------------------|
| `workflow_run` completed (success) | Emits `github_action_success` notification |
| `workflow_run` completed (failure) | Emits `github_action_failed` notification |
| `publish-cli.yml` success | Emits `deploy_cli` notification |
| `publish-worker.yml` success | Emits `deploy_workers` notification |

---

## 🔗 API Trigger

Start a sprint programmatically:

```bash
curl -X POST https://your-domain/api/projects/{projectId}/run \
  -H "Authorization: Bearer {jwt}" \
  -H "Content-Type: application/json" \
  -d '{
    "briefing": "Optional sprint-specific instructions",
    "provider": "claude",
    "model": "claude-sonnet-4"
  }'
```

---

## 🛡️ Gate Triggers

Human gates within a pipeline are also a form of trigger — they pause execution and wait for human input:

| Gate Action | Trigger Source |
|-------------|---------------|
| ✅ **Approve** | UI button, Telegram inline button, webhook URL, API |
| ❌ **Reject** | UI button, Telegram inline button, webhook URL, API |

Gate approval URLs are included in **Telegram messages** and **webhook payloads** automatically.
