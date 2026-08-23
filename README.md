# llm-gateway

A small LLM gateway in TypeScript. Slice 1 of 7.

Built: routing seam, typed provider adapters, request validation, static key auth, real token usage returned.
Next: router rules, SQLite request log, guardrails, cost and budget, RAG endpoint.

## Run it

```bash
npm install
cp .env.example .env
# edit .env: set GATEWAY_API_KEY to anything, and at least one provider key
npm run dev
```

Requires Node 20 or newer. There is no build step in v0. `tsx` runs TypeScript
directly and `npm run typecheck` runs the compiler in strict mode.

## Verify in 60 seconds

```bash
# 1. Which providers did it pick up
curl -s localhost:8080/health
# {"status":"ok","providers":["anthropic"]}

# 2. Auth is enforced
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8080/v1/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
# 401

# 3. Validation is enforced
curl -s -X POST localhost:8080/v1/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_GATEWAY_API_KEY' \
  -d '{"messages":[]}'
# 400 with structured zod issues

# 4. A real completion, with real token counts
curl -s -X POST localhost:8080/v1/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_GATEWAY_API_KEY' \
  -d '{"messages":[{"role":"user","content":"Say hello in five words."}],"tier":"cheap"}'
```

Response shape:

```json
{
  "text": "...",
  "usage": { "inputTokens": 14, "outputTokens": 9 },
  "routing": { "provider": "anthropic", "model": "claude-haiku-4-5-20251001", "tier": "cheap" },
  "latencyMs": 812
}
```

Those two `usage` numbers are what slice 4 multiplies by a price table. They are
returned now so the cost slice has nothing left to discover.

## Layout

```
src/
  env.ts                  config validated once at boot, types derived from the schema
  types.ts                Result type + discriminated unions. Read this first.
  auth.ts                 static bearer key, so cost can be attributed per caller
  providers/
    provider.ts           the Provider interface, the seam the router hangs off
    anthropic.ts          plain fetch, no SDK
    openai.ts             plain fetch, no SDK
    registry.ts           builds the map of configured providers
  routes/
    chat.ts               POST /v1/chat
  server.ts               Fastify boot
```

## Why no SDKs

Both adapters call the HTTP APIs directly. The token usage fields are the input
to the cost layer, and an SDK hides exactly the part this project is about.
It also keeps the dependency list to three packages.

## The five TypeScript ideas in here

1. **Strict mode from line one.** `strict`, plus `noUncheckedIndexedAccess` and
   `exactOptionalPropertyTypes`. See `tsconfig.json`.
2. **Discriminated unions.** `Result<T, E>` in `types.ts`. The `ok: true` /
   `ok: false` field narrows the type in each branch. Reading `.value` on a
   failure is a compile error, not a runtime one.
3. **Result instead of throw.** `Provider.complete` never throws. Failure is in
   the return type, so every caller is forced to handle it.
4. **Zod plus `z.infer`.** Schemas are the single source of truth; the types come
   from them. Nothing to keep in sync by hand.
5. **Exhaustive switch.** `statusFor()` in `routes/chat.ts` has no `default`.
   Add a new `ProviderError` member and that function stops compiling until you
   handle it.
