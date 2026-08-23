# llm-gateway

A small LLM gateway in TypeScript: rule-based routing, guardrails, a request
log that doubles as the billing ledger, cost accounting with budget
enforcement, retrieval, and a dashboard over all of it.

Complete: seven slices plus an exact-hash response cache.

**Docs:** [running and calling it](docs/USER.md) ·
[how it works inside](docs/TECHNICAL.md) ·
[end-to-end walkthrough](WALKTHROUGH.md)

## What it does

- **Routing.** A rules table picks the model tier — explicit request, input
  length over a threshold, or a task hint. First match wins, and every response
  names the rule that fired and why.
- **Guardrails.** Input rules redact PII (email, IBAN, card, national ID) and a
  deny list blocks prompt injection; output rules scan for secret patterns.
  Each rule returns a structured verdict, not a boolean.
- **Cost and budgets.** Every request is priced from the provider's real token
  counts. Each key has a monthly budget, and exceeding it returns 429 *before*
  a provider is called.
- **A request log that is the ledger.** Every outcome writes exactly one row to
  SQLite. Month-to-date spend is a sum over that table — there is no second
  store to disagree with it.
- **Retrieval.** RAG over embedded markdown chunks, returning each chunk with
  its similarity score and source file.
- **A response cache.** Identical requests are served from an exact-hash cache:
  no provider call, zero cost, logged as a hit.

## Run it

```bash
npm install
cp .env.example .env
# edit .env: set GATEWAY_API_KEY to anything, and at least one provider key
npm run dev
```

Requires Node 20 or newer. There is no build step; `tsx` runs TypeScript
directly and `npm run typecheck` runs the compiler in strict mode.

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # plain node:assert checks on the guardrail rules
npm run ingest      # chunk + embed rag-docs/*.md for the RAG endpoint
```

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

# 3. A real completion, with real token counts and a price
curl -s -X POST localhost:8080/v1/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_GATEWAY_API_KEY' \
  -d '{"messages":[{"role":"user","content":"Say hello in five words."}]}'
```

```json
{
  "text": "...",
  "usage": { "inputTokens": 14, "outputTokens": 9 },
  "costEur": 0.000053,
  "routing": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "tier": "cheap",
    "ruleId": "default-cheap",
    "reason": "no routing rule matched; defaulting to the cheap tier"
  },
  "guardrails": { "verdict": "allow", "redactedBy": [] },
  "cacheHit": false,
  "latencyMs": 812
}
```

See [WALKTHROUGH.md](WALKTHROUGH.md) for the rest: routing escalation, a
guardrail block, the budget 429, a RAG query with scores, and the dashboard.

## Layout

```
src/
  env.ts                  config validated once at boot, types derived from the schema
  types.ts                Result type + discriminated unions. Read this first.
  auth.ts                 static bearer key, so cost can be attributed per caller
  router.ts               the routing rules table and the route decision
  guardrails.ts           input and output rules, each returning a structured verdict
  pricing.ts              the price table, cost computation, per-key budgets
  cache.ts                exact-hash response cache
  db.ts                   SQLite: the request log, aggregates, and RAG chunks
  providers/
    provider.ts           the Provider interface, the seam the router hangs off
    anthropic.ts          plain fetch, no SDK
    openai.ts             plain fetch, no SDK
    registry.ts           builds the map of configured providers
  rag/
    chunk.ts              chunking with overlap
    embedder.ts           embeddings over plain fetch, plus cosine similarity
    ingest.ts             the `npm run ingest` script
  routes/
    chat.ts               POST /v1/chat
    rag.ts                POST /v1/rag/query
    admin.ts              GET /admin/stats
    dashboard.ts          GET /dashboard
  server.ts               Fastify boot
```

## Why no SDKs

Both adapters call the HTTP APIs directly. The token usage fields are the input
to the cost layer, and an SDK hides exactly the part this project is about. It
also keeps the dependency list to four packages: fastify, zod, pino-pretty, and
better-sqlite3.

## The TypeScript ideas in here

1. **Strict mode from line one.** `strict`, plus `noUncheckedIndexedAccess` and
   `exactOptionalPropertyTypes`. See `tsconfig.json`.
2. **Discriminated unions.** `Result<T, E>` in `types.ts`. The `ok: true` /
   `ok: false` field narrows the type in each branch. Reading `.value` on a
   failure is a compile error, not a runtime one.
3. **Result instead of throw.** `Provider.complete` never throws. Failure is in
   the return type, so every caller is forced to handle it.
4. **Zod plus `z.infer`.** Schemas are the single source of truth; the types
   come from them. Nothing to keep in sync by hand.
5. **Exhaustive switch.** `statusFor()` in `routes/chat.ts` has no `default`.
   Add a new `ProviderError` member and that function stops compiling until you
   handle it.
6. **`as const satisfies`.** The routing rules table in `router.ts` keeps its
   rule ids as literal types, so `RuleId` is derived from the table itself.

Design decisions and their reasoning are in [docs/TECHNICAL.md](docs/TECHNICAL.md).
