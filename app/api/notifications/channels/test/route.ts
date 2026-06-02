/**
 * POST /api/notifications/channels/test
 * Sends a test notification through a specific channel (server-side).
 * Body: { tenantId, channel, url?, secret? }
 */
import { NextRequest, NextResponse } from "next/server";
import { brand } from "@/lib/brand";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { NotificationsChannelTestSchema } from "@/lib/api-schemas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await parseBody(req, NotificationsChannelTestSchema);
    await getOperatorUser(req);

    if (body.channel === "webhook") {
      const url = body.url?.trim();
      if (!url) return NextResponse.json({ ok: false, error: "URL required" }, { status: 400 });

      const payload = JSON.stringify({
        event_type: "test",
        severity: "info",
        title: `${brand.name} — webhook test`,
        body: "If you see this, your webhook is working!",
        metadata: {},
        timestamp: new Date().toISOString(),
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Tirsa-Event": "test",
      };

      if (body.secret?.trim()) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(body.secret.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
        headers["X-Tirsa-Signature"] = `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        return NextResponse.json({ ok: false, error: `HTTP ${res.status}` });
      }
      return NextResponse.json({ ok: true, message: "Test delivered" });
    }

    if (body.channel === "telegram") {
      const botToken = (body as Record<string, string>).bot_token?.trim();
      const chatId = (body as Record<string, string>).chat_id?.trim();
      if (!botToken || !chatId) return NextResponse.json({ ok: false, error: "bot_token and chat_id required" }, { status: 400 });

      // Validate bot token
      const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, { signal: AbortSignal.timeout(10_000) });
      const meBody = await meRes.json() as { ok: boolean; result?: { username?: string } };
      if (!meBody.ok) return NextResponse.json({ ok: false, error: "Invalid bot token" });

      // Send test message
      const sendRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `<b>${brand.name}</b> — Telegram integration test successful!\n\n<i>Bot: @${meBody.result?.username ?? "?"}</i>`,
          parse_mode: "HTML",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const sendBody = await sendRes.json() as { ok: boolean; description?: string };
      if (!sendBody.ok) return NextResponse.json({ ok: false, error: sendBody.description ?? "Failed to send" });

      return NextResponse.json({ ok: true, message: `Test sent via @${meBody.result?.username ?? "bot"}` });
    }

    return NextResponse.json({ ok: false, error: `No test for channel: ${body.channel}` }, { status: 400 });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
