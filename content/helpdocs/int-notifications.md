---
title: Notifications
icon: 🔔
category: User Guides
order: 14
color: a
parent: integrations
---

# 🔔 Notifications

Stay informed about sprint progress, gate approvals, and system events across multiple channels.

---

## 📡 Channels

| Channel | Setup Required | Key Features |
|---------|:-------------:|-------------|
| 📱 **In-app** | None (automatic) | Bell icon, real-time badge, notification center |
| ✈️ **Telegram** | Bot token + Chat ID | Inline **Approve/Reject** buttons for gates |
| 🔗 **Webhooks** | URL + optional secret | Slack, Discord, PagerDuty, n8n, Zapier, etc. |
| 📧 **Email** | _Coming soon_ | Via Resend |

---

## ✈️ Setting Up Telegram

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` — choose a name and username
3. Copy the **Bot Token** provided
4. Send any message to your new bot
5. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in your browser
6. Find `"chat": { "id": 123456789 }` — that's your **Chat ID**
7. In {{brand.name}} → **Notifications** → Add **Telegram** integration
8. Paste Bot Token and Chat ID → **Save** → **Test**

> 🛡️ When a human gate is triggered, Telegram sends a message with **Approve** and **Reject** inline buttons — click to approve directly from Telegram.

---

## 🔗 Webhook Integrations

Add webhooks for any service that accepts HTTP POST:

| Template | Service |
|----------|---------|
| 💬 Slack | `https://hooks.slack.com/services/...` |
| 🎮 Discord | `https://discord.com/api/webhooks/...` |
| 🚨 PagerDuty | `https://events.pagerduty.com/integration/...` |
| ⚡ n8n | `https://your-n8n.com/webhook/...` |
| ⚡ Zapier | `https://hooks.zapier.com/hooks/catch/...` |
| 🔗 Custom | Any URL |

Each webhook can optionally include an **HMAC secret** for request signature verification.

---

## 🎛️ Preferences Matrix

Control which events go to which channels:

| Event | In-app | Telegram | Webhook |
|-------|:------:|:--------:|:-------:|
| Sprint started | ✅ | ✅ | ✅ |
| Sprint completed | ✅ | ✅ | ✅ |
| Sprint failed | ✅ | ✅ | ✅ |
| Human gate | ✅ | ✅ | ✅ |
| Agent escalation | ✅ | ✅ | ✅ |
| Queue empty/full | ✅ | ✅ | ✅ |

Toggle each cell on/off in **Notifications → Preferences**.
