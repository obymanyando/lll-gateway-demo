# Technical notes

Internal notes for explaining this codebase out loud. Covers slices 1-3 only:
provider adapters, the router, and the SQLite request log. Guardrails, cost,
RAG, and the dashboard do not exist yet — see "what's next" at the end.

## Architecture overview

One Fastify process. One route that does real work: `POST /v1/chat`. A
`/health` route for a liveness check. No database migrations, no queue, no
background worker. Everything happens synchronously inside the request
handler, including the SQLite write.

Request flow through `POST /v1/chat`:

1. **Auth** — `requireApiKey` runs as a Fastify `preHandler`, before the route
   handler body. It checks the `Authorization: Bearer` header against
   `GATEWAY_API_KEY`. Fail closed: no token, or the wrong token, is a 401.
2. **Body validation** — the route handler parses `request.body` against a
   zod schema (`bodySchema` in `routes/chat.ts`). A failure here is a 400 with
   the zod issues attached, and — this is the part worth saying out loud — it
   still writes a log row before returning.
3. **Provider resolution** — `getProvider(body.provider)` looks up the named
   provider, or the first configured one if the caller didn't name one.
   Naming a provider that isn't configured is also a 400, also logged.
4. **Routing decision** — `route()` in `router.ts` turns the request into a
   `RouteDecision`: which provider, which model, which rule fired, why.
5. **Provider HTTP call** — `provider.complete(model, req)` does the real
   `fetch` to the vendor. It never throws; it returns a `CompletionResult`.
6. **Log row** — exactly one `logRequest()` call, whichever way step 5 went.
7. **Response** — success returns `{ text, usage, routing, latencyMs }`.
   Failure returns `{ error, routing }` (routing only if we got past step 4).

The property worth defending under questioning: **every outcome writes
exactly one log row.** Validation failure, unconfigured provider, provider
error, and success all call `logRequest` exactly once, with `null` in
whichever columns don't apply to that outcome. There's no code path in
`routes/chat.ts` that returns without logging.

## Module map

**`src/env.ts`** — loads and validates `process.env` once, at import time,
through a zod schema. `parsed.data` becomes the exported `env` object; on
failure the process prints the issues and exits before the server ever
starts listening. Every other file imports `env` instead of touching
`process.env` directly, so there's exactly one place that can be wrong.

**`src/types.ts`** — the shared vocabulary: `Result<T, E>`, `ProviderName`,
`ChatMessage`, `CompletionRequest`, `Usage`, `CompletionSuccess`,
`ProviderError`, `CompletionResult`. No logic lives here, only shapes. Worth
reading first because everything else is expressed in these types.

**`src/auth.ts`** — the static bearer-key check. Two functions:
`bearerToken()` extracts the token from the header (used by both the auth
check and the request logger, so the log always has a caller identity), and
`requireApiKey()` is the Fastify `preHandler` that rejects with 401 when the
token is missing or wrong.

**`src/server.ts`** — boots Fastify, wires up `/health` and the chat route,
and starts listening on `env.PORT`. `/health` reports which providers are
configured by reading the keys of the `providers` map — it does not ping the
vendors.

**`src/db.ts`** — owns the SQLite connection, the `requests` table DDL, the
insert statement, and a typed read helper. This is the only file that talks
to `better-sqlite3`.

**`src/router.ts`** — the rules table and `route()`. Pure function: given a
`RouteInput` and a `Provider`, returns a `RouteDecision`. No I/O, no state,
easy to reason about and to unit-test later if that's ever added.

**`src/providers/provider.ts`** — the `Provider` interface every adapter
implements, plus `classifyHttp()`, the shared HTTP-status-to-`ProviderError`
mapping both adapters call so they classify vendor failures identically.

**`src/providers/anthropic.ts`**, **`src/providers/openai.ts`** — one file
per vendor, each a plain `fetch` against the vendor's HTTP API, each parsing
the response through its own zod schema, each normalizing the vendor's
quirks (system-as-field vs. system-as-message, `input_tokens` vs.
`prompt_tokens`) into the shared `CompletionResult` shape.

