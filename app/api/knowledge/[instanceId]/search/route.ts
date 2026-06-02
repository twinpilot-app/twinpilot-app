/**
 * POST /api/knowledge/[instanceId]/search — semantic search preview
 */
import { NextRequest, NextResponse } from "next/server";
import {
  AuthError, ForbiddenError, NotFoundError, ValidationError,
  getOperatorUser, errorResponse, parseBody,
} from "@/lib/api-helpers";
import { KnowledgeSearchSchema } from "@/lib/api-schemas";
import type { SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

async function assertAccess(
  sb: SupabaseClient,
  userId: string,
  instanceId: string,
) {
  const { data: instance } = await sb
    .from("knowledge_instances")
    .select("id, tenant_id, embedding_model")
    .eq("id", instanceId)
    .maybeSingle();
  if (!instance) throw new NotFoundError("Instance not found");

  const { data: member } = await sb
    .from("tenant_members").select("role")
    .eq("tenant_id", instance.tenant_id).eq("user_id", userId).maybeSingle();
  if (!member) throw new ForbiddenError("Caller is not a member of this instance's tenant");

  return instance;
}

/** Resolve OpenAI API key from tenant integrations or env. */
async function getOpenAIKey(
  sb: SupabaseClient,
  tenantId: string,
): Promise<string | null> {
  const { data: row } = await sb
    .from("tenant_integrations")
    .select("secret_value")
    .eq("tenant_id", tenantId)
    .eq("service_id", "openai")
    .eq("var_name", "OPENAI_API_KEY")
    .maybeSingle();
  if (row?.secret_value) return row.secret_value as string;
  return process.env.OPENAI_API_KEY ?? null;
}

/** Generate embedding via OpenAI API. */
async function generateEmbedding(
  text: string,
  model: string,
  apiKey: string,
): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "unknown");
    throw new Error(`OpenAI embeddings failed: ${detail}`);
  }

  const json = await res.json() as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ instanceId: string }> },
) {
  try {
    const body = await parseBody(req, KnowledgeSearchSchema);
    const { user, sb } = await getOperatorUser(req);
    const { instanceId } = await params;
    const instance = await assertAccess(sb, user.id, instanceId);

    const openaiKey = await getOpenAIKey(sb, instance.tenant_id as string);
    if (!openaiKey) throw new ValidationError("OpenAI API key not configured", []);

    const limit = Math.min(body.limit ?? 5, 20);
    const embeddingModel = (instance.embedding_model as string) || "text-embedding-3-small";

    // Generate query embedding
    const embedding = await generateEmbedding(body.query.trim(), embeddingModel, openaiKey);

    // Semantic search via pgvector cosine distance
    const { data: chunks, error } = await sb.rpc("match_knowledge_chunks", {
      p_instance_id: instanceId,
      p_embedding: JSON.stringify(embedding),
      p_limit: limit,
      p_threshold: 0.5,
    });

    // Fallback: if the RPC doesn't exist, do a raw query via the REST approach
    if (error) {
      // Direct query fallback — fetch all chunks and do similarity in-app
      // This is less efficient but works without a custom function
      const { data: rawChunks, error: rawErr } = await sb
        .from("knowledge_chunks")
        .select("id, content, metadata, source_id")
        .eq("instance_id", instanceId)
        .eq("excluded", false)
        .limit(200);

      if (rawErr) throw new Error(rawErr.message);

      // Get source names
      const sourceIds = [...new Set((rawChunks ?? []).map((c) => c.source_id as string))];
      const { data: sources } = await sb
        .from("knowledge_sources")
        .select("id, name")
        .in("id", sourceIds);
      const sourceMap = new Map((sources ?? []).map((s) => [s.id, s.name]));

      return NextResponse.json({
        results: (rawChunks ?? []).slice(0, limit).map((c) => ({
          content: c.content,
          sourceName: sourceMap.get(c.source_id as string) ?? "Unknown",
          similarity: null, // Cannot compute without vector comparison in-app
          metadata: c.metadata,
        })),
        warning: "Falling back to non-vector search. RPC match_knowledge_chunks not found.",
      });
    }

    // Enrich with source names
    const sourceIds = [...new Set((chunks ?? []).map((c: { source_id: string }) => c.source_id))];
    const { data: sources } = await sb
      .from("knowledge_sources")
      .select("id, name")
      .in("id", sourceIds.length > 0 ? sourceIds : ["__none__"]);
    const sourceMap = new Map((sources ?? []).map((s) => [s.id, s.name]));

    return NextResponse.json({
      results: (chunks ?? []).map((c: { content: string; source_id: string; similarity: number; metadata: unknown }) => ({
        content: c.content,
        sourceName: sourceMap.get(c.source_id) ?? "Unknown",
        similarity: c.similarity,
        metadata: c.metadata,
      })),
    });
  } catch (e) {
    if (e instanceof AuthError)       return errorResponse(e);
    if (e instanceof ForbiddenError)  return errorResponse(e);
    if (e instanceof NotFoundError)   return errorResponse(e);
    if (e instanceof ValidationError) return errorResponse(e);
    return errorResponse(e);
  }
}
