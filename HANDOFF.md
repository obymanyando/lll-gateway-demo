# HANDOFF.md

Bootstrap file. Everything needed to recreate this project from nothing.

If the repo already contains `src/`, you do not need this file. Read
`CLAUDE.md` and `PLAN.md` instead and start at slice 2.

## If the repo is empty

Create every file below at the given path, exactly as written. Then:

```bash
npm install
cp .env.example .env
npm run typecheck   # must be clean
```

Then confirm with the author that his provider key is in `.env`, run
`npm run dev`, and check `curl -s localhost:8080/health`.

Then commit as `slice 1: typed provider adapters, /v1/chat, strict TS` and stop.
Read `CLAUDE.md` and `PLAN.md` before starting slice 2.

This code typechecks under strict mode and has been smoke tested end to end.
Do not "improve" it on the way in. Reproduce it verbatim.

---

## `package.json`

```json
{
  "name": "llm-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "A small LLM gateway: routing, request logging, guardrails, cost control, RAG.",
  "scripts": {
    "dev": "tsx watch --env-file=.env src/server.ts",
    "start": "tsx --env-file=.env src/server.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "fastify": "^5.2.1",
    "zod": "^3.24.1",
    "pino-pretty": "^13.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3"
  }
}
```

## `tsconfig.json`

```json
{
  "compilerOptions": {
    // Target a modern Node. Node 20+ supports everything here.
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",

    // "bundler" resolution lets you write `import { x } from "./x"` with no
    // file extension. We run everything through tsx, which resolves the same
    // way, so dev and typecheck agree. There is no build step in v0.
    "moduleResolution": "bundler",

    "types": ["node"],
    "rootDir": "src",
    "noEmit": true,

    // --- The part that matters. Do not soften these later. ---
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,

    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

## `.gitignore`

```
node_modules/
.env
*.db
*.sqlite
dist/
.DS_Store
```

## `.env.example`

```
# Copy to .env and fill in. .env is gitignored.
PORT=8080

# Any random string. Callers send it as: Authorization: Bearer <this>
GATEWAY_API_KEY=dev-local-key-change-me

# At least one of these is required.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Optional: override if a model id changes.
# ANTHROPIC_MODEL_CHEAP=claude-haiku-4-5-20251001
# ANTHROPIC_MODEL_STRONG=claude-sonnet-4-6
# OPENAI_MODEL_CHEAP=gpt-4o-mini
# OPENAI_MODEL_STRONG=gpt-4o
```

## `src/env.ts`

```ts
import { z } from "zod";

/**
 * Validate config once, at boot, and export a typed object.
 *
 * TS note: `z.infer<typeof schema>` derives the TypeScript type FROM the
 * runtime schema. One source of truth. You never hand-write an `Env` interface
 * that can drift from the validation.
 */
/**
 * TS note: a generic function. `<T extends z.ZodTypeAny>` means "whatever
 * schema you hand me, I give you back a schema of that same type". Without the
 * generic you would lose the inner type and end up with ZodAny, which would
 * quietly widen every field it touches to `any`.
 */
function emptyAsUndefined<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => (v === "" ? undefined : v), inner);
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),

  GATEWAY_API_KEY: z.string().min(1, "Set GATEWAY_API_KEY in .env"),

  // At least one of these must be present. Checked in .refine() below.
  // `emptyAsUndefined` matters: a copied .env.example leaves the unused key as
  // an empty string, and an empty string is not the same as "not configured".
  ANTHROPIC_API_KEY: emptyAsUndefined(z.string().min(1).optional()),
  OPENAI_API_KEY: emptyAsUndefined(z.string().min(1).optional()),

  // Model names live in config, not in code, so a renamed model is a .env edit.
  ANTHROPIC_MODEL_CHEAP: z.string().default("claude-haiku-4-5-20251001"),
  ANTHROPIC_MODEL_STRONG: z.string().default("claude-sonnet-4-6"),
  OPENAI_MODEL_CHEAP: z.string().default("gpt-4o-mini"),
  OPENAI_MODEL_STRONG: z.string().default("gpt-4o"),
});

const parsed = schema
  .refine((v) => v.ANTHROPIC_API_KEY !== undefined || v.OPENAI_API_KEY !== undefined, {
    message: "Set at least one of ANTHROPIC_API_KEY or OPENAI_API_KEY",
  })
  .safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof schema>;
```

## `src/types.ts`

```ts
/**
 * The two TypeScript ideas this whole codebase is built on.
 *
 * 1. DISCRIMINATED UNION
 *    A union of object types that all share one literal field (here: `ok`).
 *    TypeScript uses that field to narrow the type inside an if/switch.
 *
 *      if (r.ok) { r.value }   // <- TS knows `value` exists here
 *      else      { r.error }   // <- and `error` exists here, but not `value`
 *
 *    Accessing r.value in the else branch is a compile error. That is the
 *    whole point: illegal states stop being reachable.
 *
 * 2. RESULT INSTEAD OF THROW
 *    A thrown error is invisible in a function's type signature. A returned
 *    Result is not. Every caller is forced by the compiler to handle failure.
 *    For a gateway, where the failure path (rate limited, blocked, over budget)
 *    IS the product, this matters more than it would in a normal app.
 */

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/** Which quality tier the caller asked for. The router turns this into a model. */
export type Tier = "cheap" | "strong";

