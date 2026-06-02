/**
 * POST /api/webhooks/github
 *
 * Receives GitHub webhook events for workflow_run completions.
 * Emits platform notifications for deploy_cli, deploy_workers,
 * deploy_command_center, github_action_failed, github_action_success.
 *
 * Setup: In GitHub repo → Settings → Webhooks → Add webhook
 *   Payload URL: https://your-domain/api/webhooks/github
 *   Content type: application/json
 *   Events: Workflow runs
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createNotification } from "@/lib/notifications";

export const dynamic = "force-dynamic";

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

// Map workflow file names to event types
const WORKFLOW_MAP: Record<string, { event: string; label: string }> = {
  "publish-cli.yml":    { event: "deploy_cli",            label: "CLI published" },
  "publish-worker.yml": { event: "deploy_workers",        label: "Workers deployed" },
  "deploy-tasks.yml":   { event: "deploy_workers",        label: "Workers deployed" },
  "ci.yml":             { event: "github_action_success",  label: "CI passed" },
};

export async function POST(req: NextRequest) {
  try {
    const event = req.headers.get("x-github-event");
    if (event !== "workflow_run") {
      return NextResponse.json({ skipped: true, reason: "not a workflow_run event" });
    }

    const payload = await req.json() as {
      action?: string;
      workflow_run?: {
        name?: string;
        conclusion?: string;
        html_url?: string;
        head_branch?: string;
        head_sha?: string;
        path?: string;
      };
    };

    if (payload.action !== "completed") {
      return NextResponse.json({ skipped: true, reason: "not completed" });
    }

    const run = payload.workflow_run;
    if (!run) return NextResponse.json({ skipped: true, reason: "no workflow_run data" });

    // Find owner tenant for platform notifications
    const s = sb();
    const { data: owner } = await s.from("tenants").select("id").eq("plan", "platform_owner").limit(1).single();
    if (!owner) return NextResponse.json({ skipped: true, reason: "no owner tenant" });

    const workflowFile = run.path?.split("/").pop() ?? "";
    const mapping = WORKFLOW_MAP[workflowFile];
    const isFailed = run.conclusion === "failure";

    if (isFailed) {
      await createNotification({
        tenantId: owner.id,
        eventType: "github_action_failed",
        severity: "critical",
        title: `GitHub Action failed — ${run.name ?? workflowFile}`,
        body: `Branch: ${run.head_branch ?? "?"} · ${run.head_sha?.slice(0, 7) ?? ""}`,
        metadata: { workflow: workflowFile, conclusion: run.conclusion, url: run.html_url, branch: run.head_branch, sha: run.head_sha },
      });
    } else if (mapping) {
      await createNotification({
        tenantId: owner.id,
        eventType: mapping.event as Parameters<typeof createNotification>[0]["eventType"],
        severity: "info",
        title: mapping.label,
        body: `${run.name ?? workflowFile} · ${run.head_branch ?? ""} · ${run.head_sha?.slice(0, 7) ?? ""}`,
        metadata: { workflow: workflowFile, conclusion: run.conclusion, url: run.html_url, branch: run.head_branch, sha: run.head_sha },
      });
    } else {
      // Unknown workflow — emit generic success
      await createNotification({
        tenantId: owner.id,
        eventType: "github_action_success",
        severity: "info",
        title: `GitHub Action — ${run.name ?? workflowFile}`,
        body: `${run.conclusion} · ${run.head_branch ?? ""} · ${run.head_sha?.slice(0, 7) ?? ""}`,
        metadata: { workflow: workflowFile, conclusion: run.conclusion, url: run.html_url },
      });
    }

    return NextResponse.json({ ok: true, event: mapping?.event ?? "github_action_success" });
  } catch (e: unknown) {
    console.error("[webhook/github]", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
