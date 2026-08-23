import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey } from "../auth";
import { getProvider } from "../providers/registry";
import type { ProviderError, Tier } from "../types";

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
  provider: z.enum(["anthropic", "openai"]).optional(),
  maxTokens: z.number().int().min(1).max(4096).default(1024),
  temperature: z.number().min(0).max(2).default(0.7),
});

export type ChatBody = z.infer<typeof bodySchema>;

export function registerChatRoute(app: FastifyInstance): void {
  app.post("/v1/chat", { preHandler: requireApiKey }, async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { kind: "bad_request", issues: parsed.error.issues },
      });
    }
    const body = parsed.data;

    const provider = getProvider(body.provider);
    if (provider === undefined) {
      return reply.code(400).send({
        error: { kind: "bad_request", message: `Provider not configured: ${body.provider}` },
      });
    }

    const tier: Tier = body.tier;
    const model = provider.modelFor(tier);

    const result = await provider.complete(model, {
      messages: body.messages,
      ...(body.system !== undefined ? { system: body.system } : {}),
      maxTokens: body.maxTokens,
      temperature: body.temperature,
    });

    // The discriminated union in action. Inside this branch TS knows
    // `result.value` exists; in the other branch it knows `result.error` does.
    if (!result.ok) {
      return reply.code(statusFor(result.error)).send({ error: result.error });
    }

    const { value } = result;

    request.log.info(
      {
        provider: value.provider,
        model: value.model,
        tier,
        inputTokens: value.usage.inputTokens,
        outputTokens: value.usage.outputTokens,
        latencyMs: value.latencyMs,
      },
      "completion",
    );

    return reply.send({
      text: value.text,
      // These two numbers are the ones slice 4 multiplies by a price table.
      // Returning them now means the cost slice has nothing left to discover.
      usage: value.usage,
      routing: { provider: value.provider, model: value.model, tier },
      latencyMs: value.latencyMs,
    });
  });
}

/**
 * Map provider failures to HTTP status codes.
 *
 * TS note: this switch has no `default`. Because ProviderError is a closed
 * union and every member is handled, the function typechecks. When you add a
 * new member in a later slice, this stops compiling and TypeScript points at
 * the line. That is the compiler doing your code review.
 */
function statusFor(error: ProviderError): number {
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
