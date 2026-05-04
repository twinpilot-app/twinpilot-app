/**
 * POST /api/settings/integrations/test
 *
 * Universal integration tester. Validates credentials for any service_id
 * by making a real API call with the saved credentials.
 *
 * Body: { tenantId: string; serviceId: string }
 * Response: { ok: boolean; steps: { name: string; ok: boolean; detail: string }[] }
 *
 * Supported service IDs:
 *   LLM providers  → anthropic, openai, google, mistral, perplexity, xai, zai, deepseek, qwen, moonshot
 *   Platform       → trigger, telegram
 *   GitHub handled by /api/settings/integrations/github-test (full repo create/delete test)
 */
import { NextRequest, NextResponse } from "next/server";
import { brand } from "@/lib/brand";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

interface Step { name: string; ok: boolean; detail: string }

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// ── Provider registry (same as wizard/models) ─────────────────────────────────

interface ProviderTestCfg {
  keyVar:      string;
  baseVar?:    string;
  defaultBase: string;
  /** Path for model listing (GET → validates key) */
  modelsPath:  string;
  /** Build auth headers */
  authHeaders: (key: string) => Record<string, string>;
  /** Build query string (for Google key= param) */
  authQuery?:  (key: string) => string;
  /** Extract model count from response */
  countModels: (body: unknown) => number;
}

const PROVIDER_TESTS: Record<string, ProviderTestCfg> = {
  anthropic: {
    keyVar: "ANTHROPIC_API_KEY", baseVar: "ANTHROPIC_BASE_URL",
    defaultBase: "https://api.anthropic.com", modelsPath: "/v1/models",
    authHeaders: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }),
    countModels: (b) => ((b as { data?: unknown[] }).data ?? []).length,
  },
  openai: {
    keyVar: "OPENAI_API_KEY", baseVar: "OPENAI_BASE_URL",
    defaultBase: "https://api.openai.com", modelsPath: "/v1/models",
    authHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    countModels: (b) => ((b as { data?: unknown[] }).data ?? []).length,
  },
  google: {
    keyVar: "GEMINI_API_KEY", baseVar: "GEMINI_BASE_URL",
    defaultBase: "https://generativelanguage.googleapis.com", modelsPath: "/v1beta/models",
    authHeaders: () => ({}),
    authQuery: (k) => `key=${k}`,
    countModels: (b) => ((b as { models?: unknown[] }).models ?? []).length,
  },
  mistral: {
    keyVar: "MISTRAL_API_KEY", baseVar: "MISTRAL_BASE_URL",
    defaultBase: "https://api.mistral.ai", modelsPath: "/v1/models",
    authHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    countModels: (b) => ((b as { data?: unknown[] }).data ?? []).length,
  },
  perplexity: {
    keyVar: "PERPLEXITY_API_KEY", baseVar: "PERPLEXITY_BASE_URL",
    defaultBase: "https://api.perplexity.ai", modelsPath: "/models",
    authHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    countModels: (b) => ((b as { data?: unknown[] }).data ?? []).length,
  },
  xai: {
    keyVar: "XAI_API_KEY", baseVar: "XAI_BASE_URL",
    defaultBase: "https://api.x.ai", modelsPath: "/v1/models",
    authHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    countModels: (b) => ((b as { data?: unknown[] }).data ?? []).length,
  },
  zai: {
    keyVar: "ZAI_API_KEY", baseVar: "ZAI_BASE_URL",
    defaultBase: "https://api.01.ai", modelsPath: "/v1/models",
    authHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    countModels: (b) => ((b as { data?: unknown[] }).data ?? []).length,
  },
  deepseek: {
    keyVar: "DEEPSEEK_API_KEY", baseVar: "DEEPSEEK_BASE_URL",
    defaultBase: "https://api.deepseek.com", modelsPath: "/v1/models",
    authHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    countModels: (b) => ((b as { data?: unknown[] }).data ?? []).length,
  },
  qwen: {
    keyVar: "QWEN_API_KEY", baseVar: "QWEN_BASE_URL",
    defaultBase: "https://dashscope.aliyuncs.com/compatible-mode", modelsPath: "/v1/models",
    authHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    countModels: (b) => ((b as { data?: unknown[] }).data ?? []).length,
  },
  moonshot: {
    keyVar: "MOONSHOT_API_KEY", baseVar: "MOONSHOT_BASE_URL",
    defaultBase: "https://api.moonshot.cn", modelsPath: "/v1/models",
    authHeaders: (k) => ({ Authorization: `Bearer ${k}` }),
    countModels: (b) => ((b as { data?: unknown[] }).data ?? []).length,
  },
};

