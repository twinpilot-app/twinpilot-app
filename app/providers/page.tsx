"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import IntegrationsShell from "../../components/IntegrationsShell";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { brand } from "@/lib/brand";
import {
  CheckCircle2, AlertCircle, ExternalLink, ChevronDown, ChevronRight,
  Loader2, RefreshCw, Eye, EyeOff, Save, Zap, X, Shield,
} from "lucide-react";

/* ── Provider catalogue ─────────────────────────────────────────────────────── */

interface ProviderMeta {
  id:                  string;
  name:                string;
  icon:                string;
  color:               string;
  description:         string;
  docsUrl:             string;
  dashboardUrl:        string;
  apiKeyVar:           string;
  apiKeyPlaceholder:   string;
  baseUrlVar:          string;
  baseUrlPlaceholder:  string;
  pricing?: {
    model:       string;
    inputPer1M:  number;
    outputPer1M: number;
    note?:       string;
  }[];
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: "anthropic", name: "Anthropic", icon: "🧠", color: "#00c2a8",
    description: "Claude Opus 4, Sonnet 4, Haiku 4.5. Best for reasoning-heavy agents.",
    docsUrl: "https://console.anthropic.com/settings/keys",
    dashboardUrl: "https://console.anthropic.com/usage",
    apiKeyVar: "ANTHROPIC_API_KEY", apiKeyPlaceholder: "sk-ant-…",
    baseUrlVar: "ANTHROPIC_BASE_URL", baseUrlPlaceholder: "https://api.anthropic.com",
    pricing: [
      { model: "claude-opus-4-…",    inputPer1M: 15.0, outputPer1M: 75.0 },
      { model: "claude-sonnet-4-…",  inputPer1M: 3.0,  outputPer1M: 15.0, note: "recommended" },
      { model: "claude-haiku-4-5-…", inputPer1M: 0.8,  outputPer1M: 4.0  },
    ],
  },
  {
    id: "openai", name: "OpenAI", icon: "◆", color: "#10a37f",
    description: "GPT-4o, o1, o3-mini. Also compatible with Azure OpenAI endpoints.",
    docsUrl: "https://platform.openai.com/api-keys",
    dashboardUrl: "https://platform.openai.com/usage",
    apiKeyVar: "OPENAI_API_KEY", apiKeyPlaceholder: "sk-…",
    baseUrlVar: "OPENAI_BASE_URL", baseUrlPlaceholder: "https://api.openai.com/v1",
    pricing: [
      { model: "gpt-4o",      inputPer1M: 2.50, outputPer1M: 10.0  },
      { model: "gpt-4o-mini", inputPer1M: 0.15, outputPer1M: 0.60, note: "recommended" },
      { model: "o1",          inputPer1M: 15.0, outputPer1M: 60.0  },
      { model: "o3-mini",     inputPer1M: 1.10, outputPer1M: 4.40  },
    ],
  },
  {
    id: "google", name: "Google", icon: "🌐", color: "#f59f00",
    description: "Gemini 2.5 Pro and Flash. Multimodal, large context, fast.",
    docsUrl: "https://aistudio.google.com/app/apikey",
    dashboardUrl: "https://aistudio.google.com",
    apiKeyVar: "GEMINI_API_KEY", apiKeyPlaceholder: "AIza…",
    baseUrlVar: "GEMINI_BASE_URL", baseUrlPlaceholder: "https://generativelanguage.googleapis.com",
    pricing: [
      { model: "gemini-2.5-pro",   inputPer1M: 1.25, outputPer1M: 10.0  },
      { model: "gemini-2.5-flash", inputPer1M: 0.15, outputPer1M: 0.60, note: "recommended" },
    ],
  },
  {
    id: "mistral", name: "Mistral", icon: "🌬", color: "#7c4dff",
    description: "Mistral Large, Small, Codestral. Strong at code and multilingual tasks.",
    docsUrl: "https://console.mistral.ai/api-keys",
    dashboardUrl: "https://console.mistral.ai/usage",
    apiKeyVar: "MISTRAL_API_KEY", apiKeyPlaceholder: "…",
    baseUrlVar: "MISTRAL_BASE_URL", baseUrlPlaceholder: "https://api.mistral.ai/v1",
    pricing: [
      { model: "mistral-large-latest", inputPer1M: 3.0, outputPer1M: 9.0  },
      { model: "mistral-small-latest", inputPer1M: 0.2, outputPer1M: 0.6, note: "recommended" },
      { model: "codestral-latest",     inputPer1M: 0.3, outputPer1M: 0.9  },
    ],
  },
  {
    id: "perplexity", name: "Perplexity", icon: "🔍", color: "#20b2aa",
    description: "Sonar models with built-in web search. Ideal for Scout and Research agents.",
    docsUrl: "https://docs.perplexity.ai",
    dashboardUrl: "https://www.perplexity.ai/settings/api",
    apiKeyVar: "PERPLEXITY_API_KEY", apiKeyPlaceholder: "pplx-…",
    baseUrlVar: "PERPLEXITY_BASE_URL", baseUrlPlaceholder: "https://api.perplexity.ai",
    pricing: [
      { model: "sonar-pro", inputPer1M: 3.0, outputPer1M: 15.0 },
      { model: "sonar",     inputPer1M: 1.0, outputPer1M: 1.0,  note: "recommended" },
    ],
  },
  {
    id: "xai", name: "xAI", icon: "✕", color: "#e2e8f0",
    description: "Grok models by xAI. Strong reasoning and real-time knowledge.",
    docsUrl: "https://docs.x.ai/docs",
    dashboardUrl: "https://console.x.ai",
    apiKeyVar: "XAI_API_KEY", apiKeyPlaceholder: "xai-…",
    baseUrlVar: "XAI_BASE_URL", baseUrlPlaceholder: "https://api.x.ai/v1",
  },
  {
    id: "zai", name: "zAI (01.AI)", icon: "⓪", color: "#6366f1",
    description: "Yi models from Zero One AI. Competitive cost/performance.",
    docsUrl: "https://platform.01.ai/docs",
    dashboardUrl: "https://platform.01.ai",
    apiKeyVar: "ZAI_API_KEY", apiKeyPlaceholder: "…",
    baseUrlVar: "ZAI_BASE_URL", baseUrlPlaceholder: "https://api.01.ai/v1",
  },
  {
    id: "deepseek", name: "DeepSeek", icon: "🔵", color: "#1463ff",
    description: "DeepSeek-V3 and R1. Best cost/performance ratio. Default for most agents.",
    docsUrl: "https://platform.deepseek.com/api_keys",
    dashboardUrl: "https://platform.deepseek.com/usage",
    apiKeyVar: "DEEPSEEK_API_KEY", apiKeyPlaceholder: "sk-…",
    baseUrlVar: "DEEPSEEK_BASE_URL", baseUrlPlaceholder: "https://api.deepseek.com/v1",
    pricing: [
      { model: "deepseek-chat",     inputPer1M: 0.27, outputPer1M: 1.10, note: "recommended" },
      { model: "deepseek-reasoner", inputPer1M: 0.55, outputPer1M: 2.19 },
    ],
  },
  {
    id: "qwen", name: "Qwen", icon: "🧩", color: "#ff6a00",
    description: "Qwen2.5, QwQ and Alibaba Cloud models. Strong at Chinese and code.",
    docsUrl: "https://help.aliyun.com/zh/model-studio/developer-reference/get-api-key",
    dashboardUrl: "https://dashscope.console.aliyun.com",
    apiKeyVar: "QWEN_API_KEY", apiKeyPlaceholder: "sk-…",
    baseUrlVar: "QWEN_BASE_URL", baseUrlPlaceholder: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    pricing: [
      { model: "qwen-max",   inputPer1M: 1.60, outputPer1M: 6.40 },
      { model: "qwen-plus",  inputPer1M: 0.40, outputPer1M: 1.20, note: "recommended" },
      { model: "qwen-turbo", inputPer1M: 0.05, outputPer1M: 0.20 },
    ],
  },
  {
    id: "moonshot", name: "Moonshot AI", icon: "🌙", color: "#a78bfa",
    description: "Kimi models with very large context windows (up to 128k).",
    docsUrl: "https://platform.moonshot.cn/docs",
    dashboardUrl: "https://platform.moonshot.cn/console/billing",
    apiKeyVar: "MOONSHOT_API_KEY", apiKeyPlaceholder: "sk-…",
    baseUrlVar: "MOONSHOT_BASE_URL", baseUrlPlaceholder: "https://api.moonshot.cn/v1",
  },
];

