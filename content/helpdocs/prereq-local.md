---
title: Local Machine
icon: 💻
category: User Guides
order: 8
color: g
parent: prerequisites
---

# 💻 Local Machine Requirements

For **local mode**, pipelines run on your machine. The `{{brand.cli.binName}}`
CLI extracts the worker bundle into your home directory and launches a
Trigger.dev dev worker there — you don't clone the factory repo and you
never put a Supabase service-role key on your laptop.

---

## 📦 Required software

| Software | Version | Purpose |
|----------|---------|---------|
| **Node.js** | 20+ (24 recommended) | Worker runtime |
| **npm** | 10+ | Package management (CLI + worker deps) |
| **Git** | 2.30+ | Version control, sprint push |

Install the CLI itself globally:

```bash
npm i -g {{brand.cli.packageName}}
{{brand.cli.binName}} --version
```

---

## 🤖 Optional: coding CLIs

If any pipeline step uses **CLI routing**, install the matching tool.
Subscription-based auth (CLI SUBS) only works in local mode — the
containerised cloud worker has no browser, so it can't complete an OAuth
login.

| Tool | Install | Used for |
|------|---------|----------|
| **Claude Code** | `npm i -g @anthropic-ai/claude-code` | Anthropic CLI agent |
| **Aider** | `pip install aider-chat` | Multi-provider CLI agent |
| **Codex** | `npm i -g @openai/codex` | OpenAI CLI agent |
| **Gemini CLI** | `npm i -g @google/gemini-cli` | Google CLI agent |
| **Goose** | see [block/goose](https://github.com/block/goose) | Block's CLI agent |

---

## 🔧 Local setup

### 1. Log in

```bash
{{brand.cli.binName}} login
```

Opens a browser, completes OAuth, and stores the per-profile API key under
`~/{{brand.cli.configDir}}/`. You can log into multiple factories and
switch with `{{brand.cli.binName}} use <profile>`.

### 2. Prepare the worker (once per profile / machine)

```bash
{{brand.cli.binName}} workers prepare
```

This:
- extracts the worker bundle (shipped inside the CLI package) into
  `~/{{brand.cli.configDir}}/worker-<tenant>-<factory>/`,
- fetches tenant env from `GET /api/cli/worker-env` (Supabase URL +
  anon key, Trigger.dev keys, provider keys, GitHub token),
- writes a local `.env` (no service-role key, ever),
- runs `npm install`.

Re-run later with `--reinstall` to rebuild `node_modules/`, or
`--skip-install` to reuse the existing tree.

### 3. Start the dev worker

```bash
# Foreground — Ctrl-C to stop
{{brand.cli.binName}} workers dev

# Or background — returns control to your shell
{{brand.cli.binName}} workers dev --background
{{brand.cli.binName}} workers logs --follow
{{brand.cli.binName}} workers stop
```

Background mode writes stdout/stderr to `.dev.log` and the child PID to
`.dev.pid` inside the prepared dir, so `workers logs` and `workers stop`
can find them later. On Windows the stop uses `taskkill /T /F` to kill the
whole process tree (trigger.dev spawns children that a plain SIGTERM
wouldn't reach).

### 4. Verify

```bash
{{brand.cli.binName}} doctor
```

Shows Node / npm versions, checks which coding CLIs are installed, and
prints the active profile. Then kick off a sprint:

```bash
{{brand.cli.binName}} from-scratch "Meal planning app for busy parents"
{{brand.cli.binName}} status
```

---

## 🔑 How auth works on your machine

Your laptop never holds a service-role key. The worker runs with:

- `SUPABASE_URL` + `SUPABASE_ANON_KEY` (public, powerless on their own),
- per-run **tenant JWT** that the Command Center mints on every sprint
  dispatch and passes through the Trigger.dev payload.

All DB and storage access authenticates with that JWT; RLS enforces the
tenant scope. If the Supabase service-role key somehow ends up in the
worker's environment, the worker refuses to boot and prints a clear
error — that's a deliberate guard, not a bug.

See [Workers Architecture](/docs#workers-architecture) for the full
picture.