// ── Testers ───────────────────────────────────────────────────────────────────

async function testProvider(
  serviceId: string,
  envMap: Record<string, string>,
): Promise<{ ok: boolean; steps: Step[] }> {
  const cfg = PROVIDER_TESTS[serviceId];
  if (!cfg) return { ok: false, steps: [{ name: "Config", ok: false, detail: `Unknown provider: ${serviceId}` }] };

  const steps: Step[] = [];
  const apiKey = envMap[cfg.keyVar];
  if (!apiKey) {
    steps.push({ name: "API key", ok: false, detail: `${cfg.keyVar} not configured` });
    return { ok: false, steps };
  }
  steps.push({ name: "API key", ok: true, detail: "Key present" });

  const base = (envMap[cfg.baseVar ?? ""] ?? cfg.defaultBase).replace(/\/$/, "");
  const qs   = cfg.authQuery ? `?${cfg.authQuery(apiKey)}` : "";
  const url  = `${base}${cfg.modelsPath}${qs}`;

  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...cfg.authHeaders(apiKey) },
      signal: AbortSignal.timeout(12_000),
    });

    if (res.status === 401 || res.status === 403) {
      steps.push({ name: "Connection", ok: false, detail: `Invalid or expired key (HTTP ${res.status})` });
      return { ok: false, steps };
    }
    if (!res.ok) {
      steps.push({ name: "Connection", ok: false, detail: `API returned HTTP ${res.status}` });
      return { ok: false, steps };
    }

    const body = await res.json();
    const count = cfg.countModels(body);
    steps.push({ name: "Connection", ok: true, detail: `Connected — ${count} model${count !== 1 ? "s" : ""} available` });
    return { ok: true, steps };
  } catch (e: unknown) {
    steps.push({ name: "Connection", ok: false, detail: `Network error: ${(e as Error).message}` });
    return { ok: false, steps };
  }
}

/** Test a single key against the project ref */
async function testTriggerKey(
  projectRef: string | undefined,
  key: string,
  label: string,
): Promise<Step[]> {
  const steps: Step[] = [];

  if (projectRef && projectRef.startsWith("proj_")) {
    try {
      const res = await fetch(`https://api.trigger.dev/api/v1/projects/${projectRef}/envvars`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        steps.push({ name: label, ok: false, detail: `Key rejected by project (HTTP ${res.status})` });
      } else if (res.status === 404) {
        steps.push({ name: label, ok: false, detail: `Project not found — check the Project ref` });
      } else if (!res.ok) {
        steps.push({ name: label, ok: false, detail: `Trigger.dev returned HTTP ${res.status}` });
      } else {
        steps.push({ name: label, ok: true, detail: "Connected" });
      }
    } catch (e: unknown) {
      steps.push({ name: label, ok: false, detail: `Network error: ${(e as Error).message}` });
    }
  } else {
    // No project ref — validate key alone via runs endpoint
    try {
      const res = await fetch("https://api.trigger.dev/api/v1/runs?limit=1", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        steps.push({ name: label, ok: false, detail: `Invalid key (HTTP ${res.status})` });
      } else {
        steps.push({ name: label, ok: true, detail: "Key valid (no project ref to verify against)" });
      }
    } catch (e: unknown) {
      steps.push({ name: label, ok: false, detail: `Network error: ${(e as Error).message}` });
    }
  }

  return steps;
}

