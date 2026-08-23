import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bearerToken, requireApiKey } from "../auth";
import { logRequest, spendSince } from "../db";
import { guardInput, guardOutput } from "../guardrails";
import { budgetEurFor, computeCostEur, monthStartIso } from "../pricing";
import { getProvider } from "../providers/registry";
import { estimateInputTokens, route } from "../router";
import type { ProviderError } from "../types";

/**
 * Request contract. Written once, as a zod schema, and the TypeScript type is
 * derived from it. Validation and types cannot drift apart.
 */
const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
  system: z.string().optional(),
  tier: z.enum(["cheap", "strong"]).default("cheap"),
  // Optional hint for the router. Not passed to the provider.
  task: z.enum(["code", "analysis"]).optional(),
  provider: z.enum(["anthropic", "openai"]).optional(),
  maxTokens: z.number().int().min(1).max(4096).default(1024),
  temperature: z.number().min(0).max(2).default(0.7),
});

export type ChatBody = z.infer<typeof bodySchema>;

export function registerChatRoute(app: FastifyInstance): void {
  app.post("/v1/chat", { preHandler: requireApiKey }, async (request, reply) => {
    // Auth already passed, so the token is our key; fall back defensively.
    const apiKey = bearerToken(request) ?? "unknown";
    // Slice 3: every request that reaches this handler ends in exactly one
    // logRequest call, whatever the outcome. Rejections log nulls for the
    // fields that never happened (no route, no model, no tokens).
    const startedAt = Date.now();

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      logRequest({
        apiKey,
        routeRule: null,
        provider: null,
        model: null,
        tier: null,
        inputTokens: null,
        outputTokens: null,
        costEur: null,
        latencyMs: Date.now() - startedAt,
        guardrailVerdict: null,
        blockedReason: null,
        status: 400,
      });
      return reply.code(400).send({
        error: { kind: "bad_request", issues: parsed.error.issues },
      });
    }
    const body = parsed.data;

    const provider = getProvider(body.provider);
    if (provider === undefined) {
      logRequest({
        apiKey,
        routeRule: null,
        provider: body.provider ?? null,
        model: null,
        tier: null,
        inputTokens: null,
        outputTokens: null,
        costEur: null,
        latencyMs: Date.now() - startedAt,
        guardrailVerdict: null,
        blockedReason: null,
        status: 400,
      });
      return reply.code(400).send({
        error: { kind: "bad_request", message: `Provider not configured: ${body.provider}` },
      });
    }

    // Slice 5: budget enforcement. The month-to-date spend for this key is
    // summed from the request log — the log IS the billing record, there is
    // no second ledger to drift from it. Over budget refuses before any
    // guardrail, routing, or provider work happens: 429, logged, zero spend.
    const budgetEur = budgetEurFor(apiKey);
    const spentEur = spendSince(apiKey, monthStartIso());
    if (spentEur >= budgetEur) {
      logRequest({
        apiKey,
        routeRule: null,
        provider: null,
        model: null,
        tier: null,
        inputTokens: null,
        outputTokens: null,
        costEur: null,
        latencyMs: Date.now() - startedAt,
        guardrailVerdict: null,
        blockedReason: null,
        status: 429,
      });
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

    // Slice 4: input guardrails run BEFORE routing and the provider call.
    // A blocked request is refused here: 403, one log row, zero spend.
    const guard = guardInput(body.messages, body.system);
    if (!guard.allowed) {
      logRequest({
        apiKey,
        routeRule: null,
        provider: null,
        model: null,
        tier: null,
        inputTokens: null,
        outputTokens: null,
        costEur: null,
        latencyMs: Date.now() - startedAt,
        guardrailVerdict: `block:${guard.ruleId}`,
        blockedReason: guard.reason,
        status: 403,
      });
      return reply.code(403).send({
        error: { kind: "blocked", ruleId: guard.ruleId, reason: guard.reason },
      });
    }

    // Slice 2: the tier flag is now an input to the router, not the answer.
    // The router (and the provider) see the redacted text, never the original.
    const decision = route(
      {
        requestedTier: body.tier,
        ...(body.task !== undefined ? { task: body.task } : {}),
        estimatedInputTokens: estimateInputTokens(guard.messages, guard.system),
      },
      provider,
    );

    const result = await provider.complete(decision.model, {
      messages: guard.messages,
      ...(guard.system !== undefined ? { system: guard.system } : {}),
      maxTokens: body.maxTokens,
      temperature: body.temperature,
    });

    // The discriminated union in action. Inside this branch TS knows
    // `result.value` exists; in the other branch it knows `result.error` does.
    if (!result.ok) {
      const status = statusFor(result.error);
      logRequest({
        apiKey,
        routeRule: decision.ruleId,
        provider: decision.provider,
        model: decision.model,
        tier: decision.tier,
        inputTokens: null,
        outputTokens: null,
        costEur: null,
        latencyMs: Date.now() - startedAt,
        guardrailVerdict: verdictLabel(guard.redactedBy),
        blockedReason: null,
        status,
      });
      // Failures carry the routing decision too: "what were we about to spend
      // money on" is part of the audit trail even when the call never landed.
      return reply.code(status).send({ error: result.error, routing: decision });
    }

    const { value } = result;

    // Slice 4: output guardrails scan the model's text for secret patterns
    // before it leaves the gateway. Output rules only redact today, but the
    // type admits a block verdict, so the compiler makes us handle it.
    const outGuard = guardOutput(value.text);
    if (!outGuard.allowed) {
      logRequest({
        apiKey,
        routeRule: decision.ruleId,
        provider: value.provider,
        model: value.model,
        tier: decision.tier,
        inputTokens: value.usage.inputTokens,
        outputTokens: value.usage.outputTokens,
        // The provider call happened, so the money is spent even though the
        // text never reaches the caller. Blocked is not free here.
        costEur: computeCostEur(value.model, value.usage),
        latencyMs: value.latencyMs,
        guardrailVerdict: `block:${outGuard.ruleId}`,
        blockedReason: outGuard.reason,
        status: 403,
      });
      return reply.code(403).send({
        error: { kind: "blocked", ruleId: outGuard.ruleId, reason: outGuard.reason },
        routing: decision,
      });
    }

    const redactedBy = [...guard.redactedBy, ...outGuard.redactedBy];
    const costEur = computeCostEur(value.model, value.usage);

    logRequest({
      apiKey,
      routeRule: decision.ruleId,
      provider: value.provider,
      model: value.model,
      tier: decision.tier,
      inputTokens: value.usage.inputTokens,
      outputTokens: value.usage.outputTokens,
      costEur,
      latencyMs: value.latencyMs,
      guardrailVerdict: verdictLabel(redactedBy),
      blockedReason: null,
      status: 200,
    });

    request.log.info(
      {
        provider: value.provider,
        model: value.model,
        tier: decision.tier,
        ruleId: decision.ruleId,
        inputTokens: value.usage.inputTokens,
        outputTokens: value.usage.outputTokens,
        latencyMs: value.latencyMs,
      },
      "completion",
    );

    return reply.send({
      text: outGuard.text,
      usage: value.usage,
      // Slice 5: the price table times the real usage, visible per request.
      costEur: costEur === null ? null : round6(costEur),
      routing: decision,
      // Like routing: the verdict is visible, not just logged.
      guardrails: { verdict: verdictLabel(redactedBy), redactedBy },
      latencyMs: value.latencyMs,
    });
  });
}

/** Costs are tiny fractions of a cent; six decimals keeps them readable. */
function round6(n: number): number {
  return Number(n.toFixed(6));
}

/** "allow" when nothing fired, otherwise "redact:" plus the rule ids. */
function verdictLabel(redactedBy: string[]): string {
  return redactedBy.length === 0 ? "allow" : `redact:${redactedBy.join(",")}`;
}

/**
 * Map provider failures to HTTP status codes. Exported since slice 6 because
 * the RAG route classifies provider failures the same way.
 *
 * TS note: this switch has no `default`. Because ProviderError is a closed
 * union and every member is handled, the function typechecks. When you add a
 * new member in a later slice, this stops compiling and TypeScript points at
 * the line. That is the compiler doing your code review.
 */
export function statusFor(error: ProviderError): number {
  switch (error.kind) {
    case "auth":
      return 502;
    case "rate_limited":
      return 429;
    case "bad_request":
      return 400;
    case "upstream":
      return 502;
    case "network":
      return 504;
  }
}
