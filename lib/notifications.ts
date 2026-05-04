/**
 * Notification system — shared library for creating and dispatching notifications.
 * Used by both command-center API routes and control-plane pipeline.
 */

import { createClient } from "@supabase/supabase-js";

export type NotificationEventType =
  | "platform_update" | "platform_instability" | "worker_update" | "cli_update"
  | "sprint_started" | "sprint_completed" | "sprint_failed" | "sprint_needs_human"
  | "queue_empty" | "queue_full"
  | "human_gate" | "agent_escalation"
  | "factory_installed"
  | "auto_drain_halted" | "auto_drain_drained" | "auto_drain_unproductive"
  | "deploy_command_center" | "deploy_workers" | "deploy_cli"
  | "github_action_failed" | "github_action_success"
  | "supabase_health" | "vercel_health" | "trigger_health"
  | "new_tenant_registered" | "tenant_deleted"
  | "tenant_member_joined";

export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationChannel = "in_app" | "telegram" | "email" | "webhook";

export interface CreateNotificationParams {
  tenantId: string;
  eventType: NotificationEventType;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
  /** Base URL for gate approval links (e.g. https://app.tirsa.software). Auto-detected when omitted. */
  appUrl?: string;
}

/** Events that support gate approval via Telegram/webhook inline buttons */
const GATE_EVENTS: Set<NotificationEventType> = new Set(["human_gate", "agent_escalation"]);

/** DevOps events — always send to Telegram (platform ops) */
const DEVOPS_EVENTS: Set<NotificationEventType> = new Set([
  "deploy_command_center", "deploy_workers", "deploy_cli",
  "github_action_failed", "github_action_success",
  "supabase_health", "vercel_health", "trigger_health",
  "new_tenant_registered", "tenant_deleted",
]);

/** Default channel preferences when no explicit override exists.
 *  Telegram/in-app: ON if configured. Email/webhook: OFF until explicitly enabled.
 *  Tenants fine-tune via the preferences matrix in /notifications. */
const DEFAULT_PREFERENCES: Record<NotificationChannel, () => boolean> = {
  in_app:   () => true,
  telegram: () => true,
  email:    () => false,
  webhook:  () => false,
};

const CHANNELS: NotificationChannel[] = ["in_app", "telegram", "email", "webhook"];

/** Rate limit cooldowns in ms per event type — only for repetitive events */
const COOLDOWNS: Partial<Record<NotificationEventType, number>> = {
  queue_empty: 5 * 60 * 1000,
  queue_full:  5 * 60 * 1000,
};

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

interface GateUrls {
  approveUrl: string;
  rejectUrl: string;
}

/**
 * Generate one-time-use approval tokens for a gate event and return approve/reject URLs.
 */
async function generateGateTokens(
  sb: ReturnType<typeof serviceClient>,
  params: CreateNotificationParams,
  appUrl: string,
): Promise<GateUrls | null> {
  const projectId = params.metadata?.projectId as string | undefined;
  const runId = params.metadata?.runId as string | undefined;
  if (!projectId) return null;

  const rows = [
    { project_id: projectId, run_id: runId ?? null, tenant_id: params.tenantId, action: "approve" },
    { project_id: projectId, run_id: runId ?? null, tenant_id: params.tenantId, action: "reject" },
  ];

  const { data: tokens, error } = await sb
    .from("gate_approval_tokens")
    .insert(rows)
    .select("token, action");

  if (error || !tokens || tokens.length < 2) {
    console.error("[notifications] Failed to generate gate tokens:", error?.message);
    return null;
  }

  const approveToken = tokens.find((t: { action: string }) => t.action === "approve")?.token as string;
  const rejectToken = tokens.find((t: { action: string }) => t.action === "reject")?.token as string;

  return {
    approveUrl: `${appUrl}/api/gate?token=${approveToken}&action=approve`,
    rejectUrl: `${appUrl}/api/gate?token=${rejectToken}&action=reject`,
  };
}

/**
 * Create a notification and dispatch to enabled channels.
 * This is the main entry point for all notification events.
 */