async function testTrigger(envMap: Record<string, string>): Promise<{ ok: boolean; steps: Step[] }> {
  const steps: Step[] = [];
  const projectRef = envMap["TRIGGER_PROJECT_ID"];
  const devKey     = envMap["TRIGGER_DEV_SECRET_KEY"];
  const prodKey    = envMap["TRIGGER_PROD_SECRET_KEY"];
  const legacyKey  = envMap["TRIGGER_SECRET_KEY"];

  // ── Project ref ──
  if (!projectRef) {
    steps.push({ name: "Project ref", ok: false, detail: "Not configured" });
  } else if (!projectRef.startsWith("proj_")) {
    steps.push({ name: "Project ref", ok: false, detail: `Invalid format — expected "proj_…", got "${projectRef.slice(0, 12)}…"` });
  } else {
    steps.push({ name: "Project ref", ok: true, detail: projectRef.slice(0, 20) + (projectRef.length > 20 ? "…" : "") });
  }

  // ── Test each key that exists ──
  if (devKey) {
    const keySteps = await testTriggerKey(projectRef, devKey, "Development");
    steps.push(...keySteps);
  }

  if (prodKey) {
    const keySteps = await testTriggerKey(projectRef, prodKey, "Production");
    steps.push(...keySteps);
  }

  if (legacyKey && !devKey && !prodKey) {
    const keySteps = await testTriggerKey(projectRef, legacyKey, "Secret key (legacy)");
    steps.push(...keySteps);
  }

  if (!devKey && !prodKey && !legacyKey) {
    steps.push({ name: "Secret keys", ok: false, detail: "No secret key configured (development or production)" });
  }

  const allOk = steps.every((s) => s.ok);
  return { ok: allOk, steps };
}

async function testGitHubBasic(envMap: Record<string, string>): Promise<{ ok: boolean; steps: Step[] }> {
  // Lightweight test: just validate token + owner without creating a repo.
  // The full test (create/delete repo) is still available via /github-test.
  const steps: Step[] = [];
  const token = envMap["GITHUB_TOKEN"];
  const owner = (envMap["GITHUB_OWNER"] ?? "").replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").trim();

  if (!token) {
    steps.push({ name: "Credentials", ok: false, detail: "GITHUB_TOKEN not configured" });
    return { ok: false, steps };
  }
  if (!owner) {
    steps.push({ name: "Credentials", ok: false, detail: "GITHUB_OWNER not configured" });
    return { ok: false, steps };
  }
  steps.push({ name: "Credentials", ok: true, detail: `Token present · Owner: ${owner}` });

  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "tirsa-factory" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userRes.ok) {
      steps.push({ name: "Authentication", ok: false, detail: `Token invalid or expired (HTTP ${userRes.status})` });
      return { ok: false, steps };
    }
    const me = await userRes.json() as { login: string };
    steps.push({ name: "Authentication", ok: true, detail: `Authenticated as @${me.login}` });
  } catch (e: unknown) {
    steps.push({ name: "Authentication", ok: false, detail: (e as Error).message });
    return { ok: false, steps };
  }

  try {
    const ownerRes = await fetch(`https://api.github.com/users/${owner}`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "tirsa-factory" },
      signal: AbortSignal.timeout(10_000),
    });
    if (ownerRes.status === 404) {
      steps.push({ name: "Owner", ok: false, detail: `"${owner}" not found on GitHub — check GITHUB_OWNER` });
      return { ok: false, steps };
    }
    if (!ownerRes.ok) {
      steps.push({ name: "Owner", ok: false, detail: `Owner lookup failed (HTTP ${ownerRes.status})` });
      return { ok: false, steps };
    }
    const ownerData = await ownerRes.json() as { type: string };
    steps.push({ name: "Owner", ok: true, detail: `"${owner}" exists (${ownerData.type})` });
  } catch (e: unknown) {
    steps.push({ name: "Owner", ok: false, detail: (e as Error).message });
    return { ok: false, steps };
  }

  return { ok: true, steps };
}

