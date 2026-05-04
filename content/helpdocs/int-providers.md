---
title: LLM Providers
icon: 🧠
category: User Guides
order: 11
color: v
parent: integrations
---

# 🧠 LLM Providers

Bring your own API keys — choose the provider and model that fits each agent, pipeline, or sprint.

> **Required** for Cloud mode and the Wizard. Optional for Local mode if using CLI subscriptions.

---

## 🔑 Supported Providers

| Provider | Key Variable | Popular Models |
|----------|-------------|---------------|
| **Anthropic** | `ANTHROPIC_API_KEY` | claude-sonnet-4, claude-opus-4 |
| **OpenAI** | `OPENAI_API_KEY` | gpt-4o, o3-mini |
| **Google** | `GEMINI_API_KEY` | gemini-2.5-flash, gemini-2.5-pro |
| **DeepSeek** | `DEEPSEEK_API_KEY` | deepseek-chat, deepseek-reasoner |
| **Mistral** | `MISTRAL_API_KEY` | mistral-large, codestral |
| **xAI** | `XAI_API_KEY` | grok-3 |
| **Perplexity** | `PERPLEXITY_API_KEY` | sonar-pro |
| **Qwen** | `QWEN_API_KEY` | qwen-max |
| **Moonshot** | `MOONSHOT_API_KEY` | moonshot-v1 |

---

## 🔧 Setup

1. Go to **Providers** in the sidebar
2. Click on a provider card
3. Enter your **API key**
4. Optionally set a custom **Base URL** (for proxies or self-hosted models)
5. Click **Save** → then **Test** to verify connectivity

> ✅ The test validates your key and shows available models.

---

## 🎯 How Providers Are Used

| Context | How Provider is Selected |
|---------|------------------------|
| **Project default** | Set in Project Settings → LLM section |
| **Per-agent override** | Set in Project Settings → Agent Configs |
| **Sprint override** | Selected in the Start Sprint modal |
| **API routing** | Direct LLM call via provider SDK |
| **CLI API routing** | API key injected into CLI tool as env var |
| **Wizard** | Uses your configured provider for AI-assisted setup |

---

## 🔒 Security

- API keys are stored **encrypted** in the database
- Keys are **never** logged, displayed, or included in LLM prompts
- Keys are injected as **process environment variables** at runtime
- Each organization's keys are **isolated** — no cross-tenant access