export async function createNotification(params: CreateNotificationParams): Promise<string | null> {
  const sb = serviceClient();

  // Platform config check — skip if event disabled by owner
  const { data: platformCfg } = await sb
    .from("platform_notification_config")
    .select("enabled")
    .eq("event_type", params.eventType)
    .maybeSingle();
  if (platformCfg && !platformCfg.enabled) return null;

  // Rate limiting — check cooldown
  const cooldown = COOLDOWNS[params.eventType];
  if (cooldown) {
    const { data: recent } = await sb
      .from("notifications")
      .select("id")
      .eq("tenant_id", params.tenantId)
      .eq("event_type", params.eventType)
      .gte("created_at", new Date(Date.now() - cooldown).toISOString())
      .limit(1);
    if (recent && recent.length > 0) return null; // skip — too recent
  }

  // 1. Insert notification
  const scope = DEVOPS_EVENTS.has(params.eventType) ? "platform" : "tenant";
  const { data: notif, error } = await sb
    .from("notifications")
    .insert({
      tenant_id:  params.tenantId,
      event_type: params.eventType,
      severity:   params.severity,
      title:      params.title,
      body:       params.body ?? null,
      metadata:   params.metadata ?? {},
      scope,
    })
    .select("id")
    .single();

  if (error || !notif) {
    console.error("[notifications] Insert failed:", error?.message);
    return null;
  }

  // 2. Resolve enabled channels
  const { data: prefs } = await sb
    .from("notification_preferences")
    .select("channel, enabled")
    .eq("tenant_id", params.tenantId)
    .eq("event_type", params.eventType);

  const prefMap = new Map<string, boolean>();
  for (const p of prefs ?? []) prefMap.set(p.channel as string, p.enabled as boolean);

  const enabledChannels: NotificationChannel[] = [];
  for (const ch of CHANNELS) {
    const explicit = prefMap.get(ch);
    const enabled = explicit !== undefined ? explicit : DEFAULT_PREFERENCES[ch]();
    if (enabled) enabledChannels.push(ch);
  }

  // Check channel configs for email/webhook — skip if not configured
  if (enabledChannels.includes("email") || enabledChannels.includes("webhook")) {
    const { data: configs } = await sb
      .from("notification_channel_config")
      .select("channel, enabled")
      .eq("tenant_id", params.tenantId);
    const configMap = new Map<string, boolean>();
    for (const c of configs ?? []) configMap.set(c.channel as string, c.enabled as boolean);
    // Remove channels not configured
    for (let i = enabledChannels.length - 1; i >= 0; i--) {
      const ch = enabledChannels[i];
      if ((ch === "email" || ch === "webhook") && !configMap.get(ch)) {
        enabledChannels.splice(i, 1);
      }
    }
  }

  // Check telegram credentials exist in notification_channel_config
  if (enabledChannels.includes("telegram")) {
    const isPlatform = DEVOPS_EVENTS.has(params.eventType);
    if (isPlatform) {
      // Platform events use platform_telegram from tenant_integrations (admin config)
      const { data: tgInt } = await sb
        .from("tenant_integrations")
        .select("id")
        .eq("tenant_id", params.tenantId)
        .eq("service_id", "platform_telegram")
        .limit(1);
      if (!tgInt || tgInt.length === 0) {
        const idx = enabledChannels.indexOf("telegram");
        if (idx >= 0) enabledChannels.splice(idx, 1);
      }
    } else {
      // Tenant events use notification_channel_config
      const { data: tgCfg } = await sb
        .from("notification_channel_config")
        .select("id")
        .eq("tenant_id", params.tenantId)
        .eq("channel", "telegram")
        .eq("enabled", true)
        .limit(1);
      if (!tgCfg || tgCfg.length === 0) {
        const idx = enabledChannels.indexOf("telegram");
        if (idx >= 0) enabledChannels.splice(idx, 1);
      }
    }
  }

  if (enabledChannels.length === 0) return notif.id as string;

  // 3. Create delivery rows
  await sb.from("notification_deliveries").insert(
    enabledChannels.map((ch) => ({
      notification_id: notif.id,
      channel: ch,
      status: ch === "in_app" ? "sent" : "pending",
      attempted_at: ch === "in_app" ? new Date().toISOString() : null,
    })),
  );

  // 4. Generate gate approval tokens for gate events (used by Telegram + webhook)
  let gateUrls: GateUrls | null = null;
  if (GATE_EVENTS.has(params.eventType)) {
    const appUrl = params.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://tirsa-factory.vercel.app";
    gateUrls = await generateGateTokens(sb, params, appUrl);
  }

  // 5. Dispatch non-in-app channels (awaited to ensure delivery)
  for (const ch of enabledChannels) {
    if (ch === "in_app") continue;
    try {
      await dispatchChannel(sb, notif.id as string, ch, params, gateUrls);
    } catch (err) {
      console.error(`[notifications] ${ch} dispatch failed:`, err);
    }
  }

  return notif.id as string;
}

