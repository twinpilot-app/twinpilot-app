/**
 * Tool catalog — metadata source of truth for built-in native tools.
 *
 * Each entry mirrors a ToolDefinition in
 * services/control-plane/lib/tool-registry.ts ALL_TOOLS.
 *
 * The `tools` table in the DB is populated from this catalog via
 * POST /api/admin/tools/sync (admin-only). Adding a tool means:
 *   1. Add the ToolDefinition in control-plane/lib/tool-registry.ts (runtime).
 *   2. Add the metadata entry here (UI catalog).
 *   3. Deploy both; admin hits the sync endpoint.
 *
 * Tools in the DB whose slug is not in this catalog are marked `deprecated`
 * on sync (kept for historical/audit, hidden from the Admin UI).
 */

export type ToolCatalogEntry = {
  slug: string;
  name: string;
  description: string;
  type: "native" | "mcp" | "rest";
  status: "available" | "planned" | "deprecated";
  origin: "built-in" | "user";
};

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    slug: "escalate_to_human",
    name: "Escalate to Human",
    description: "Pauses execution and sends a human-readable message to the operator for review. Use when blocked, uncertain, or when the task requires human judgment.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "read_artifact",
    name: "Read Artifact",
    description: "Reads an artifact file from the project's unified artifact tree. Returns the full file content.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "list_artifacts",
    name: "List Artifacts",
    description: "Lists all files in the project's unified artifact tree, including sizes and last-modified timestamps.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "write_sprint_workspace",
    name: "Write Sprint Workspace",
    description: "Write source code, tests, configs, scripts, or infrastructure files to _workspace/{agent}/ in the sprint staging area.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "write_sprint_docs",
    name: "Write Sprint Docs",
    description: "Write documentation, specifications, analyses, or reports to _docs/{agent}/ in the sprint staging area.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "write_sprint_audit",
    name: "Write Sprint Audit",
    description: "Write internal agent summaries, logs, or diagnostic data to _audit/{agent}/ in the sprint staging area.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "write_cli_instructions",
    name: "Write CLI Instructions",
    description: "Write CLI tool configuration files at the project root (CLAUDE.md, .claude/agents/, .gitignore).",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "read_project_file",
    name: "Read Project File",
    description: "Read a file from the project's artifact tree. Used to check code or specs previously written by other agents.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "list_project_files",
    name: "List Project Files",
    description: "Lists files in the project's artifact tree. Used to understand the current project structure.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "github_push_sprint",
    name: "GitHub Push Sprint",
    description: "Commit all generated code/spec/docs files from the project staging tree to GitHub and open a pull request. Used exclusively by the Sprint Push agent.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "mark_sprint_saved",
    name: "Mark Sprint Saved",
    description: "Mark the current sprint as persisted/saved. Call this after successfully committing or uploading all sprint artifacts to an external destination.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "add_backlog_items",
    name: "Add Backlog Items",
    description: "Bulk-create kanban items emitted by an agent during a discovery sprint. Each item lands in todo with source=agent, linked back to the originating sprint + agent slug for audit.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "propose_pipeline",
    name: "Propose Pipeline",
    description: "Compose the next execution sprint's pipeline by picking which agents run, in what order, with what model and reasoning effort. Used by the pipeline-composer agent during a discovery sprint. The proposal is persisted on the discovery sprint's composed_pipeline; the next execution sprint dispatcher consumes it when auto-compose is on.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "read_backlog_items",
    name: "Read Backlog Items",
    description: "List the project's kanban items (filterable by status). Used by product-owner to inspect existing state before adding/updating, avoiding duplicates and respecting prior priority.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "update_backlog_items",
    name: "Update Backlog Items",
    description: "Edit existing kanban items: title, description, status, order_index, tags. Used by product-owner to refine or re-prioritise without creating duplicates.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "read_sprint_outcomes",
    name: "Read Sprint Outcomes",
    description: "List the project's recent sprint outcomes (verdict, intent, agents that ran). Used by product-owner to learn from what just happened before refining the kanban.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "consult_agent",
    name: "Consult Agent",
    description: "Ask another agent in this factory a focused question and get a text answer. The consulted agent runs as a one-shot LLM call with its own persona — no tools, no file access. Records as a sub-run with run_type='consultation'; cost rolls up via the dashboard's per-agent breakdown.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "record_review_marker",
    name: "Record Review Marker",
    description: "Mandatory signal for review-style agents (product-owner) that the review protocol completed. The worker verdict logic queries project_review_markers; without a marker the sprint reads as no-output. Action enum: no_change | added | refined | mixed | failed.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "read_project_briefing",
    name: "Read Project Briefing",
    description: "Return the operator-authored project context (intake_brief + prd_md). Product-owner needs this to derive net-new backlog items from the project's source-of-truth — without it, an empty backlog stays empty.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
  {
    slug: "record_decision",
    name: "Record Decision",
    description: "Propose a project memory entry (decision / convention / gotcha / dependency). Inserts as proposed; the operator approves or rejects from the dashboard. Approved entries land in the next sprint's .tp/MEMORY.md so future agents start with accumulated context.",
    type: "native",
    status: "available",
    origin: "built-in",
  },
];