/* ── Types ──────────────────────────────────────────────────────────────────── */

interface TestStep   { name: string; ok: boolean; detail: string }
interface TestResult { ok: boolean; steps: TestStep[] }
interface LiveModel  { id: string; name: string }

/* ── i18n ───────────────────────────────────────────────────────────────────── */

type Lang = "en" | "pt";

const CONSENT_COPY = {
  en: {
    title:    "Before you continue",
    subtitle: "Read the responsibility notice",
    p1:       <>{brand.name} orchestrates AI pipelines using <strong>your own credentials</strong> from providers (Anthropic, OpenAI, Google, etc.). Each API call is billed directly to your account with the respective provider.</>,
    p2:       <><strong>{brand.name} is not responsible for API costs</strong> incurred through use of the platform. Manage your limits and billing alerts in each provider&apos;s settings.</>,
    warn:     "⚠ Keep your API keys secure. Do not share them with third parties.",
    cta:      "I understand, continue",
  },
  pt: {
    title:    "Antes de continuar",
    subtitle: "Leia o aviso de responsabilidade",
    p1:       <>A {brand.name} orquestra pipelines de IA usando as <strong>suas próprias credenciais</strong> de provedores (Anthropic, OpenAI, Google, etc.). Cada chamada de API é cobrada diretamente na sua conta junto ao provedor.</>,
    p2:       <><strong>A {brand.name} não se responsabiliza por custos de API</strong> gerados pelo uso da plataforma. Gerencie seus limites e alertas de billing nas configurações de cada provedor.</>,
    warn:     "⚠ Mantenha suas chaves de API seguras. Não as compartilhe com terceiros.",
    cta:      "Entendi, continuar",
  },
} as const;

