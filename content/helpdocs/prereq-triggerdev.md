---
title: Trigger.dev
icon: ⚡
category: User Guides
order: 5
color: v
parent: prerequisites
---

# ⚡ Trigger.dev Setup

[Trigger.dev](https://trigger.dev) is the orchestration engine that runs your pipelines. It manages task scheduling, execution, retries, and logging.

---

## 📝 What You Need

| Credential | Where to find it | Purpose |
|-----------|-----------------|---------|
| **Project ID** | Trigger.dev Dashboard → Project Settings | `proj_...` — identifies your project |
| **Dev Secret Key** | Dashboard → Environments → Development | `tr_dev_...` — authenticates local workers |
| **Prod Secret Key** | Dashboard → Environments → Production | `tr_prod_...` — authenticates cloud workers |
| **Access Token** | Dashboard → Personal Settings → Tokens | For deploying workers via GitHub Actions |

---

## 🔧 Step-by-Step

### 1. Create an account
Go to [cloud.trigger.dev](https://cloud.trigger.dev) and sign up.

### 2. Create a project
Click **+ New Project** in your dashboard. Copy the **Project ID** (`proj_...`).

### 3. Get your keys
Navigate to **Environments** in your project:
- Copy the **Development** secret key
- Copy the **Production** secret key

### 4. Generate an Access Token
Go to **Personal Settings → API Tokens → Create Token**.

### 5. Configure in {{brand.name}}
Navigate to **Orchestration** in the sidebar:
1. Enter your **Project ID**
2. Enter your **Dev** and **Prod** secret keys
3. Enter your **Access Token**
4. Click **Save** then **Test Connection**

> ✅ When the test passes, you're ready to run pipelines locally or deploy to cloud.