**`src/providers/registry.ts`** — builds the `Map<ProviderName, Provider>`
of whichever vendors have an API key set, plus `getProvider()` and
`defaultProvider()` for looking one up.

**`src/routes/chat.ts`** — the `POST /v1/chat` handler described above, plus
`bodySchema` (the request contract) and `statusFor()` (the error-to-HTTP-code
mapping).

## Routing

Three rules, evaluated top to bottom in `router.ts`, first match wins:

| order | rule id | matches when | tier |
|---|---|---|---|
| 1 | `explicit-strong` | caller sent `tier: "strong"` | strong |
| 2 | `long-input` | estimated input tokens > 1000 | strong |
| 3 | `task-hint` | `task` is `"code"` or `"analysis"` | strong |
| — | `default-cheap` | nothing above matched | cheap |

The estimate is `estimateInputTokens()`: sum the character length of
`system` plus every message's `content`, divide by 4 (`CHARS_PER_TOKEN`),
round up. It's a rough heuristic for routing only — the real token count
comes back from the provider afterward and is what gets logged (and, from
slice 5, priced).

The default isn't a fourth row in the `rules` array. It's the function
falling through the `for` loop and returning the cheap decision directly.
That's deliberate: the fallback is guaranteed by control flow, not by
remembering to keep a catch-all rule last in the table.

`RouteDecision` is `{ provider, model, tier, ruleId, reason }`. It's attached
to both success responses (`routing`) and error responses that got past
routing (`routing` alongside `error`). The reason for including it on
failures too: the caller — and the log — should be able to see what the
gateway was *about to spend money on* even when the provider call never
landed or never returned usable output.

## SQLite schema

One table, `requests`, created in `db.ts` with `CREATE TABLE IF NOT EXISTS`
— no migration framework, because the full column set is created up front.
WAL mode is turned on (`db.pragma("journal_mode = WAL")`) so reads and
writes don't block each other.

| column | type | written today? |
|---|---|---|
| `id` | TEXT PK | yes — `randomUUID()` |
| `ts` | TEXT | yes — `new Date().toISOString()` |
| `api_key` | TEXT | yes — the bearer token as presented |
| `route_rule` | TEXT | yes, when routing ran; `null` on validation/provider-lookup failures |
| `provider` | TEXT | yes, when known; `null` before routing |
| `model` | TEXT | yes, when known; `null` before routing |
| `tier` | TEXT | yes, when known; `null` before routing |
| `input_tokens` | INTEGER | yes, only on success (real usage from the provider) |
| `output_tokens` | INTEGER | yes, only on success |
| `cost_eur` | REAL | **always NULL today** — slice 5 (cost/budget) fills this |
| `latency_ms` | INTEGER | yes — on success, the provider call's latency (`value.latencyMs`); on failures, time from handler entry |
| `guardrail_verdict` | TEXT | **always NULL today** — slice 4 (guardrails) fills this |
| `blocked_reason` | TEXT | **always NULL today** — slice 4 fills this |
| `cache_hit` | INTEGER | **always NULL today** — stretch goal (response cache) fills this |
| `status` | INTEGER | yes, always — the HTTP status code returned |

The insert statement (`insertStmt` in `db.ts`) hard-codes `NULL` for
`cost_eur`, `guardrail_verdict`, `blocked_reason`, and `cache_hit` — those
columns aren't even in `RequestLogEntry`, the type a handler fills in. The
full schema exists now specifically so slices 4 and 5 are a column-fill, not
a migration.

## Error taxonomy

`ProviderError` (`types.ts`) is a five-member discriminated union on `kind`:
`auth`, `rate_limited`, `bad_request`, `upstream`, `network`. Both adapters
produce these via the shared `classifyHttp()` in `providers/provider.ts`, so
a 401 from Anthropic and a 401 from OpenAI both become `{ kind: "auth" }`
without either adapter file needing its own copy of that mapping.

`statusFor()` in `routes/chat.ts` maps `ProviderError` to the HTTP status
the gateway returns to *its* caller:

| `ProviderError.kind` | HTTP status | meaning |
|---|---|---|
| `auth` | 502 | the provider rejected our credentials |
| `rate_limited` | 429 | the provider rate-limited us |
| `bad_request` | 400 | the provider rejected the request shape |
| `upstream` | 502 | any other non-2xx from the provider, or an unparseable response |
| `network` | 504 | the `fetch` itself failed (DNS, connection, etc.) |

