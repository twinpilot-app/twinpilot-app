/**
 * GET /api/wizard/models
 *
 * Fetches available models from every AI provider that has an API key
 * configured in tenant_integrations. Calls each provider's models API
 * at runtime — no hardcoded model lists.
 *
 * Returns:
 *   { providers: { id, name, color, models: { id, name }[] }[] }
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// ── Provider registry ────────────────────────────────────────────────────────

interface ProviderCfg {
  id:          string;
  name:        string;
  color:       string;
  keyVar:      string;
  baseVar:     string;
  defaultBase: string;
  /** Path appended to base URL to list models */
  modelsPath:  string;
  /** Build request headers given the API key */
  authHeaders: (key: string) => Record<string, string>;
  /** Build query params for the models request (e.g. ?key= for Google) */
  authQuery?:  (key: string) => string;
  /** Extract model list from the raw JSON response */
  parseModels: (body: unknown) => { id: string; name: string }[];
}

// Standard OpenAI-compatible parser (GET /models → { data: [{ id }] })
function parseOpenAI(body: unknown): { id: string; name: string }[] {
  const b = body as { data?: { id: string }[] };
  return (b.data ?? []).map((m) => ({ id: m.id, name: m.id }));
}

const PROVIDERS: ProviderCfg[] = [
  {
    id: "anthropic", name: "Anthropic", color: "#00c2a8",
    keyVar: "ANTHROPIC_API_KEY", baseVar: "ANTHROPIC_BASE_URL",
    defaultBase: "https://api.anthropic.com",
    modelsPath: "/v1/models",
    authHeaders: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    parseModels: (body) => {
      const b = body as { data?: { id: string; display_name?: string }[] };
      return (b.data ?? []).map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
    },
  },
  {
    id: "openai", name: "OpenAI", color: "#10a37f",
    keyVar: "OPENAI_API_KEY", baseVar: "OPENAI_BASE_URL",
    defaultBase: "https://api.openai.com",
    modelsPath: "/v1/models",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    parseModels: (body) => parseOpenAI(body).filter((m) =>
      // Only chat-capable models
      m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3") || m.id.startsWith("chatgpt")
    ),
  },
  {
    id: "google", name: "Google", color: "#f59f00",
    keyVar: "GEMINI_API_KEY", baseVar: "GEMINI_BASE_URL",
    defaultBase: "https://generativelanguage.googleapis.com",
    modelsPath: "/v1beta/models",
    authHeaders: () => ({}),
    authQuery: (key) => `key=${key}`,
    parseModels: (body) => {
      const b = body as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
      return (b.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => ({
          id:   m.name.replace(/^models\//, ""),
          name: m.displayName ?? m.name.replace(/^models\//, ""),
        }));
    },
  },
  {
    id: "mistral", name: "Mistral", color: "#7c4dff",
    keyVar: "MISTRAL_API_KEY", baseVar: "MISTRAL_BASE_URL",
    defaultBase: "https://api.mistral.ai",
    modelsPath: "/v1/models",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    parseModels: parseOpenAI,
  },
  {
    id: "perplexity", name: "Perplexity", color: "#20b2aa",
    keyVar: "PERPLEXITY_API_KEY", baseVar: "PERPLEXITY_BASE_URL",
    defaultBase: "https://api.perplexity.ai",
    modelsPath: "/models",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    parseModels: parseOpenAI,
  },
  {
    id: "xai", name: "xAI", color: "#e2e8f0",
    keyVar: "XAI_API_KEY", baseVar: "XAI_BASE_URL",
    defaultBase: "https://api.x.ai",
    modelsPath: "/v1/models",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    parseModels: parseOpenAI,
  },
  {
    id: "zai", name: "zAI (01.AI)", color: "#6366f1",
    keyVar: "ZAI_API_KEY", baseVar: "ZAI_BASE_URL",
    defaultBase: "https://api.01.ai",
    modelsPath: "/v1/models",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    parseModels: parseOpenAI,
  },
  {
    id: "deepseek", name: "DeepSeek", color: "#1463ff",
    keyVar: "DEEPSEEK_API_KEY", baseVar: "DEEPSEEK_BASE_URL",
    defaultBase: "https://api.deepseek.com",
    modelsPath: "/v1/models",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    parseModels: parseOpenAI,
  },
  {
    id: "qwen", name: "Qwen", color: "#ff6a00",
    keyVar: "QWEN_API_KEY", baseVar: "QWEN_BASE_URL",
    defaultBase: "https://dashscope.aliyuncs.com/compatible-mode",
    modelsPath: "/v1/models",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    parseModels: parseOpenAI,
  },
  {
    id: "moonshot", name: "Moonshot AI", color: "#a78bfa",
    keyVar: "MOONSHOT_API_KEY", baseVar: "MOONSHOT_BASE_URL",
    defaultBase: "https://api.moonshot.cn",
    modelsPath: "/v1/models",
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    parseModels: parseOpenAI,
  },
];

// ── SSRF protection (same allowlist as chat route) ───────────────────────────

const SAFE_HOST_SUFFIXES = [
  ".anthropic.com", ".openai.com", ".googleapis.com", ".mistral.ai",
  ".perplexity.ai", ".x.ai", ".01.ai", ".deepseek.com",
  ".dashscope.aliyuncs.com", ".moonshot.cn",
];

function isSafeBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (process.env.NODE_ENV === "production" && u.protocol !== "https:") return false;
    const host = u.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return process.env.NODE_ENV !== "production";
    }
    const BLOCKED = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./];
    if (BLOCKED.some((re) => re.test(host))) return false;
    return SAFE_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s));
  } catch { return false; }
}

// ── Route ────────────────────────────────────────────────────────────────────

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function GET(req: NextRequest) {
  try {
    const token = req.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const sb = serviceClient();
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Get tenant
    const { data: member } = await sb
      .from("tenant_members").select("tenant_id").eq("user_id", user.id).single();
    if (!member) return NextResponse.json({ error: "No tenant" }, { status: 404 });

    const tenantId = member.tenant_id as string;

    // Load all tenant integrations into a flat map: VAR_NAME → value
    const { data: integrations } = await sb
      .from("tenant_integrations")
      .select("var_name, secret_value")
      .eq("tenant_id", tenantId);

    const envMap: Record<string, string> = {};
    for (const row of integrations ?? []) {
      if (row.secret_value) envMap[row.var_name as string] = row.secret_value as string;
    }

    // For each configured provider, fetch models
    const results = await Promise.all(
      PROVIDERS.map(async (p) => {
        const apiKey = envMap[p.keyVar];
        if (!apiKey) return null; // not configured

        const base = (envMap[p.baseVar] ?? p.defaultBase).replace(/\/$/, "");
        if (!isSafeBaseUrl(base)) return null; // block SSRF attempts
        const queryStr = p.authQuery ? `?${p.authQuery(apiKey)}` : "";
        const url = `${base}${p.modelsPath}${queryStr}`;

        try {
          const res = await fetch(url, {
            headers: { "Content-Type": "application/json", ...p.authHeaders(apiKey) },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) return null;
          const body = await res.json();
          const models = p.parseModels(body);
          if (models.length === 0) return null;
          return { id: p.id, name: p.name, color: p.color, models };
        } catch {
          return null;
        }
      })
    );

    const providers = results.filter(Boolean);
    return NextResponse.json({ providers });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