function useLang(): [Lang, (l: Lang) => void] {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    const stored = localStorage.getItem("tirsa_lang");
    if (stored === "en" || stored === "pt") setLangState(stored);
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem("tirsa_lang", l);
  }, []);
  return [lang, setLang];
}

function LangToggle({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {(["en", "pt"] as Lang[]).map((l) => (
        <button
          key={l}
          onClick={() => onChange(l)}
          title={l === "en" ? "English" : "Português"}
          style={{
            background: lang === l ? "var(--surface1)" : "transparent",
            border: lang === l ? "1px solid var(--surface2)" : "1px solid transparent",
            borderRadius: 6, padding: "2px 6px", cursor: "pointer",
            fontSize: 16, lineHeight: 1, opacity: lang === l ? 1 : 0.45,
            transition: "all 0.15s",
          }}
        >{l === "en" ? "🇬🇧" : "🇧🇷"}</button>
      ))}
    </div>
  );
}

/* ── FactoryConsentModal ─────────────────────────────────────────────────────── */

function FactoryConsentModal({ onAccept }: { onAccept: () => void }) {
  const [lang, setLang] = useLang();
  const t = CONSENT_COPY[lang];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", backdropFilter: "blur(6px)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "var(--mantle)", border: "1px solid var(--surface2)", borderRadius: 16, width: "min(480px, 94vw)", padding: "32px 28px", boxShadow: "0 32px 80px rgba(0,0,0,0.55)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: "rgba(20,99,255,0.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Shield size={22} color="#1463ff" />
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{t.title}</div>
              <div style={{ fontSize: 12, color: "var(--overlay0)" }}>{t.subtitle}</div>
            </div>
          </div>
          <LangToggle lang={lang} onChange={setLang} />
        </div>
        <p style={{ fontSize: 13, color: "var(--subtext1)", lineHeight: 1.75, marginBottom: 14 }}>{t.p1}</p>
        <p style={{ fontSize: 13, color: "var(--subtext1)", lineHeight: 1.75, marginBottom: 20 }}>{t.p2}</p>
        <div style={{ background: "rgba(245,159,0,0.08)", border: "1px solid rgba(245,159,0,0.25)", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "var(--yellow)", marginBottom: 28, lineHeight: 1.6 }}>
          {t.warn}
        </div>
        <button
          onClick={onAccept}
          style={{ width: "100%", padding: "12px", borderRadius: 10, border: "none", background: "#1463ff", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}
        >
          {t.cta}
        </button>
      </div>
    </div>
  );
}

/* ── TestResultBanner ────────────────────────────────────────────────────────── */

function TestResultBanner({ result, onClose }: { result: TestResult; onClose: () => void }) {
  return (
    <div style={{ marginTop: 12, borderRadius: 10, overflow: "hidden", border: `1px solid ${result.ok ? "rgba(28,191,107,0.3)" : "rgba(237,67,55,0.3)"}`, background: result.ok ? "rgba(28,191,107,0.06)" : "rgba(237,67,55,0.06)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: `1px solid ${result.ok ? "rgba(28,191,107,0.15)" : "rgba(237,67,55,0.15)"}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 700, color: result.ok ? "var(--green)" : "var(--red)" }}>
          {result.ok ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
          {result.ok ? "Connection successful" : "Connection failed"}
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 2, display: "flex" }}>
          <X size={13} />
        </button>
      </div>
      <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
        {result.steps.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 7, fontSize: 11 }}>
            <span style={{ color: s.ok ? "var(--green)" : "var(--red)", flexShrink: 0, marginTop: 1 }}>
              {s.ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
            </span>
            <span style={{ color: "var(--subtext1)", fontWeight: 600, flexShrink: 0 }}>{s.name}</span>
            <span style={{ color: "var(--overlay1)" }}>— {s.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Pricing formatter ───────────────────────────────────────────────────────── */

function fmt(n: number) {
  return n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(1)}`;
}

/* ── ModelRow ────────────────────────────────────────────────────────────────── */

function ModelRow({ model, pricing }: {
  model: LiveModel;
  pricing?: { inputPer1M: number; outputPer1M: number; note?: string };
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", background: "var(--surface0)", borderRadius: 7 }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{model.name !== model.id ? model.name : model.id}</span>
          {pricing?.note === "recommended" && (
            <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 99, background: "rgba(28,191,107,0.12)", color: "var(--green)" }}>recommended</span>
          )}
        </div>
        <code style={{ fontSize: 10, color: "var(--overlay0)" }}>{model.id}</code>
      </div>
      {pricing ? (
        <div style={{ textAlign: "right", fontSize: 11, color: "var(--subtext0)", whiteSpace: "nowrap" }}>
          {fmt(pricing.inputPer1M)}<span style={{ color: "var(--overlay0)" }}>/1M in</span>
          {" · "}
          {fmt(pricing.outputPer1M)}<span style={{ color: "var(--overlay0)" }}>/1M out</span>
        </div>
      ) : (
        <span style={{ fontSize: 10, color: "var(--overlay0)" }}>see dashboard</span>
      )}
    </div>
  );
}

/* ── ProviderCard ────────────────────────────────────────────────────────────── */

interface ProviderCardProps {
  meta:       ProviderMeta;
  configured: Set<string>;
  liveModels: LiveModel[] | null;
  tenantId:   string;
  onSaved:    (serviceId: string, keyNames: string[]) => void;
}

function ProviderCard({ meta, configured, liveModels, tenantId, onSaved }: ProviderCardProps) {
  const { session } = useAuth();
  const [open,         setOpen]         = useState(false);
  const [values,       setValues]       = useState<{ apiKey?: string; baseUrl?: string }>({});
  const [showApiKey,   setShowApiKey]   = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [saved,        setSaved]        = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [testing,      setTesting]      = useState(false);
  const [testResult,   setTestResult]   = useState<TestResult | null>(null);

  const apiKeyConfigured  = configured.has(`${meta.id}:${meta.apiKeyVar}`);
  const baseUrlConfigured = configured.has(`${meta.id}:${meta.baseUrlVar}`);

  function matchPricing(modelId: string) {
    return meta.pricing?.find((p) => modelId.startsWith(p.model.replace(/…$/, "").replace(/-$/, "")));
  }

  async function handleSave() {
    const edited: Record<string, string> = {};
    if (values.apiKey?.trim())  edited[meta.apiKeyVar]  = values.apiKey.trim();
    if (values.baseUrl?.trim()) edited[meta.baseUrlVar] = values.baseUrl.trim();
    if (Object.keys(edited).length === 0) { setError("Enter a value to save"); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/settings/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ tenantId, serviceId: meta.id, keys: edited }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(b.error ?? "Save failed");
      }
      setSaved(true); setTimeout(() => setSaved(false), 3000);
      onSaved(meta.id, Object.keys(edited));
      setValues({});
    } catch (e: unknown) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function handleTest() {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch("/api/settings/integrations/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ tenantId, serviceId: meta.id }),
      });
      setTestResult(await res.json() as TestResult);
    } catch (e: unknown) {
      setTestResult({ ok: false, steps: [{ name: "Request", ok: false, detail: (e as Error).message }] });
    } finally { setTesting(false); }
  }

  const modelsLabel = apiKeyConfigured ? "Available models" : "Example models";

  return (
    <div style={{
      background: "var(--mantle)",
      border: apiKeyConfigured ? "1px solid rgba(28,191,107,0.3)" : "1px solid var(--surface1)",
      borderRadius: 12, overflow: "hidden", marginBottom: 8, transition: "border-color 0.2s",
    }}>
      {/* Header */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        <div style={{
          width: 38, height: 38, borderRadius: 9, flexShrink: 0,
          background: `${meta.color}18`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19,
        }}>
          {meta.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{meta.name}</span>
            {apiKeyConfigured && (
              <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11, color: "var(--green)", fontWeight: 600 }}>
                <CheckCircle2 size={11} /> Configured
              </span>
            )}
            {liveModels !== null && apiKeyConfigured && (
              <span style={{ fontSize: 10, color: "var(--overlay0)" }}>
                {liveModels.length} model{liveModels.length !== 1 ? "s" : ""}
              </span>
            )}
            {!apiKeyConfigured && (
              <span style={{ fontSize: 11, color: "var(--overlay0)" }}>Not configured</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--subtext0)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {meta.description}
          </div>
        </div>
        <ChevronDown size={14} color="var(--overlay0)" style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
      </button>

      {/* Expanded body */}
      {open && (
        <div style={{ borderTop: "1px solid var(--surface0)", padding: "16px" }}>

          {/* ── Key form ── */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext1)", marginBottom: 4 }}>
              API key
              <span style={{ fontSize: 10, fontWeight: 400, color: "var(--overlay0)", marginLeft: 8 }}>
                <a href={meta.docsUrl} target="_blank" rel="noreferrer" style={{ color: "var(--blue)", textDecoration: "none" }}>Get key ↗</a>
              </span>
            </label>
            <div style={{ position: "relative" }}>
              <input
                type={showApiKey ? "text" : "password"}
                placeholder={apiKeyConfigured && !values.apiKey ? "•••••••••• (set — paste to update)" : meta.apiKeyPlaceholder}
                value={values.apiKey ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, apiKey: e.target.value }))}
                style={{ width: "100%", padding: "8px 36px 8px 12px", background: "var(--surface0)", border: "1px solid var(--surface1)", borderRadius: 8, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((s) => !s)}
                style={{ position: "absolute", right: 9, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 3 }}
              >
                {showApiKey ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          </div>

          {/* Advanced: Base URL */}
          <button
            onClick={() => setShowAdvanced((s) => !s)}
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--overlay1)", background: "none", border: "none", cursor: "pointer", padding: "0 0 10px", fontFamily: "var(--font-sans)" }}
          >
            {showAdvanced ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            Advanced (Base URL)
            {baseUrlConfigured && !showAdvanced && (
              <span style={{ fontSize: 10, color: "var(--green)" }}>· set</span>
            )}
          </button>

          {showAdvanced && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--subtext1)", marginBottom: 4 }}>
                Base URL
                <span style={{ fontSize: 10, fontWeight: 400, color: "var(--overlay0)", marginLeft: 8 }}>Optional — for proxies or private deployments</span>
              </label>
              <input
                type="text"
                placeholder={baseUrlConfigured && !values.baseUrl ? "•••••••••• (set — paste to update)" : meta.baseUrlPlaceholder}
                value={values.baseUrl ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, baseUrl: e.target.value }))}
                style={{ width: "100%", padding: "8px 12px", background: "var(--surface0)", border: "1px solid var(--surface1)", borderRadius: 8, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
              />
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 10px", borderRadius: 7, marginBottom: 10, background: "rgba(237,67,55,0.1)", border: "1px solid rgba(237,67,55,0.2)", color: "var(--red)", fontSize: 12 }}>
              <AlertCircle size={12} style={{ flexShrink: 0 }} /> {error}
            </div>
          )}

          {/* Action bar */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <a
              href={meta.dashboardUrl} target="_blank" rel="noreferrer"
              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--blue)", textDecoration: "none" }}
            >
              <ExternalLink size={10} /> Dashboard
            </a>
            <div style={{ display: "flex", gap: 6 }}>
              {apiKeyConfigured && (
                <button
                  onClick={handleTest} disabled={testing}
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 11px", borderRadius: 8, border: "1px solid var(--surface2)", background: "var(--surface0)", color: "var(--subtext1)", fontSize: 12, fontWeight: 600, cursor: testing ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)", opacity: testing ? 0.7 : 1 }}
                >
                  {testing ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Zap size={12} />}
                  {testing ? "Testing…" : "Test"}
                </button>
              )}
              <button
                onClick={handleSave} disabled={saving}
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 14px", borderRadius: 8, border: "none", background: saved ? "rgba(28,191,107,0.15)" : "#1463ff", color: saved ? "var(--green)" : "#fff", fontSize: 12, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)" }}
              >
                {saving  ? <><Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> Saving…</>
                : saved  ? <><CheckCircle2 size={12} /> Saved</>
                : <><Save size={12} /> Save</>}
              </button>
            </div>
          </div>

          {/* Test result */}
          {testResult && <TestResultBanner result={testResult} onClose={() => setTestResult(null)} />}

          {/* Models divider */}
          <div style={{ height: 1, background: "var(--surface0)", margin: "16px 0" }} />

          {/* Models section */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--overlay0)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
              {modelsLabel}
            </div>

            {apiKeyConfigured && liveModels === null ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--overlay0)", padding: "8px 0" }}>
                <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Loading models…
              </div>
            ) : apiKeyConfigured && liveModels !== null && liveModels.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--overlay0)", padding: "6px 0" }}>
                No models returned — the API key may be invalid. Save a new key and test the connection.
              </div>
            ) : apiKeyConfigured && liveModels ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {liveModels.map((m) => (
                  <ModelRow key={m.id} model={m} pricing={matchPricing(m.id)} />
                ))}
                {meta.pricing && (
                  <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
                    * Pricing indicative (USD/1M tokens) — verify on{" "}
                    <a href={meta.dashboardUrl} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>provider dashboard</a>.
                  </div>
                )}
              </div>
            ) : meta.pricing ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 5, opacity: 0.6 }}>
                {meta.pricing.map((p) => (
                  <ModelRow key={p.model} model={{ id: p.model, name: p.model }} pricing={p} />
                ))}
                <div style={{ fontSize: 10, color: "var(--overlay0)", marginTop: 4 }}>
                  Save your API key above to see the live model list.
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "var(--overlay0)", padding: "6px 0" }}>
                Save your API key above to see available models.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


/* ── Page ────────────────────────────────────────────────────────────────────── */

interface LiveProviderData { id: string; models: LiveModel[] }

export default function ProvidersPage() {
  const router = useRouter();
  const { session, tenantId, loading: authLoading } = useAuth();
  const [configured,         setConfigured]         = useState<Set<string>>(new Set());
  const [liveData,           setLiveData]           = useState<LiveProviderData[] | null>(null);
  const [loadingLive,        setLoadingLive]        = useState(false);
  const [pageReady,          setPageReady]          = useState(false);
  const [showFactoryConsent, setShowFactoryConsent] = useState(false);

  // Auth guard
  useEffect(() => {
    if (!authLoading && !session) router.replace("/login");
  }, [authLoading, session, router]);

  /* Load configured keys once tenantId is known */
  useEffect(() => {
    if (!tenantId || !session) return;
    fetch(`/api/settings/integrations?tenantId=${tenantId}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (res) => {
        if (res.ok) {
          const body = await res.json() as { configured: string[] };
          setConfigured(new Set(body.configured));
        }
        const consentKey = `tirsa_factory_consent_${tenantId}`;
        if (!localStorage.getItem(consentKey)) setShowFactoryConsent(true);
        setPageReady(true);
      });
  }, [tenantId, session]);

  /* Fetch live models */
  const fetchLiveModels = useCallback(async () => {
    if (!tenantId || !session) return;
    setLoadingLive(true);
    try {
      const res = await fetch("/api/wizard/models", { headers: { Authorization: `Bearer ${session.access_token}` } });
      if (res.ok) {
        const body = await res.json() as { providers: LiveProviderData[] };
        setLiveData(body.providers ?? []);
      }
    } finally { setLoadingLive(false); }
  }, [tenantId, session]);

  useEffect(() => { if (tenantId) fetchLiveModels(); }, [tenantId, fetchLiveModels]);

  const handleSaved = useCallback((serviceId: string, keyNames: string[]) => {
    setConfigured((prev) => {
      const next = new Set(prev);
      keyNames.forEach((k) => next.add(`${serviceId}:${k}`));
      return next;
    });
    // Refresh live models after saving a new key
    fetchLiveModels();
  }, [fetchLiveModels]);

  function isApiKeyConfigured(meta: ProviderMeta) {
    return configured.has(`${meta.id}:${meta.apiKeyVar}`);
  }

  function liveModelsFor(id: string): LiveModel[] | null {
    if (liveData === null) return null;
    return liveData.find((p) => p.id === id)?.models ?? [];
  }

  const configuredCount = PROVIDERS.filter(isApiKeyConfigured).length;

  return (
    <>
      {showFactoryConsent && (
        <FactoryConsentModal onAccept={() => {
          if (tenantId) localStorage.setItem(`tirsa_factory_consent_${tenantId}`, new Date().toISOString());
          setShowFactoryConsent(false);
        }} />
      )}

      <IntegrationsShell
        active="providers"
        title="AI Providers"
        description="Configure API keys for each provider directly here. Keys are stored encrypted — never exposed to the browser after saving."
        maxWidth={760}
        headerActions={
          <button
            onClick={() => fetchLiveModels()}
            disabled={loadingLive || !tenantId}
            title="Refresh live model lists"
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 12px", borderRadius: 8, border: "1px solid var(--surface1)", background: "var(--surface0)", color: "var(--subtext1)", fontSize: 12, cursor: loadingLive ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)", flexShrink: 0 }}
          >
            {loadingLive
              ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
              : <RefreshCw size={13} />}
            Refresh models
          </button>
        }
      >
          {/* Status banner */}
          {pageReady && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8, padding: "11px 14px",
              borderRadius: 10, marginBottom: 24, fontSize: 12,
              background: configuredCount > 0 ? "rgba(28,191,107,0.07)" : "rgba(245,159,0,0.07)",
              border: `1px solid ${configuredCount > 0 ? "rgba(28,191,107,0.2)" : "rgba(245,159,0,0.2)"}`,
              color: configuredCount > 0 ? "var(--green)" : "var(--yellow)",
            }}>
              {configuredCount > 0 ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
              {configuredCount > 0
                ? `${configuredCount} of ${PROVIDERS.length} providers configured.`
                : "No providers configured. Agents cannot run without at least one AI provider."}
            </div>
          )}

          {/* Provider cards */}
          {PROVIDERS.map((meta) => (
            <ProviderCard
              key={meta.id}
              meta={meta}
              configured={configured}
              liveModels={isApiKeyConfigured(meta) ? liveModelsFor(meta.id) : []}
              tenantId={tenantId ?? ""}
              onSaved={handleSaved}
            />
          ))}

          {/* Footer note */}
          <div style={{ marginTop: 20, fontSize: 11, color: "var(--overlay0)", lineHeight: 1.7 }}>
            Pricing shown is indicative (USD per 1M tokens) and subject to change by each provider.
            API costs are billed directly to your provider accounts — {brand.name} is not responsible for charges.
          </div>

          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </IntegrationsShell>
    </>
  );
}
