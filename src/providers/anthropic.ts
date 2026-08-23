import { z } from "zod";
import { env } from "../env";
import { err, ok, type CompletionRequest, type CompletionResult, type Tier } from "../types";
import { classifyHttp, type Provider } from "./provider";

/**
 * No SDK. Plain fetch against the Messages API.
 *
 * Reason: the wire format matters here, specifically where the token usage
 * numbers come from, because the cost layer is built on those two fields.
 * An SDK would hide exactly the thing this project is about.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Validate the provider's response instead of trusting it.
 *
 * TS note: `fetch().json()` returns `any` at runtime and `unknown`-ish in
 * practice. Parsing it through zod is what turns untrusted JSON into a typed
 * value the compiler can reason about. This is the honest alternative to
 * casting with `as`.
 */
const responseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  model: z.string(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;

  constructor(private readonly apiKey: string) {}

  modelFor(tier: Tier): string {
    return tier === "strong" ? env.ANTHROPIC_MODEL_STRONG : env.ANTHROPIC_MODEL_CHEAP;
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const startedAt = Date.now();

    // Anthropic takes `system` as a top-level field, not as a message.
    // OpenAI takes it as a message with role "system". This difference is
    // exactly what the adapter exists to hide from the rest of the app.
    const body = {
      model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...(req.system !== undefined ? { system: req.system } : {}),
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    let res: Response;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      return err({ kind: "network", message: String(cause) });
    }

    const raw = await res.text();

    if (!res.ok) {
      return classifyHttp(res.status, raw.slice(0, 500));
    }

    const parsed = responseSchema.safeParse(safeJson(raw));
    if (!parsed.success) {
      return err({ kind: "upstream", status: res.status, message: "Unexpected response shape" });
    }

    // content is a list of blocks. Concatenate the text ones.
    const text = parsed.data.content
      .filter((block) => block.type === "text" && block.text !== undefined)
      .map((block) => block.text ?? "")
      .join("");

    return ok({
      text,
      usage: {
        inputTokens: parsed.data.usage.input_tokens,
        outputTokens: parsed.data.usage.output_tokens,
      },
      provider: this.name,
      model: parsed.data.model,
      latencyMs: Date.now() - startedAt,
    });
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
