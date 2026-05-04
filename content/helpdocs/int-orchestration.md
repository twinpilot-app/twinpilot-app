---
title: Orchestration
icon: ⚙️
category: User Guides
order: 13
color: v
parent: integrations
---

# ⚙️ Orchestration

Trigger.dev powers the pipeline execution engine. The **Orchestration** page
stores your Trigger.dev credentials; the **`{{brand.cli.binName}}` CLI** is
what actually prepares, runs, and deploys the worker bundle that executes
pipelines.

{{brand.name}} never runs `npx trigger.dev` itself and does not keep the
worker code in the app repo — every tenant ships their own worker, driven
by the CLI. See [Workers Architecture](/docs#workers-architecture) for the
runtime details (JWT scoping, task graph, security guards).

---

## 🔧 Configuration

Fill these in on the Orchestration page. The CLI fetches them on demand
via `GET /api/cli/worker-env`.

| Field | What it's used for |
|-------|-------------------|
| **Project ID** | Your Trigger.dev project reference (`proj_...`). Passed to `trigger.dev dev|deploy` as `TRIGGER_PROJECT_REF`. |
| **Dev Secret Key** | `tr_dev_...` — authenticates `{{brand.cli.binName}} workers dev` against your local worker. |
| **Prod Secret Key** | `tr_prod_...` — authenticates `{{brand.cli.binName}} workers deploy` against the cloud worker. |
| **Access Token** | Personal API token — enables `{{brand.cli.binName}} workers status` (reads the Management API). |

---

## ▶️ Local Mode — `workers dev`

Runs tasks on your machine. Required if your pipeline uses CLI
subscriptions (Claude Code, Codex, …) since those need an interactive
OAuth login.

```bash
# One-time per profile
{{brand.cli.binName}} login
{{brand.cli.binName}} workers prepare

# Day-to-day
{{brand.cli.binName}} workers dev --background   # returns immediately
{{brand.cli.binName}} workers logs --follow       # tail stdout/stderr
{{brand.cli.binName}} workers stop                # tear down the background process group
```

- ✅ Hot reload — code changes apply immediately.
- ✅ CLI subscriptions work.
- ✅ Local filesystem access.
- ✅ No service-role key on disk — the worker only holds
  `SUPABASE_URL` + `SUPABASE_ANON_KEY` and a per-run JWT in the task payload.

## ☁️ Cloud Mode — `workers deploy`

Deploys the worker bundle to your tenant's Trigger.dev project. Tasks run
in Trigger.dev's managed containers.

```bash
{{brand.cli.binName}} workers deploy
```

After a successful deploy the CLI calls
`POST /api/workers/deployed` so the **Status** page can compare the
deployed CLI version against the latest release and flag outdated workers.

- ✅ No local machine needed.
- ✅ Scales horizontally.
- ⚠️ CLI subscriptions are **not** available (no interactive OAuth in
  containers) — every CLI step must use `authMode: "api-key"`.

## 🔑 Per-run tenant JWT

Every pipeline dispatch from the Command Center calls `mintWorkerToken()`
and attaches a short-lived tenant-scoped JWT (`supabaseJwt`) to the
Trigger.dev task payload. The worker rebuilds its async-local scope from
that JWT and uses it for **all** Supabase reads / writes. RLS is the only
thing separating tenants at the DB / storage layer.

You don't configure this — it's wired automatically once
`SUPABASE_JWT_PRIVATE_KEY` (ES256, preferred) or `SUPABASE_JWT_SECRET`
(legacy HS256) is set on the platform.

## 📊 Deploy Status

The Orchestration page and the admin **Status** page both surface the
latest deploy: environment, CLI version deployed, and whether a newer CLI
version is available. The data comes from:

- `GET /api/workers/deploy-status` — joins the latest row of
  `worker_deployments` with the Trigger.dev Management API.
- The CLI version reported by `{{brand.cli.binName}} workers deploy` on its
  last successful run.

Update the worker by bumping the CLI, running
`{{brand.cli.binName}} workers prepare --reinstall`, then
`{{brand.cli.binName}} workers deploy` again.
