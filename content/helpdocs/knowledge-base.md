---
title: Knowledge Base (CAG & RAG)
icon: 🧠
category: User Guides
order: 15
color: v
parent: integrations
---

# Knowledge Base — CAG & RAG for Agents

{{brand.name}} provides two complementary approaches to augment AI agents with relevant knowledge: **Context Augmented Generation (CAG)** and **Retrieval Augmented Generation (RAG)**.

## What is CAG?

**Context Augmented Generation** loads relevant context **directly into the agent's prompt**. The agent receives all necessary information upfront — no search required.

### CAG in {{brand.name}}

CAG is the foundation of how agents receive information today:

| Context Layer | Source | When Loaded |
|---------------|--------|-------------|
| **Briefing** | Project briefing + sprint briefing | Sprint start |
| **Agent Contract** | SIPOC specification (role, inputs, outputs) | Agent initialization |
| **Guidelines** | Project-level + agent-level guidelines | Sprint start |
| **DNA** | Factory culture, standards, tech stack | Sprint start (if enabled) |
| **Sprint Instructions** | Per-step instructions from the user | Sprint start |
| **Gate Feedback** | Human approver comments from gates | After gate approval |
| **Cross-Sprint Context** | Artifacts from previous sprints | Sprint start (if selected) |
| **Phase Peer Outputs** | References to other agents' outputs in the same phase | Before each agent |

All of this is assembled by the pipeline orchestrator and delivered to the agent as structured markdown.

### When CAG is enough

CAG works well when:

- The project context fits within the model's context window
- All relevant information is already in the system (briefings, artifacts, guidelines)
- You don't need external documentation or knowledge sources

## What is RAG?

**Retrieval Augmented Generation** adds a **search step** — the agent queries a knowledge base for relevant information and retrieves only what's needed. This is powered by vector embeddings and semantic similarity search.

### RAG in {{brand.name}}

RAG extends CAG with external knowledge sources. Instead of injecting everything into the prompt, agents can **search on demand** for specific information.

```
Agent receives task
  ↓
Agent needs info about "MQTT authentication"
  ↓
Calls search_knowledge("MQTT authentication patterns")
  ↓
Knowledge Base returns top 5 relevant chunks
  ↓
Agent uses retrieved knowledge to inform its work
```

## Knowledge Base Architecture

### Knowledge Instances

A **Knowledge Instance** is a reusable collection of indexed knowledge. Instances are created at the tenant level and can be linked to multiple projects.

**Example instances:**
- "API Documentation v2" — indexed from company docs URL
- "IoT Standards & Protocols" — indexed from a GitHub repo
- "Engineering Team Context" — indexed from Slack channels
- "Product Requirements" — uploaded PDF documents

### Sources

Each instance contains one or more **sources** — the origin of the knowledge:

| Source Type | What it indexes | Example |
|-------------|----------------|---------|
| **URL** | Web pages, API docs, wikis | `https://docs.example.com/api` |
| **Document** | Uploaded files (PDF, markdown, text) | `product-spec-v2.pdf` |
| **GitHub** | Code and documentation from repositories | `owner/repo` (docs/, README) |
| **Slack** | Messages from team channels | `#engineering-backend` |

### Chunks & Embeddings

Sources are processed through an indexing pipeline:

1. **Fetch** — download content from the source
2. **Chunk** — split into ~500 token segments (by headings, paragraphs, or functions)
3. **Embed** — generate vector embeddings using an AI model
4. **Store** — save chunks with embeddings in pgvector (Supabase)

Each chunk retains metadata about its origin (URL, page number, file path, line numbers) for **attribution**.

## How Knowledge Reaches Agents

The delivery mechanism depends on how the agent runs:

### CLI Agents with MCP (Claude Code, Goose)

Agents have a `search_knowledge` tool available in their MCP toolkit. They call it on demand when they need information.

```
Agent: I need to understand the authentication flow
  → calls search_knowledge("authentication flow")
  → receives 5 relevant chunks with source attribution
  → uses knowledge to implement
```

**Advantages:** Efficient — only retrieves what's needed. Agent decides relevance.

### CLI Agents without MCP (Aider, Codex)

Knowledge is **pre-loaded** into a `.tp/KNOWLEDGE.md` file in the workspace before the CLI starts. The briefing references this file.

```
Before CLI starts:
  1. Search knowledge base using briefing as query
  2. Write top 10 relevant chunks to .tp/KNOWLEDGE.md
  3. Reference in briefing: "Consult .tp/KNOWLEDGE.md"
```

**Advantages:** Works with any CLI. No tool support needed.

### API Agents (direct LLM calls)

Knowledge is available either as a **function tool** (if the model supports tool use) or **pre-injected** into the system prompt.

