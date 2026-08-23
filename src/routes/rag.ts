import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bearerToken, requireApiKey } from "../auth";
import { allChunks, logRequest, spendSince } from "../db";
import { guardInput, guardOutput } from "../guardrails";
import { budgetEurFor, computeCostEur, monthStartIso } from "../pricing";
import { defaultProvider } from "../providers/registry";
import { cosineSimilarity, embed } from "../rag/embedder";
import { statusFor } from "./chat";

/**
 * Slice 6: POST /v1/rag/query.
 *
 * Retrieval is brute-force cosine over every stored chunk. At a few hundred
 * chunks that is milliseconds and needs no index; the response exposes the
 * similarity scores and source files so retrieval quality is inspectable,
 * not a black box. The same gateway policies apply here as on /v1/chat:
 * budget first, guardrails on the query and the answer, one log row always.
 */
const bodySchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(10).default(4),
});

export function registerRagRoute(app: FastifyInstance): void {
  app.post("/v1/rag/query", { preHandler: requireApiKey }, async (request, reply) => {
    const apiKey = bearerToken(request) ?? "unknown";
    const startedAt = Date.now();

    // One local helper so every early exit stays a one-liner and the
    // "every outcome writes exactly one log row" property is easy to keep.
    const logOutcome = (entry: {
      status: number;
      provider?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      costEur?: number | null;
      guardrailVerdict?: string;
      blockedReason?: string;
    }): void => {
      logRequest({
        apiKey,
        routeRule: "rag-query",
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        tier: null,
        inputTokens: entry.inputTokens ?? null,
        outputTokens: entry.outputTokens ?? null,
        costEur: entry.costEur ?? null,
        latencyMs: Date.now() - startedAt,
        guardrailVerdict: entry.guardrailVerdict ?? null,
        blockedReason: entry.blockedReason ?? null,
        // RAG answers are not cached in v0.
        cacheHit: null,
        status: entry.status,
      });
    };

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      logOutcome({ status: 400 });
      return reply.code(400).send({ error: { kind: "bad_request", issues: parsed.error.issues } });
    }
    const body = parsed.data;

    // Same budget gate as /v1/chat: a RAG query spends real money too.
    const budgetEur = budgetEurFor(apiKey);
    const spentEur = spendSince(apiKey, monthStartIso());
    if (spentEur >= budgetEur) {
      logOutcome({ status: 429 });
      return reply.code(429).send({
        error: {
          kind: "over_budget",
          message: "Monthly budget for this API key is exhausted",
          budgetEur,
          spentEur: round6(spentEur),
          remainingEur: round6(Math.max(0, budgetEur - spentEur)),
        },
      });
    }

    // Guardrails on the query, exactly as on chat input.
    const guard = guardInput([{ role: "user", content: body.query }], undefined);
    if (!guard.allowed) {
      logOutcome({
        status: 403,
        guardrailVerdict: `block:${guard.ruleId}`,
        blockedReason: guard.reason,
      });
      return reply.code(403).send({
        error: { kind: "blocked", ruleId: guard.ruleId, reason: guard.reason },
      });
    }
    const query = guard.messages[0]?.content ?? body.query;

    const chunks = allChunks();
    if (chunks.length === 0) {
      logOutcome({ status: 400 });
      return reply.code(400).send({
        error: { kind: "bad_request", message: "No chunks ingested. Run: npm run ingest" },
      });
    }

    const embedded = await embed([query]);
    if (!embedded.ok) {
      const status = statusFor(embedded.error);
      logOutcome({ status });
      return reply.code(status).send({ error: embedded.error });
    }
    const queryVector = embedded.value[0];
    if (queryVector === undefined) {
      logOutcome({ status: 502 });
      return reply.code(502).send({
        error: { kind: "upstream", status: 502, message: "Empty embedding response" },
      });
    }

    // Brute force: score every chunk, sort, keep the top K.
    const scored = chunks
      .map((chunk) => ({
        source: chunk.source,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        score: round4(cosineSimilarity(queryVector, chunk.embedding)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, body.topK);

    const context = scored
      .map((c) => `[${c.source} #${c.chunkIndex}]\n${c.content}`)
      .join("\n\n---\n\n");

    // Answering is a plain completion on the cheap tier: retrieval already
    // narrowed the problem, the model only has to read a page of context.
    const provider = defaultProvider();
    const model = provider.modelFor("cheap");
    const result = await provider.complete(model, {
      messages: [{ role: "user", content: query }],
      system:
        "Answer using ONLY the provided context. If the context does not " +
        "contain the answer, say so plainly. Cite sources as [filename].\n\n" +
        `Context:\n${context}`,
      maxTokens: 1024,
      temperature: 0.2,
    });

    if (!result.ok) {
      const status = statusFor(result.error);
      logOutcome({ status, provider: provider.name, model });
      return reply.code(status).send({ error: result.error });
    }
    const { value } = result;

    const outGuard = guardOutput(value.text);
    const answer = outGuard.allowed ? outGuard.text : "";
    const redactedBy = outGuard.allowed
      ? [...guard.redactedBy, ...outGuard.redactedBy]
      : guard.redactedBy;
    const costEur = computeCostEur(value.model, value.usage);

    if (!outGuard.allowed) {
      logOutcome({
        status: 403,
        provider: value.provider,
        model: value.model,
        inputTokens: value.usage.inputTokens,
        outputTokens: value.usage.outputTokens,
        costEur,
        guardrailVerdict: `block:${outGuard.ruleId}`,
        blockedReason: outGuard.reason,
      });
      return reply.code(403).send({
        error: { kind: "blocked", ruleId: outGuard.ruleId, reason: outGuard.reason },
      });
    }

    logOutcome({
      status: 200,
      provider: value.provider,
      model: value.model,
      inputTokens: value.usage.inputTokens,
      outputTokens: value.usage.outputTokens,
      costEur,
      guardrailVerdict: redactedBy.length === 0 ? "allow" : `redact:${redactedBy.join(",")}`,
    });

    return reply.send({
      answer,
      // The demoable part: retrieval is inspectable, score by score.
      chunks: scored,
      usage: value.usage,
      costEur: costEur === null ? null : round6(costEur),
      model: value.model,
      latencyMs: Date.now() - startedAt,
    });
  });
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

function round6(n: number): number {
  return Number(n.toFixed(6));
}
