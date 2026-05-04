"use client";

/**
 * WizardPanel — floating AI assistant for the Studio.
 *
 * Slide-in panel triggered by the magic wand FAB.
 * Lets users pick an LLM provider + model, then chat to configure
 * their factory (create projects, pipelines, etc.).
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { brand } from "@/lib/brand";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  X, Send, Loader2, ChevronDown, ChevronRight, ArrowLeft, Wand2, RotateCcw,
  CheckCircle2, AlertCircle, Sparkles,
} from "lucide-react";

/* ── Types ─────────────────────────────────────────────────────────────────── */

interface Model   { id: string; name: string }
interface Provider { id: string; name: string; color: string; models: Model[] }

interface Message {
  id:      string;
  role:    "user" | "assistant" | "system";
  content: string;
  actions?: { tool: string; args: unknown; result: unknown }[];
  error?:  string;
}

interface WizardPanelProps {
  factoryId:    string;
  onClose:      () => void;
  monthlyLimit?: number | null;
  /**
   * Called after a successful Confirm so the parent Studio page can refetch
   * its agents/pipelines/projects lists without a full page reload.
   */
  onConfirmed?: () => void;
}

/** Subset of the StudioPlan shape we render in the Pending Changes drawer. */
interface PlanView {
  agents:     Array<{ id: string; slug: string; name: string; squad?: string }>;
  pipelines:  Array<{ id: string; slug: string; name: string; steps: Array<{ step: number; agent: string }> }>;
  projects:   Array<{ id: string; slug: string; name: string; brief: string; pipelineId?: string | null }>;
  operations: Array<{ kind: string; projectId: string; pipelineId: string }>;
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

function uid() { return Math.random().toString(36).slice(2); }

const WELCOME = `Hi! I'm the ${brand.name} Wizard. I can help you:

- **Create projects** — set up what to build with a full intake brief
- **Design pipelines** — choose agents, phases, and gates
- **Assign pipelines** — connect a pipeline to a project
- **Create custom agents** — define specialist agents for your factory
- **Create squads** — group agents into collaborative teams

What would you like to build?`;

/* ── Action badge ───────────────────────────────────────────────────────────── */

function ActionBadge({ action }: { action: { tool: string; args: unknown; result: unknown } }) {
  const [open, setOpen] = useState(false);
  const result = action.result as Record<string, unknown>;
  const ok = result?.ok === true || (typeof result === "object" && !("error" in result));

  return (
    <div style={{
      marginTop: 6, borderRadius: 8, overflow: "hidden",
      border: `1px solid ${ok ? "rgba(28,191,107,0.25)" : "rgba(228,75,95,0.25)"}`,
      fontSize: 11,
    }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 6,
          padding: "5px 8px", background: ok ? "rgba(28,191,107,0.08)" : "rgba(228,75,95,0.08)",
          border: "none", cursor: "pointer", textAlign: "left",
          color: ok ? "var(--green)" : "var(--red)",
        }}
      >
        {ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
        <code style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>{action.tool}</code>
        <ChevronDown size={10} style={{ marginLeft: "auto", transform: open ? "rotate(180deg)" : "none", transition: "0.15s" }} />
      </button>
      {open && (
        <pre style={{
          margin: 0, padding: "6px 8px",
          background: "var(--crust)", color: "var(--subtext1)",
          fontSize: 10, overflowX: "auto", lineHeight: 1.5,
          fontFamily: "var(--font-mono)",
        }}>
          {JSON.stringify(action.result, null, 2)}
        </pre>
      )}
    </div>
  );
}

/* ── Message bubble ─────────────────────────────────────────────────────────── */

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";