| Model Capability | Delivery |
|-------------------|----------|
| Supports tools | `search_knowledge` as function tool — LLM calls on demand |
| No tool support | Pre-injected in system prompt as "Relevant Knowledge" section |

## How Indexation Works

Indexation is the process that transforms raw content into semantically searchable chunks. It runs as a **Trigger.dev task** — either on your local machine (via `trigger dev`) or on Trigger.dev cloud workers.

### Pipeline

```
Source (URL, GitHub repo, document, Slack)
  ↓ fetch
Raw content (HTML, markdown, code, messages)
  ↓ chunk
Segments of ~500 tokens each
  ↓ embed (OpenAI API)
1536-dimension vectors per chunk
  ↓ store
pgvector in Supabase (knowledge_chunks table)
```

### Step by Step

1. **Fetch** — Download content from the source. URLs are fetched and HTML is stripped. GitHub repos are cloned via API. Documents are read from storage. Slack messages are pulled from the conversations API.

2. **Chunk** — Split content into segments of approximately 500 tokens. Markdown is split by headings (h1/h2/h3). Code is split by functions and classes. Long sections are further split by paragraphs. Minimum chunk size: 50 tokens. Maximum: 1000 tokens.

3. **Embed** — Each chunk is sent to the OpenAI Embeddings API (`text-embedding-3-small`) to generate a 1536-dimensional vector. Chunks are batched (up to 100 per API call) for efficiency.

4. **Store** — Chunks with their embeddings are stored in the `knowledge_chunks` table in Supabase (PostgreSQL with pgvector extension). An IVFFlat index enables fast approximate nearest-neighbor search.

### What Each Chunk Contains

| Field | Description |
|-------|-------------|
| `content` | The text of the segment (~500 tokens) |
| `embedding` | 1536-float vector for semantic similarity search |
| `metadata` | Source attribution: title, URL, file path, page number, section heading |
| `token_count` | Actual token count of the chunk |

### Resource Consumption

| Resource | Cost | Notes |
|----------|------|-------|
| **OpenAI API** (embeddings) | ~$0.02 per 1M tokens | A 10,000-word document costs ~$0.001 |
| **Supabase storage** | Minimal | Chunks stored as PostgreSQL rows |
| **CPU / Time** | Seconds | Fetch + parse + chunk: 1-5s. Embedding API: 1-5s per batch |
| **Trigger.dev** | 1 task run | Counts toward your Trigger.dev plan |

### Requirements

- **`OPENAI_API_KEY`** must be configured in Providers — required for embedding generation
- **Trigger.dev** must be configured and either:
  - `trigger dev` running locally (for Local indexation), or
  - Workers deployed to cloud (for Cloud indexation)

### Where Indexation Runs

You can choose where indexation runs when adding a source:

| Mode | Where | When to use |
|------|-------|-------------|
| **Cloud** (default) | Trigger.dev cloud workers | Workers are deployed; no local setup needed |
| **Local** | Your machine via `trigger dev` | For development; `trigger dev` must be running |

### Re-indexation

Sources can be re-indexed at any time:
- **Manual** — Click "Re-index" on a source in the Knowledge Base UI
- **On update** — When the source content changes (manual trigger)
- Re-indexation deletes all existing chunks for that source and creates new ones (atomic replacement)

### How Agents Use Indexed Knowledge

Once indexed, the chunks are available to agents during sprints — **no re-processing needed**. Agents perform fast SQL queries against pgvector:

**MCP-capable CLIs (Claude Code, Goose):**
```
Agent calls search_knowledge("MQTT authentication")
  → MCP server generates embedding for the query (OpenAI, ~100ms)
  → SQL: SELECT ... FROM knowledge_chunks ORDER BY embedding <=> query LIMIT 5
  → Returns top 5 most similar chunks with source attribution
  → Agent uses the content to inform its work
```

**Non-MCP CLIs (Aider, Codex):**
```
Before CLI starts:
  → cli-executor searches chunks relevant to the briefing
  → Writes .tp/KNOWLEDGE.md with pre-loaded chunks
  → CLI reads as static context
```

The key insight: **indexation is a one-time cost per source**. After that, agents perform cheap, fast searches during sprints.

---

## Managing Knowledge

### Creating an Instance

1. Go to **Knowledge Base** in the sidebar (under Integrations)
2. Click **Create Instance**
3. Name it descriptively (e.g., "Product API Docs")
4. Expand the instance to add sources

### Adding Sources

Click **Add Source** inside an expanded instance:

