import { z } from "zod";
import { env } from "../env";
import { err, ok, type CompletionRequest, type CompletionResult, type Tier } from "../types";
import { classifyHttp, type Provider } from "./provider";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const responseSchema = z.object({
  model: z.string(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
  }),
});

export class OpenAIProvider implements Provider {
  readonly name = "openai" as const;

  constructor(private readonly apiKey: string) {}

  modelFor(tier: Tier): string {
    return tier === "strong" ? env.OPENAI_MODEL_STRONG : env.OPENAI_MODEL_CHEAP;
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const startedAt = Date.now();

    // Note the shape difference from Anthropic: system is a message here,
    // and usage fields are named prompt_tokens / completion_tokens.
    // Both differences are normalised away before returning.
    const messages = [
      ...(req.system !== undefined ? [{ role: "system" as const, content: req.system }] : []),
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    let res: Response;
    try {
      res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
        }),
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

    // noUncheckedIndexedAccess is on, so choices[0] is typed as possibly
    // undefined even though zod guaranteed .min(1). The compiler does not know
    // that. Handle it explicitly rather than reaching for a `!`.
    const first = parsed.data.choices[0];
    if (first === undefined) {
      return err({ kind: "upstream", status: res.status, message: "No choices returned" });
    }

    return ok({
      text: first.message.content ?? "",
      usage: {
        inputTokens: parsed.data.usage.prompt_tokens,
        outputTokens: parsed.data.usage.completion_tokens,
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
