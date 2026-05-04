---
title: Cloud Orchestration
icon: ☁️
category: User Guides
order: 7
color: b
parent: prerequisites
---

# ☁️ Cloud Orchestration

For **cloud mode**, you need a Supabase project for database and artifact storage.

---

## 🗄️ Supabase

[Supabase](https://supabase.com) provides the PostgreSQL database, real-time subscriptions, and object storage.

### What you need
- A **Supabase project**
- **Project URL** (`https://xxx.supabase.co`)
- **Service Role Key** (for server-side operations)
- **Storage** enabled (for artifact storage)

### Setup
1. Go to [supabase.com](https://supabase.com) and create a project
2. In your project dashboard, find:
   - **Settings → API** → Project URL and Service Role Key
3. Enable **Storage** in your Supabase project

> 💡 In the current setup, the platform owner manages the Supabase instance. Tenant data is isolated via Row Level Security (RLS).

---

## 🚀 Deploying Cloud Workers

Once Supabase and Trigger.dev are configured:

1. Go to **Orchestration** in {{brand.name}}
2. Sync environment variables to your Trigger.dev project
3. Click **Deploy Workers** to deploy pipeline tasks to the cloud
4. Workers will run in Trigger.dev's managed containers

> ⚠️ **Cloud mode requires LLM API keys** configured in **Providers**. CLI subscriptions are not available in cloud containers.