1. Select the source type (URL, Document, GitHub, Slack)
2. Fill in the configuration:
   - **URL**: paste the page URL
   - **GitHub**: enter `owner/repo`, branch, and optionally filter paths (e.g., `docs/, README.md`)
   - **Slack**: enter the Channel ID and Bot Token (`xoxb-...`), and how many days back to index
3. Click **Analyze** to preview estimated chunks, tokens, and embedding cost
4. Select **Cloud** or **Local** for where the indexation task runs
5. Click **Add & Index** to save and start indexation

### Source Management

Each source card shows status, chunk count, tokens, and last indexed date. Available actions:

| Icon | Action | Description |
|------|--------|-------------|
| 📚 Layers | View chunks | Browse all indexed chunks with expandable content and metadata |
| ⚙ Settings | Edit source | Edit name and view/update source configuration |
| 🔄 Refresh | Re-index | Re-fetch, re-chunk, re-embed the source (respects Cloud/Local toggle) |
| ⏻ Toggle | Enable/Disable | Disabled sources are excluded from agent searches but chunks are retained |
| 🧹 Eraser | Clear chunks | Delete all chunks but keep the source configuration |
| 🗑 Trash | Remove | Delete the source and all its chunks |
| 🔗 External | View run | Open the indexation task run in Trigger.dev (visible during indexing or on error) |
| ✕ Cancel | Cancel indexation | Reset a stuck indexation (visible during indexing) |

### Indexation Limits

Configure limits under **Indexation Limits** (collapsible section at the top of the Knowledge Base page):

- Max source content (MB)
- Max chunks per source
- Max tokens per source (K)
- Max chunks per instance
- Max GitHub files
- Max Slack messages

These protect your Supabase storage and OpenAI embedding costs. The **Analyze** button checks against these limits before indexing.

### Linking to Projects

1. Open **Project Settings** → **Knowledge Base** section
2. Toggle instances on/off for the project
3. Linked instances are available to all agents in the project's sprints

### Per-Sprint Overrides

When starting a sprint, you can temporarily enable/disable knowledge instances for that specific run without changing project settings.

### Inspecting Chunks

Click the **Layers** icon on a source to browse its chunks:

- Each chunk is expandable — click to see the full content
- Metadata shows file path, section heading, and source type
- Token count per chunk and total
- Estimated embedding cost
- Disabled chunks (excluded from searches) shown with reduced opacity

### Search Preview

Use the **Search Preview** inside an expanded instance to test queries:

1. Type a natural language query
2. Click **Search**
3. View results with content preview, source name, and similarity score

This helps verify that indexation produced useful, searchable chunks.

## CAG vs RAG — When to Use What

| Scenario | Approach | Why |
|----------|----------|-----|
| Project briefing and requirements | **CAG** (automatic) | Already in the system, always relevant |
| External API documentation | **RAG** (Knowledge Base) | Too large for prompt, search for specific sections |
| Team coding standards | **CAG** (guidelines) | Short, always applicable |
| Large technical specifications | **RAG** (document upload) | Chunked and searched by relevance |
| Previous sprint learnings | **CAG** (cross-sprint context) | Explicit selection of past artifacts |
| GitHub repo code/docs | **RAG** (GitHub source) | Searchable, stays updated |
| Team discussions and decisions | **RAG** (Slack source) | Searchable, recent context |
| Factory DNA and culture | **CAG** (DNA toggle) | Global, always applicable |

## Best Practices

### Keep instances focused

Create separate instances for distinct knowledge domains:
- ✅ "Payment API Documentation" — focused, relevant
- ❌ "All Company Documents" — too broad, low relevance scores

### Set appropriate refresh intervals

- **URLs** (documentation): 24-48 hours
- **Slack channels**: 6-12 hours (conversations change fast)
- **GitHub repos**: 24 hours or on-demand
- **Uploaded documents**: manual re-index when updated

### Review agent access logs

Check which queries return low similarity scores — this indicates knowledge gaps. Consider adding new sources to cover those topics.

### Mind the context window

- RAG (on-demand) is more efficient than CAG (pre-loaded)
- For large knowledge bases, prefer MCP-capable CLIs (Claude Code) for lazy retrieval
- Pre-injected knowledge (`.tp/KNOWLEDGE.md`) is limited to top-K chunks to avoid overwhelming the context

## Security & Safety

- **Tenant isolation**: Knowledge instances are strictly scoped to your tenant
- **Project scoping**: Agents only access instances linked to their project
- **PII detection**: Chunks are scanned for personal data during indexing
- **Secrets detection**: API keys and tokens are detected and blocked/redacted
- **Prompt injection prevention**: Retrieved knowledge is presented as reference material — agents are instructed not to follow instructions found in chunks
- **Access audit**: Complete trail of all knowledge queries and retrievals