/** Provider identifiers. A union of literals, not `string`, so typos fail to compile. */
export type ProviderName = "anthropic" | "openai";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type CompletionRequest = {
  messages: ChatMessage[];
  system?: string;
  maxTokens: number;
  temperature: number;
};

/** Token usage as reported by the provider. Slice 4 turns this into money. */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
};

export type CompletionSuccess = {
  text: string;
  usage: Usage;
  provider: ProviderName;
  model: string;
  latencyMs: number;
};

/**
 * Provider failures, as another discriminated union. `kind` is the discriminant.
 * Later slices add more members here (e.g. { kind: "over_budget" }) and the
 * compiler will point at every switch that has not handled it yet.
 */
export type ProviderError =
  | { kind: "auth"; message: string }
  | { kind: "rate_limited"; message: string; retryAfterMs?: number }
  | { kind: "bad_request"; message: string }
  | { kind: "upstream"; status: number; message: string }
  | { kind: "network"; message: string };

export type CompletionResult = Result<CompletionSuccess, ProviderError>;
```

## `src/auth.ts`

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "./env";

/**
 * v0 auth: one static key in an Authorization: Bearer header.
 *
 * The reason it exists at all is that slice 4 attributes cost per key. Without
 * a caller identity there is nothing to bill, budget, or cut off. Real key
 * management is deliberately out of scope, and saying so in the interview is a
 * better answer than half-building it.
 */
export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;

  if (token === undefined || token !== env.GATEWAY_API_KEY) {
    await reply.code(401).send({ error: { kind: "auth", message: "Missing or invalid API key" } });
  }
}
```

## `src/server.ts`

```ts
import Fastify from "fastify";
import { env } from "./env";
import { providers } from "./providers/registry";
import { registerChatRoute } from "./routes/chat";

const app = Fastify({
  logger: {
    level: "info",
    transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
  },
});

app.get("/health", async () => ({
  status: "ok",
  providers: [...providers.keys()],
}));

registerChatRoute(app);

async function main(): Promise<void> {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`providers configured: ${[...providers.keys()].join(", ")}`);
  } catch (cause) {
    app.log.error(cause);
    process.exit(1);
  }
}

void main();
```

## `src/providers/provider.ts`

```ts
import type { CompletionRequest, CompletionResult, ProviderName, Tier } from "../types";

/**
 * The seam the whole gateway hangs off.
 *
 * Every provider implements this identical shape, so the router can hold a
 * `Provider` without knowing or caring which vendor it is. Adding a third
 * vendor later means writing one new file and adding one registry entry. No
 * route handler changes.
 *
 * TS note: this is an `interface`, so the compiler checks each adapter against
 * it structurally. If Anthropic's adapter returns a slightly different shape
 * than OpenAI's, it fails to compile rather than failing in the demo.
 */
export interface Provider {
  readonly name: ProviderName;

  /** Resolve a quality tier to this vendor's concrete model id. */
  modelFor(tier: Tier): string;

  /** Never throws. Failures come back as Err<ProviderError>. */
  complete(model: string, req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Shared HTTP failure mapping so both adapters classify errors identically.
 * Exhaustive-by-construction: anything unmapped becomes "upstream".
 */
export function classifyHttp(status: number, message: string): CompletionResult & { ok: false } {
  if (status === 401 || status === 403) {
    return { ok: false, error: { kind: "auth", message } };
  }
  if (status === 429) {
    return { ok: false, error: { kind: "rate_limited", message } };
  }
  if (status === 400 || status === 422) {
    return { ok: false, error: { kind: "bad_request", message } };
  }
  return { ok: false, error: { kind: "upstream", status, message } };
}
```

## `src/providers/anthropic.ts`

```ts
import { z } from "zod";
import { env } from "../env";
import { err, ok, type CompletionRequest, type CompletionResult, type Tier } from "../types";
import { classifyHttp, type Provider } from "./provider";

/**
 * No SDK. Plain fetch against the Messages API.
 *
 * Reason: you need to see the wire format, and specifically where the token
 * usage numbers come from, because slice 4 (cost) is built on those two fields.
 * An SDK hides exactly the thing you are being interviewed about.
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
```

## `src/providers/openai.ts`

```ts
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
```

## `src/providers/registry.ts`

```ts
import { env } from "../env";
import type { ProviderName } from "../types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import type { Provider } from "./provider";

/**
 * Build the set of providers that are actually configured.
 *
 * Slice 2 (the router) picks from this map. Today the /v1/chat route just
 * takes the default. The seam is already in place, so the router is a small
 * addition rather than a rewrite.
 */
function build(): Map<ProviderName, Provider> {
  const map = new Map<ProviderName, Provider>();

  if (env.ANTHROPIC_API_KEY !== undefined) {
    map.set("anthropic", new AnthropicProvider(env.ANTHROPIC_API_KEY));
  }
  if (env.OPENAI_API_KEY !== undefined) {
    map.set("openai", new OpenAIProvider(env.OPENAI_API_KEY));
  }

  return map;
}

export const providers = build();

/** The provider used when the caller does not name one. */
export function defaultProvider(): Provider {
  const first = providers.values().next();
  if (first.done === true) {
    throw new Error("No providers configured. This should have been caught in env.ts.");
  }
  return first.value;
}

export function getProvider(name: ProviderName | undefined): Provider | undefined {
  return name === undefined ? defaultProvider() : providers.get(name);
}
```

## `src/routes/chat.ts`

```ts
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
```