The point worth making explicitly: **gateway auth failure is 401, provider
auth failure is 502.** They look similar ("an API key was wrong") but mean
opposite things to the caller. A 401 means *you*, the caller, presented a
bad gateway key — fix your header. A 502 means the gateway's own upstream
credentials are bad, or the vendor is having a problem — nothing the caller
did wrong, and not something they can fix by retrying with a different key.
Collapsing those into one status code would hide that distinction.

## TypeScript ideas used here

**`Result<T, E>` instead of throw** — `types.ts`. `Provider.complete()` and
everything that calls it never throws for expected failure modes. A caller
must destructure `.ok` before touching `.value` or `.error`; there's no way
to accidentally read a value that was never produced. Contrast with a thrown
exception, which is invisible in the function's type signature.

**Discriminated unions and narrowing** — the `ok`/`error` split in `Result`,
and the `kind` field in `ProviderError`. TypeScript uses the literal
discriminant (`ok: true` / `ok: false`, or each `kind` string) to narrow
which fields exist inside an `if` or `switch` branch. See the comment block
at the top of `types.ts` for the canonical example, and `routes/chat.ts`
line ~98 (`if (!result.ok) { ... }`) for it in use.

**`z.infer` deriving types from schemas** — `env.ts` (`Env`), `routes/chat.ts`
(`ChatBody`), `db.ts` (`RequestRow`). The zod schema is written once; the
TypeScript type is `z.infer<typeof schema>`, generated from it. There's no
hand-written interface that can drift out of sync with the runtime
validation.

**`as const satisfies readonly RouteRule[]`** — `router.ts`, the `rules`
array. Two separate jobs: `satisfies` checks each rule object against the
`RouteRule` shape without widening the array's *inferred* type (so a typo in
a field name is still a compile error), and `as const` stops each `id`
string from widening to plain `string`. That's what lets `RuleId` be derived
as `(typeof rules)[number]["id"] | "default-cheap"` — a literal union of the
actual rule ids, not just `string`. Add a rule to the table and `RuleId`
picks it up automatically.

**`noUncheckedIndexedAccess`** — visible in `providers/openai.ts`. Zod's
`.min(1)` guarantees the `choices` array is non-empty at runtime, but the
compiler doesn't know that from an index access. `parsed.data.choices[0]` is
typed `Choice | undefined`, so the code checks `if (first === undefined)`
and returns an `upstream` error rather than reaching for a non-null `!`.

**`exactOptionalPropertyTypes`** — visible as the conditional-spread pattern
in `anthropic.ts`, `openai.ts`, and `routes/chat.ts`:
`...(req.system !== undefined ? { system: req.system } : {})`. With this
flag on, `{ system: undefined }` is not assignable to a type where `system`
is an optional field — the property has to be *absent*, not present-with-
undefined. The spread is how the code produces "absent" rather than
"present but undefined".

**Exhaustive switch, no `default`** — `statusFor()` in `routes/chat.ts`.
`ProviderError` is a closed union; the switch handles all five `kind`
values and has no `default` case. `noFallthroughCasesInSwitch` plus
TypeScript's control-flow analysis means the function only compiles because
every member is covered. Add a sixth `ProviderError` member later and this
function stops compiling until the new case is added — the compiler
performing part of the code review.

## What's next

Per `PLAN.md`, not yet built:

- **Slice 4** — guardrails: input PII/injection rules, output secret-scan
  rules, a structured verdict, `guardrail_verdict` / `blocked_reason` filled
  in, blocked requests return 403.
- **Slice 5** — cost and budget: a price table, `cost_eur` filled in, a
  per-key monthly budget enforced with 429, `GET /admin/stats`.
- **Slice 6** — a RAG endpoint (`POST /v1/rag/query`), brute-force cosine
  similarity over embedded markdown chunks stored in SQLite.
- **Slice 7** — a static HTML dashboard reading `/admin/stats`.
- **Stretch** — an exact-hash response cache, filling in `cache_hit`.
