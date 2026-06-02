import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface ServiceResult {
  name: string;
  status: "ok" | "degraded" | "down";
  latency: number;
}

async function probe(name: string): Promise<ServiceResult> {
  const start = Date.now();
  try {
    switch (name) {
      case "Supabase": {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (!url) return { name, status: "down", latency: 0 };
        const res = await fetch(`${url}/rest/v1/`, { cache: "no-store" });
        return { name, status: res.ok || res.status === 401 ? "ok" : "degraded", latency: Date.now() - start };
      }
      case "GitHub API": {
        const res = await fetch("https://api.github.com/rate_limit", {
          headers: process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {},
          cache: "no-store",
        });
        return { name, status: res.ok ? "ok" : "degraded", latency: Date.now() - start };
      }
      case "Anthropic": {
        const res = await fetch("https://api.anthropic.com", { method: "HEAD", cache: "no-store" }).catch(() => null);
        return { name, status: res ? "ok" : "down", latency: Date.now() - start };
      }
      case "Google AI": {
        const res = await fetch("https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta", { cache: "no-store" });
        return { name, status: res.ok ? "ok" : "degraded", latency: Date.now() - start };
      }
      case "DeepSeek": {
        const res = await fetch("https://api.deepseek.com", { method: "HEAD", cache: "no-store" }).catch(() => null);
        return { name, status: res ? "ok" : "down", latency: Date.now() - start };
      }
      case "Trigger.dev": {
        const res = await fetch("https://cloud.trigger.dev", { method: "HEAD", cache: "no-store" }).catch(() => null);
        return { name, status: res ? "ok" : "down", latency: Date.now() - start };
      }
      default:
        return { name, status: "down", latency: 0 };
    }
  } catch {
    return { name, status: "down", latency: Date.now() - start };
  }
}

const SERVICE_NAMES = ["Supabase", "GitHub API", "Anthropic", "Google AI", "DeepSeek", "Trigger.dev"];

export async function GET() {
  const results = await Promise.all(SERVICE_NAMES.map(probe));
  return NextResponse.json({ services: results, checkedAt: new Date().toISOString() });
}