async function testTelegram(envMap: Record<string, string>): Promise<{ ok: boolean; steps: Step[] }> {
  const steps: Step[] = [];
  const botToken = envMap["TELEGRAM_BOT_TOKEN"];
  const chatId   = envMap["TELEGRAM_CHAT_ID"];

  if (!botToken) {
    steps.push({ name: "Bot token", ok: false, detail: "TELEGRAM_BOT_TOKEN not configured" });
    return { ok: false, steps };
  }
  steps.push({ name: "Bot token", ok: true, detail: "Token present" });

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json() as { ok: boolean; result?: { username?: string; first_name?: string } };
    if (!body.ok || !res.ok) {
      steps.push({ name: "Bot identity", ok: false, detail: "Invalid bot token — check @BotFather" });
      return { ok: false, steps };
    }
    const name = body.result?.first_name ?? body.result?.username ?? "unknown";
    steps.push({ name: "Bot identity", ok: true, detail: `Bot @${body.result?.username ?? name} is active` });
  } catch (e: unknown) {
    steps.push({ name: "Bot identity", ok: false, detail: (e as Error).message });
    return { ok: false, steps };
  }

  if (!chatId) {
    steps.push({ name: "Chat ID", ok: false, detail: "TELEGRAM_CHAT_ID not configured — bot is valid but won't know where to send notifications" });
    return { ok: false, steps };
  }
  steps.push({ name: "Chat ID", ok: true, detail: `Chat ID configured: ${chatId}` });

  // Send a real test message
  try {
    const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `✅ ${brand.name} — Telegram integration test successful!`, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(10_000),
    });
    const sendBody = await sendRes.json() as { ok: boolean; description?: string };
    if (!sendBody.ok) {
      steps.push({ name: "Send test", ok: false, detail: sendBody.description ?? "Failed to send message" });
      return { ok: false, steps };
    }
    steps.push({ name: "Send test", ok: true, detail: "Test message delivered" });
  } catch (e: unknown) {
    steps.push({ name: "Send test", ok: false, detail: (e as Error).message });
    return { ok: false, steps };
  }

  return { ok: true, steps };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { tenantId?: string; serviceId?: string };
    const { tenantId, serviceId } = body;
    if (!tenantId || !serviceId) {
      return NextResponse.json({ error: "tenantId and serviceId required" }, { status: 400 });
    }

    const client = sb();

    // Verify user is a member of this tenant
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: { user }, error: authErr } = await client.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { data: member } = await client.from("tenant_members").select("id").eq("tenant_id", tenantId).eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Load tenant credentials into a flat map.
    // For services that share var names (telegram vs platform_telegram), filter by
    // the exact service_id so credentials don't collide.
    const isScopedService = serviceId === "telegram" || serviceId === "platform_telegram";
    const credsQuery = client
      .from("tenant_integrations")
      .select("var_name, secret_value")
      .eq("tenant_id", tenantId);
    if (isScopedService) credsQuery.eq("service_id", serviceId);
    const { data: rows } = await credsQuery;

    const envMap: Record<string, string> = {};
    for (const row of rows ?? []) {
      if (row.secret_value) envMap[row.var_name as string] = row.secret_value as string;
    }

    let result: { ok: boolean; steps: Step[] };

    if (PROVIDER_TESTS[serviceId]) {
      result = await testProvider(serviceId, envMap);
    } else if (serviceId === "trigger") {
      result = await testTrigger(envMap);
    } else if (serviceId === "github") {
      result = await testGitHubBasic(envMap);
    } else if (serviceId === "telegram" || serviceId === "platform_telegram") {
      result = await testTelegram(envMap);
    } else {
      result = { ok: false, steps: [{ name: "Config", ok: false, detail: `No test defined for service: ${serviceId}` }] };
    }

    return NextResponse.json(result);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
