import { z } from "zod";
import { env } from "../env";
import { err, ok, type ProviderError, type Result } from "../types";
import { classifyHttp } from "../providers/provider";

/**
 * Slice 6: embeddings, plain fetch, same posture as the chat adapters — no
 * SDK, response validated through zod. One vendor for now because only one
 * of the configured providers offers an embeddings API; swapping vendors
 * means changing this file's URL, model, and schema, and nothing else. That
 * is the seam.
 */
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const EMBEDDING_MODEL = "text-embedding-3-small";

const responseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })),
});

export type EmbedResult = Result<number[][], ProviderError>;

/** Embed a batch of texts. Order of the result matches the input order. */
export async function embed(texts: string[]): Promise<EmbedResult> {
  if (env.OPENAI_API_KEY === undefined) {
    return err({
      kind: "bad_request",
      message: "Embeddings need OPENAI_API_KEY; RAG is unavailable without it",
    });
  }

  let res: Response;
  try {
    res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    });
  } catch (cause) {
    return err({ kind: "network", message: String(cause) });
  }

  const raw = await res.text();
  if (!res.ok) {
    return classifyHttp(res.status, raw.slice(0, 500));
  }

  const parsed = responseSchema.safeParse(safeJson(raw));
  if (!parsed.success || parsed.data.data.length !== texts.length) {
    return err({ kind: "upstream", status: res.status, message: "Unexpected embeddings response" });
  }

  return ok(parsed.data.data.map((d) => d.embedding));
}

/**
 * Cosine similarity: dot(a,b) / (|a| * |b|). Score of 1 means same direction,
 * 0 means unrelated. ArrayLike lets this accept both a number[] (fresh query
 * embedding) and a Float32Array (decoded from the SQLite BLOB) without a
 * conversion copy.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