  if (isSystem) {
    return (
      <div style={{
        padding: "6px 10px", borderRadius: 8, margin: "4px 0",
        background: msg.error ? "rgba(228,75,95,0.08)" : "rgba(107,122,158,0.08)",
        border: `1px solid ${msg.error ? "rgba(228,75,95,0.2)" : "var(--surface1)"}`,
        fontSize: 11, color: msg.error ? "var(--red)" : "var(--overlay1)",
        display: "flex", alignItems: "center", gap: 6,
      }}>
        {msg.error ? <AlertCircle size={11} /> : <Sparkles size={11} />}
        {msg.content}
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      alignItems: isUser ? "flex-end" : "flex-start",
      marginBottom: 12,
    }}>
      <div style={{
        maxWidth: "88%",
        padding: "10px 14px",
        borderRadius: isUser ? "14px 14px 4px 14px" : "4px 14px 14px 14px",
        background: isUser ? "#1463ff" : "var(--surface0)",
        color: isUser ? "#fff" : "var(--text)",
        fontSize: 13, lineHeight: 1.6,
      }}>
        {isUser ? (
          <span style={{ whiteSpace: "pre-wrap" }}>{msg.content}</span>
        ) : (
          <div className="wizard-md" style={{ fontSize: 13 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          </div>
        )}
      </div>
      {msg.actions && msg.actions.length > 0 && (
        <div style={{ maxWidth: "88%", width: "100%", marginTop: 4 }}>
          {msg.actions.map((a, i) => <ActionBadge key={i} action={a} />)}
        </div>
      )}
    </div>
  );
}

/* ── Provider / model selector (two-step) ────────────────────────────────────── */

function ModelSelector({
  providers,
  selectedProvider, selectedModel,
  onSelect,
}: {
  providers: Provider[];
  selectedProvider: string; selectedModel: string;
  onSelect: (provider: string, model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"provider" | "model">("provider");
  const [pickedProvider, setPickedProvider] = useState<string>("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setStep("provider");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function handleToggle() {
    setOpen((o) => {
      if (!o) setStep("provider");
      return !o;
    });
  }

  function handlePickProvider(id: string) {
    setPickedProvider(id);
    setStep("model");
  }

  function handlePickModel(providerId: string, modelId: string) {
    onSelect(providerId, modelId);
    setOpen(false);
    setStep("provider");
  }

  const currentProvider  = providers.find((p) => p.id === selectedProvider);
  const currentModel     = currentProvider?.models.find((m) => m.id === selectedModel);
  const label = currentModel ? `${currentProvider?.name} · ${currentModel.name}` : "Select model";
  const viewProvider = providers.find((p) => p.id === pickedProvider) ?? providers.find((p) => p.id === selectedProvider);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={handleToggle}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "5px 10px", borderRadius: 8,
          background: "var(--surface0)", border: "1px solid var(--surface1)",
          color: "var(--text)", fontSize: 11, fontWeight: 600,
          cursor: "pointer", fontFamily: "var(--font-sans)",
          maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}
      >
        {currentProvider && (
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: currentProvider.color, flexShrink: 0 }} />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{label}</span>
        <ChevronDown size={11} style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "0.15s" }} />
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0,
          background: "var(--mantle)", border: "1px solid var(--surface1)",
          borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
          zIndex: 1000, width: 280,
          padding: "6px",
        }}>
          {providers.length === 0 ? (
            <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--overlay0)" }}>
              No providers configured. Add API keys in Settings → Integrations.
            </div>
          ) : step === "provider" ? (
            <>
              <div style={{ padding: "5px 10px 4px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--overlay0)" }}>
                Choose provider
              </div>
              {providers.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handlePickProvider(p.id)}
                  style={{
                    width: "100%", textAlign: "left",
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "7px 10px", borderRadius: 8,
                    background: selectedProvider === p.id ? "var(--surface0)" : "transparent",
                    border: "none", cursor: "pointer", fontFamily: "var(--font-sans)",
                  }}
                >
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1 }}>{p.name}</span>
                  <span style={{ fontSize: 10, color: "var(--overlay0)" }}>{p.models.length} models</span>
                  <ChevronRight size={12} color="var(--overlay0)" />
                </button>
              ))}
            </>
          ) : (
            <>
              <button
                onClick={() => setStep("provider")}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "5px 10px", background: "none", border: "none",
                  cursor: "pointer", color: "var(--overlay0)", fontSize: 11,
                  fontFamily: "var(--font-sans)", marginBottom: 2,
                }}
              >
                <ArrowLeft size={11} /> Back
              </button>
              {viewProvider && (
                <>
                  <div style={{ padding: "2px 10px 6px", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: viewProvider.color }} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--subtext0)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{viewProvider.name}</span>
                  </div>
                  <div style={{ maxHeight: 240, overflowY: "auto" }}>
                    {viewProvider.models.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => handlePickModel(viewProvider.id, m.id)}
                        style={{
                          width: "100%", textAlign: "left", padding: "6px 10px 6px 24px",
                          background: selectedProvider === viewProvider.id && selectedModel === m.id ? "var(--surface0)" : "transparent",
                          border: "none", borderRadius: 7, cursor: "pointer",
                          color: "var(--text)", fontSize: 12, fontFamily: "var(--font-sans)",
                          fontWeight: selectedProvider === viewProvider.id && selectedModel === m.id ? 600 : 400,
                        }}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Disclaimer bar (bilingual) ──────────────────────────────────────────────── */

const DISCLAIMER = {
  en: `Calls are billed to your provider accounts. ${brand.name} is not responsible for costs.`,
  pt: `Chamadas são cobradas nas suas contas de provedor. A ${brand.name} não se responsabiliza pelos custos.`,
};

function DisclaimerBar({ monthlyLimit }: { monthlyLimit?: number | null }) {
  const [text, setText] = useState(DISCLAIMER.en);
  useEffect(() => {
    const stored = localStorage.getItem("tirsa_lang");
    setText(stored === "pt" ? DISCLAIMER.pt : DISCLAIMER.en);
  }, []);

  return (
    <div style={{
      padding: "5px 14px", borderTop: "1px solid var(--surface0)", flexShrink: 0,
      fontSize: 10, color: "var(--overlay0)", lineHeight: 1.5,
      display: "flex", alignItems: "center", gap: 6,
      background: "rgba(107,122,158,0.04)",
    }}>
      <span>⚠</span>
      <span>
        {text}
        {monthlyLimit != null && <span style={{ marginLeft: 6, color: "var(--yellow)" }}>Limit: ${monthlyLimit}/mo.</span>}
      </span>
    </div>
  );
}

/* ── Main panel ──────────────────────────────────────────────────────────────── */

const HISTORY_KEY = (factoryId: string) => `tirsa_wizard_history_${factoryId}`;
const MODEL_KEY = "tirsa_wizard_model";
const MAX_STORED_MESSAGES = 100;

export default function WizardPanel({ factoryId, onClose, monthlyLimit, onConfirmed }: WizardPanelProps) {
  const [providers,  setProviders]  = useState<Provider[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [selProvider, setSelProvider] = useState("");
  const [selModel,    setSelModel]    = useState("");

  // Restore history from localStorage on first render
  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const stored = localStorage.getItem(HISTORY_KEY(factoryId));
      if (stored) {
        const parsed = JSON.parse(stored) as Message[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch { /* ignore */ }
    return [{ id: uid(), role: "assistant", content: WELCOME }];
  });
  const [input,    setInput]    = useState("");
  const [sending,  setSending]  = useState(false);

  // Pending dry-run state — populated by chat responses when the LLM stages
  // entities. The Confirm bar below the messages renders when pendingCount > 0.
  // Detailed plan view lives at /studio/drafts; this panel keeps just the
  // bar with Confirm / Discard / View link.
  const [pending,    setPending]    = useState<{ sessionId: string; pendingCount: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Hydrate pending state on mount from /api/studio/session?factoryId=… so the
  // Confirm bar reflects work-in-progress from a previous browser tab/refresh.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      const res = await fetch(`/api/studio/session?factoryId=${encodeURIComponent(factoryId)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) return;
      const body = await res.json() as { session?: { id: string } | null; pendingCount?: number };
      if (cancelled) return;
      if (body.session && (body.pendingCount ?? 0) > 0) {
        setPending({ sessionId: body.session.id, pendingCount: body.pendingCount! });
      }
    })();
    return () => { cancelled = true; };
  }, [factoryId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY(factoryId), JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)));
    } catch { /* quota exceeded */ }
  }, [messages, factoryId]);

  // Load providers on mount, restoring saved model selection if still available
  useEffect(() => {
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;
      try {
        const res = await fetch("/api/wizard/models", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (res.ok) {
          const body = await res.json() as { providers: Provider[] };
          setProviders(body.providers);
          if (body.providers[0]) {
            // Try to restore previously selected model
            try {
              const saved = localStorage.getItem(MODEL_KEY);
              if (saved) {
                const { provider, model } = JSON.parse(saved) as { provider: string; model: string };
                const foundProvider = body.providers.find((p) => p.id === provider);
                if (foundProvider?.models.find((m) => m.id === model)) {
                  setSelProvider(provider);
                  setSelModel(model);
                  return;
                }
              }
            } catch { /* ignore */ }
            // Fallback to first available
            setSelProvider(body.providers[0].id);
            setSelModel(body.providers[0].models[0]?.id ?? "");
          }
        }
      } finally {
        setLoadingProviders(false);
      }
    })();
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSelect = useCallback((provider: string, model: string) => {
    setSelProvider(provider);
    setSelModel(model);
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify({ provider, model }));
    } catch { /* ignore */ }
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    if (!selProvider || !selModel) {
      setMessages((prev) => [...prev, { id: uid(), role: "system", content: "Select a model first.", error: "no-model" }]);
      return;
    }

    const userMsg: Message = { id: uid(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Session expired — please refresh.");

      // Build conversation history (exclude system messages)
      const history = [...messages, userMsg]
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const res = await fetch("/api/wizard/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messages:  history,
          provider:  selProvider,
          model:     selModel,
          factoryId,
        }),
      });

      const body = await res.json() as {
        reply?:        string;
        actions?:      { tool: string; args: unknown; result: unknown }[];
        sessionId?:    string | null;
        pendingCount?: number;
        error?:        string;
      };

      if (!res.ok || body.error) {
        setMessages((prev) => [...prev, { id: uid(), role: "system", content: body.error ?? "Request failed.", error: "api-error" }]);
        return;
      }

      setMessages((prev) => [...prev, {
        id: uid(), role: "assistant",
        content: body.reply ?? "",
        actions: body.actions ?? [],
      }]);

      // Update pending state from the chat response so the Confirm bar
      // reflects what was just staged. sessionId comes back null when the
      // turn fired no write tools.
      if (body.sessionId && (body.pendingCount ?? 0) > 0) {
        setPending({ sessionId: body.sessionId, pendingCount: body.pendingCount! });
      } else if (body.sessionId === null) {
        // Read-only turn — keep existing pending state intact.
      }
    } catch (e: unknown) {
      setMessages((prev) => [...prev, { id: uid(), role: "system", content: (e as Error).message, error: "error" }]);
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  function resetConversation() {
    setMessages([{ id: uid(), role: "assistant", content: WELCOME }]);
    setInput("");
    try { localStorage.removeItem(HISTORY_KEY(factoryId)); } catch { /* ignore */ }
  }

  // Confirm — flush the staged plan to the live tables.
  async function confirmPending() {
    if (!pending || confirming) return;
    setConfirming(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Session expired — please refresh.");

      const res = await fetch(`/api/studio/sessions/${pending.sessionId}/confirm`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ chatHistory: messages }),
      });
      const body = await res.json() as { ok?: boolean; error?: string; partialRollback?: boolean };
      if (!res.ok || !body.ok) {
        const detail = body.error ?? `Confirm failed (${res.status})`;
        const suffix = body.partialRollback ? " (partial inserts rolled back)" : "";
        setMessages((prev) => [...prev, { id: uid(), role: "system", content: `${detail}${suffix}`, error: "confirm-error" }]);
        return;
      }
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: `Confirmed — ${pending.pendingCount} item${pending.pendingCount === 1 ? "" : "s"} created.` }]);
      setPending(null);
      onConfirmed?.();
    } catch (e: unknown) {
      setMessages((prev) => [...prev, { id: uid(), role: "system", content: (e as Error).message, error: "error" }]);
    } finally {
      setConfirming(false);
    }
  }

  // Discard — drop the whole draft without committing anything.
  async function discardPending() {
    if (!pending || confirming) return;
    if (!confirm(`Discard ${pending.pendingCount} pending change${pending.pendingCount === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setConfirming(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Session expired — please refresh.");
      const res = await fetch(`/api/studio/sessions/${pending.sessionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Discard failed (${res.status})`);
      }
      setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: "Pending changes discarded." }]);
      setPending(null);
    } catch (e: unknown) {
      setMessages((prev) => [...prev, { id: uid(), role: "system", content: (e as Error).message, error: "error" }]);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <>
      {/* Panel */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: 440, zIndex: 900,
        background: "var(--mantle)",
        borderLeft: "1px solid var(--surface0)",
        display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 32px rgba(0,0,0,0.25)",
        animation: "slideInRight 0.2s ease",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "14px 16px", borderBottom: "1px solid var(--surface0)",
          flexShrink: 0,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 9,
            background: "rgba(164,120,255,0.15)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Wand2 size={16} color="#a478ff" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Factory Wizard</div>
            <div style={{ fontSize: 10, color: "var(--overlay0)" }}>AI configuration assistant</div>
          </div>
          <button
            onClick={resetConversation}
            title="Clear conversation history"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4, display: "flex", alignItems: "center" }}
          >
            <RotateCcw size={13} />
          </button>
          <button
            onClick={onClose}
            title="Close wizard"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--overlay0)", padding: 4, display: "flex", alignItems: "center" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Model selector bar */}
        <div style={{
          padding: "8px 14px", borderBottom: "1px solid var(--surface0)",
          display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
        }}>
          <span style={{ fontSize: 11, color: "var(--overlay0)", whiteSpace: "nowrap" }}>Model:</span>
          {loadingProviders ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--overlay0)" }}>
              <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> Loading providers…
            </div>
          ) : providers.length === 0 ? (
            <a href="/providers" target="_blank" style={{ fontSize: 11, color: "var(--yellow)", textDecoration: "none" }}>
              ⚠ No providers — configure in Providers
            </a>
          ) : (
            <ModelSelector
              providers={providers}
              selectedProvider={selProvider}
              selectedModel={selModel}
              onSelect={handleSelect}
            />
          )}
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          style={{
            flex: 1, overflowY: "auto", padding: "16px 14px",
          }}
        >
          {messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)}
          {sending && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--overlay0)", fontSize: 12, marginBottom: 12 }}>
              <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />
              Thinking…
            </div>
          )}
        </div>

        {/* Disclaimer */}
        <DisclaimerBar monthlyLimit={monthlyLimit} />

        {/* Pending changes bar — shown when the chat has staged things that
            haven't been committed yet. Detailed view + per-item discard
            lives at /studio/drafts (the View Drafts link). The bar keeps
            Confirm and Discard for quick action without leaving chat. */}
        {pending && pending.pendingCount > 0 && (
          <div style={{
            display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
            padding: "8px 12px", borderTop: "1px solid var(--surface0)",
            background: "rgba(164,120,255,0.08)", flexShrink: 0,
          }}>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99,
              background: "rgba(164,120,255,0.18)", color: "#a478ff",
              textTransform: "uppercase", letterSpacing: "0.04em",
            }}>
              {pending.pendingCount} pending
            </span>
            <a
              href="/studio/drafts"
              target="_blank"
              rel="noopener"
              style={{
                fontSize: 11, color: "#a478ff", textDecoration: "underline",
                cursor: "pointer", fontFamily: "var(--font-sans)",
              }}
            >
              View drafts →
            </a>
            <span style={{ flex: 1, fontSize: 11, color: "var(--subtext0)", lineHeight: 1.4, minWidth: 120 }}>
              Nothing written yet.
            </span>
            <button
              onClick={() => void discardPending()}
              disabled={confirming}
              style={{
                padding: "4px 10px", borderRadius: 6, border: "1px solid var(--surface1)",
                background: "transparent", color: "var(--red)", fontSize: 10, fontWeight: 700,
                cursor: confirming ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)",
              }}
            >
              Discard
            </button>
            <button
              onClick={() => void confirmPending()}
              disabled={confirming}
              style={{
                padding: "5px 12px", borderRadius: 6, border: "none",
                background: confirming ? "var(--surface1)" : "#a478ff", color: "#fff",
                fontSize: 11, fontWeight: 700,
                cursor: confirming ? "not-allowed" : "pointer", fontFamily: "var(--font-sans)",
                display: "flex", alignItems: "center", gap: 4,
              }}
            >
              {confirming ? <Loader2 size={11} style={{ animation: "spin 1s linear infinite" }} /> : null}
              Confirm
            </button>
          </div>
        )}

        {/* Input */}
        <div style={{
          padding: "10px 12px", borderTop: "1px solid var(--surface0)", flexShrink: 0,
          display: "flex", gap: 8, alignItems: "flex-end",
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask the wizard anything…  (Enter to send, Shift+Enter for newline)"
            rows={2}
            style={{
              flex: 1, resize: "none",
              padding: "9px 12px", borderRadius: 10,
              background: "var(--surface0)", border: "1px solid var(--surface1)",
              color: "var(--text)", fontSize: 13, lineHeight: 1.5, outline: "none",
              fontFamily: "var(--font-sans)",
            }}
          />
          <button
            onClick={() => void send()}
            disabled={sending || !input.trim() || !selModel}
            style={{
              width: 38, height: 38, borderRadius: 10, flexShrink: 0,
              background: sending || !input.trim() || !selModel ? "var(--surface1)" : "#a478ff",
              border: "none", cursor: sending || !input.trim() || !selModel ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: sending || !input.trim() || !selModel ? "var(--overlay0)" : "#fff",
            }}
          >
            {sending ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <Send size={15} />}
          </button>
        </div>
      </div>

      {/* Backdrop for mobile / small screens */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 899,
          background: "rgba(0,0,0,0.3)",
        }}
      />

      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
        .wizard-md p  { margin: 0 0 6px; }
        .wizard-md ul { margin: 0 0 6px; padding-left: 18px; }
        .wizard-md li { margin-bottom: 2px; }
        .wizard-md code { background: var(--surface1); border-radius: 4px; padding: 1px 5px; font-size: 11px; }
        .wizard-md pre  { background: var(--crust); border-radius: 8px; padding: 8px 12px; overflow-x: auto; margin: 6px 0; }
        .wizard-md strong { color: var(--text); }
      `}</style>
    </>
  );
}