async function dispatchChannel(
  sb: ReturnType<typeof serviceClient>,
  notifId: string,
  channel: NotificationChannel,
  params: CreateNotificationParams,
  gateUrls: GateUrls | null,
) {
  try {
    if (channel === "telegram") {
      await dispatchTelegram(sb, params, gateUrls);
    } else if (channel === "webhook") {
      await dispatchWebhook(sb, params, gateUrls);
    }
    // email dispatcher added in later phase

    await sb.from("notification_deliveries").update({
      status: "sent",
      attempted_at: new Date().toISOString(),
    }).eq("notification_id", notifId).eq("channel", channel);
  } catch (err) {
    await sb.from("notification_deliveries").update({
      status: "failed",
      error_message: (err as Error).message,
      attempted_at: new Date().toISOString(),
    }).eq("notification_id", notifId).eq("channel", channel);
  }
}

async function dispatchTelegram(
  sb: ReturnType<typeof serviceClient>,
  params: CreateNotificationParams,
  gateUrls: GateUrls | null,
) {
  // Platform events: read from tenant_integrations (platform_telegram)
  // Tenant events: read from notification_channel_config (telegram)
  let botToken: string | undefined;
  let chatId: string | undefined;

  if (DEVOPS_EVENTS.has(params.eventType)) {
    const { data: integrations } = await sb
      .from("tenant_integrations")
      .select("var_name, secret_value")
      .eq("tenant_id", params.tenantId)
      .eq("service_id", "platform_telegram");
    const vars: Record<string, string> = {};
    for (const row of integrations ?? []) vars[row.var_name as string] = row.secret_value as string;
    botToken = vars.TELEGRAM_BOT_TOKEN;
    chatId = vars.TELEGRAM_CHAT_ID;
  } else {
    const { data: cfg } = await sb
      .from("notification_channel_config")
      .select("config")
      .eq("tenant_id", params.tenantId)
      .eq("channel", "telegram")
      .eq("enabled", true)
      .limit(1)
      .maybeSingle();
    const config = cfg?.config as { bot_token?: string; chat_id?: string } | null;
    botToken = config?.bot_token;
    chatId = config?.chat_id;
  }

  if (!botToken || !chatId) return;

  const sevIcon = params.severity === "critical" ? "🚨" : params.severity === "warning" ? "⚠️" : "ℹ️";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = `${sevIcon} <b>${esc(params.title)}</b>\n${params.body ? esc(params.body) : ""}\n\n<i>${params.eventType}</i>`;

  // Build Telegram payload — add inline keyboard for gate events
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };

  if (gateUrls) {
    payload.reply_markup = {
      inline_keyboard: [[
        { text: "✅ Approve", url: gateUrls.approveUrl },
        { text: "❌ Reject", url: gateUrls.rejectUrl },
      ]],
    };
  }

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function dispatchWebhook(
  sb: ReturnType<typeof serviceClient>,
  params: CreateNotificationParams,
  gateUrls: GateUrls | null,
) {
  const { data: config } = await sb
    .from("notification_channel_config")
    .select("config, enabled")
    .eq("tenant_id", params.tenantId)
    .eq("channel", "webhook")
    .single();

  if (!config?.enabled) return;

  const cfg = config.config as { url?: string; secret?: string; headers?: Record<string, string> };
  if (!cfg.url) return;

  const payloadObj: Record<string, unknown> = {
    event_type: params.eventType,
    severity: params.severity,
    title: params.title,
    body: params.body ?? null,
    metadata: params.metadata ?? {},
    timestamp: new Date().toISOString(),
  };

  // Include gate approval URLs for gate events
  if (gateUrls) {
    payloadObj.approve_url = gateUrls.approveUrl;
    payloadObj.reject_url = gateUrls.rejectUrl;
  }

  const payload = JSON.stringify(payloadObj);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Tirsa-Event": params.eventType,
    ...(cfg.headers ?? {}),
  };

  // HMAC signature if secret is configured
  if (cfg.secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(cfg.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    headers["X-Tirsa-Signature"] = `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  const res = await fetch(cfg.url, {
    method: "POST",
    headers,
    body: payload,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Webhook returned ${res.status}`);
  }
}
