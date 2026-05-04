---
title: Storage
icon: 📦
category: User Guides
order: 12
color: c
parent: integrations
---

# 📦 Storage

Configure where your agents store artifacts, project files, and sprint outputs.

---

## 🗂️ Storage Backends

| Backend | Best For | Setup |
|---------|----------|-------|
| 💻 **Local filesystem** | Local development | Set base path in Storage settings |
| ☁️ **Supabase Storage** | Cloud mode, shared teams | Auto-configured from Supabase project |
| 🐙 **GitHub** | Sprint output as PRs/branches | Token + owner in Storage settings |

---

## 💻 Local Storage

Artifacts are written to your local filesystem. Ideal for development.

- Configure the **base path** in **Storage → User Space**
- Agents write to `{basePath}/{projectSlug}/.staging/{agent}/`
- You can browse and edit files directly on your machine

## ☁️ Supabase Storage

Cloud-based object storage with tenant isolation.

- Artifacts stored at `{tenantId}/{projectId}/.staging/{agent}/`
- Accessed via Supabase Storage API
- Tenant isolation via path prefix

## 🐙 GitHub Repositories

Push sprint outputs to GitHub as branches or pull requests.

1. Go to **Storage → GitHub**
2. Enter your **GitHub Token** (with `repo` scope) and **Owner**
3. Save and test
4. In Project Settings, enable **GitHub** as output destination
5. After sprint completion, output is pushed to a `sprint/{num}` branch

---

## 🔄 Switching Backends

The storage backend is configured per-project. Agents use the same tool API regardless — the runtime resolves paths transparently.

> 💡 You can start with local storage for development and switch to Supabase for production.
