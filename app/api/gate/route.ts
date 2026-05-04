/**
 * GET /api/gate?token=<approval_token>&action=approve|reject
 *
 * One-time-use gate approval via token. Used by Telegram inline buttons
 * and webhook approve/reject URLs. No auth required — the token IS the auth.
 *
 * After approval, redirects to the command center with a success message.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { brand } from "@/lib/brand";

export const dynamic = "force-dynamic";

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const action = req.nextUrl.searchParams.get("action");

  if (!token || !action || !["approve", "reject"].includes(action)) {
    return NextResponse.json({ error: "Invalid token or action" }, { status: 400 });
  }

  const s = sb();

  // Look up token
  const { data: gate, error } = await s
    .from("gate_approval_tokens")
    .select("id, project_id, run_id, tenant_id, action, used, expires_at")
    .eq("token", token)
    .eq("action", action)
    .single();

  if (error || !gate) {
    return htmlResponse("Invalid Token", "This approval link is invalid or has already been used.", "error");
  }

  if (gate.used) {
    return htmlResponse("Already Used", "This approval link has already been used.", "warning");
  }

  if (new Date(gate.expires_at as string) < new Date()) {
    return htmlResponse("Expired", "This approval link has expired. Please approve from the Command Center.", "warning");
  }

  // Mark token as used
  await s.from("gate_approval_tokens").update({ used: true }).eq("id", gate.id);

  // Get project + active sprint status. Sprint owns the gate state
  // (waiting); project status is just running/idle.
  const { data: project } = await s.from("projects").select("name, status").eq("id", gate.project_id).single();
  const { data: gatedSprint } = await s.from("sprints")
    .select("id, status")
    .eq("project_id", gate.project_id)
    .eq("status", "waiting")
    .order("sprint_num", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (action === "approve") {
    // Check there's actually a sprint waiting on this gate
    if (!gatedSprint) {
      return htmlResponse("Not Waiting", `Project "${project?.name ?? "?"}" has no sprint waiting for approval (status: ${project?.status ?? "?"}).`, "warning");
    }

    // Approve: project goes back to running, sprint resumes.
    await s.from("projects").update({ status: "running" }).eq("id", gate.project_id);
    await s.from("sprints")
      .update({ status: "running" })
      .eq("id", gatedSprint.id);

    // Insert approval event
    if (gate.run_id) {
      await s.from("agent_events").insert({
        run_id: gate.run_id,
        event_type: "approved",
        payload: { source: "token", action: "approve" },
      });
      await s.from("agent_runs").update({ status: "done" }).eq("id", gate.run_id);
    }

    // Trigger continuation
    try {
      const continueRes = await fetch(`${getAppUrl(req)}/api/projects/${gate.project_id}/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: gate.tenant_id }),
      });
      if (!continueRes.ok) {
        const body = await continueRes.json().catch(() => ({})) as { error?: string };
        return htmlResponse("Approved — Resume Failed", `Gate approved but pipeline resume failed: ${body.error ?? "unknown"}. Try resuming from the Command Center.`, "warning");
      }
    } catch {
      return htmlResponse("Approved — Resume Failed", "Gate approved but could not contact the pipeline. Try resuming from the Command Center.", "warning");
    }

    return htmlResponse("Approved", `Sprint for "${project?.name ?? "?"}" has been approved and resumed.`, "success");

  } else {
    // Reject — sprint goes paused for operator review, project returns
    // to idle so the slot is freed for other work.
    await s.from("projects").update({ status: "idle" }).eq("id", gate.project_id);
    await s.from("sprints")
      .update({ status: "paused" })
      .eq("project_id", gate.project_id)
      .in("status", ["waiting"]);

    if (gate.run_id) {
      await s.from("agent_events").insert({
        run_id: gate.run_id,
        event_type: "rejected",
        payload: { source: "token", action: "reject" },
      });
    }

    return htmlResponse("Rejected", `Sprint for "${project?.name ?? "?"}" has been rejected and paused.`, "info");
  }
}

function getAppUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

function htmlResponse(title: string, message: string, type: "success" | "error" | "warning" | "info") {
  const colors = { success: "#1cbf6b", error: "#e44b5f", warning: "#f59f00", info: "#1463ff" };
  const icons = { success: "✅", error: "❌", warning: "⚠️", info: "ℹ️" };
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — ${brand.name}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1e2e;color:#cdd6f4;font-family:system-ui,sans-serif}
.card{background:#181825;border:1px solid #313244;border-radius:16px;padding:40px;max-width:400px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.4)}
.icon{font-size:48px;margin-bottom:16px}h1{font-size:22px;margin:0 0 8px}p{color:#a6adc8;font-size:14px;line-height:1.6;margin:0 0 20px}
a{color:${colors[type]};text-decoration:none;font-size:13px}</style></head>
<body><div class="card"><div class="icon">${icons[type]}</div><h1 style="color:${colors[type]}">${title}</h1><p>${message}</p><a href="/">Open Command Center</a></div></body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html" } });
}
