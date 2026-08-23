# Technical notes

Internal notes for explaining this codebase out loud. Covers slices 1-7:
provider adapters, the router, the SQLite request log, guardrails, cost
accounting with budget enforcement, a RAG endpoint over embedded markdown
chunks, and a static dashboard over `/admin/stats`. Every planned slice is
built — see "what's next" at the end for the one thing left.

## Architecture overview

One Fastify process. Three routes that do real work: `POST /v1/chat`,
`GET /admin/stats`, and `POST /v1/rag/query`. A `/health` route for a
liveness check, and `GET /dashboard` serving one static HTML page — see
"Dashboard" below. No database migrations, no queue, no background worker.
Everything happens synchronously inside the request handler, including the
SQLite write. RAG ingestion is a separate one-off script (`npm run ingest`),
not part of the request path.

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
4. **Budget check** — `spendSince(apiKey, monthStartIso())` sums this key's
   month-to-date cost straight out of the request log. If it's already at or
   over `budgetEurFor(apiKey)`, the request is refused: 429, logged, before
   guardrails, routing, or any provider call — see "Cost and budget" below.
5. **Input guardrails** — `guardInput()` runs PII redaction and the
   prompt-injection deny list over every message and the system prompt. A
   block here returns 403 immediately, logged, before routing or any
   provider call happens — see "Guardrails" below.
6. **Routing decision** — `route()` in `router.ts` turns the (already
   redacted) request into a `RouteDecision`: which provider, which model,
   which rule fired, why.
7. **Provider HTTP call** — `provider.complete(model, req)` does the real
   `fetch` to the vendor. It never throws; it returns a `CompletionResult`.
8. **Output guardrails** — `guardOutput()` scans the response text for
   secret patterns before it goes back to the caller. A block here is
   logged too, but the provider call already happened, so usage — and cost —
   is known.
9. **Log row** — exactly one `logRequest()` call, whichever way the request
   went.
10. **Response** — success returns
    `{ text, usage, costEur, routing, guardrails, latencyMs }`. Failure
    returns `{ error, routing }` (routing only if we got past step 6).

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
insert statement, and the read helpers. This is the only file that talks to
`better-sqlite3`. Besides `listRecentRequests()`, slice 5 adds the aggregate
readers used for budget enforcement and `/admin/stats`: `spendSince()`,
`spendByModelSince()`, `spendByKeySince()`, `requestCountsSince()`, and
`successLatenciesSince()`. Same pattern as the row reader — every query
result crosses a zod schema before it leaves this file. Slice 6 adds the
`chunks` table plus `replaceAllChunks()` and `allChunks()` — see "RAG" below.

**`src/guardrails.ts`** — the input and output rule lists, `applyRules()`
(the fold that runs a rule list over one string), and the two entry points
`guardInput()` / `guardOutput()`. No I/O, no state — pure functions over
strings, like `router.ts`. See "Guardrails" below.

**`src/guardrails.test.ts`** — a handful of `node:assert` checks against
`guardInput`/`guardOutput`, no test framework. Run with `npm test`.

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

**`src/pricing.ts`** — slice 5. The `PRICES_EUR_PER_1K` table,
`computeCostEur()`, `budgetEurFor()`, and `monthStartIso()`. No I/O, no
state — pure functions over numbers, same shape as `router.ts`. See "Cost
and budget" below.

**`src/routes/chat.ts`** — the `POST /v1/chat` handler described above, plus
`bodySchema` (the request contract), `verdictLabel()` (turns a `redactedBy`
list into the `"allow"` / `"redact:..."` string stored and returned), and
`statusFor()` (the `ProviderError`-to-HTTP-code mapping). `statusFor()` is
exported as of slice 6 — `routes/rag.ts` reuses it rather than duplicating
the mapping.

**`src/routes/admin.ts`** — slice 5. `GET /admin/stats`, behind the same
`requireApiKey` preHandler as chat. Pulls everything from the `db.ts`
aggregate readers and `pricing.ts`; no metrics store of its own. See "Cost
and budget" below.

**`src/rag/chunk.ts`** — slice 6, pure string work. `chunkText()` splits a
document into overlapping pieces. No I/O.

**`src/rag/embedder.ts`** — slice 6. `embed()` is a plain `fetch` to the
OpenAI embeddings API, and `cosineSimilarity()` scores two vectors. See
"RAG" below.

**`src/rag/ingest.ts`** — slice 6. The `npm run ingest` script: reads
markdown files, chunks and embeds them, rebuilds the `chunks` table. Not an
HTTP route.

**`src/routes/rag.ts`** — slice 6. The `POST /v1/rag/query` handler. See
"RAG" below.

**`src/routes/dashboard.ts`** — slice 7. `GET /dashboard`, `readFile`s
**`public/dashboard.html`** and returns it. See "Dashboard" below.

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

## Guardrails

Two independent rule lists live in `guardrails.ts`: **input rules** run
before routing and the provider call; **output rules** run on the model's
response text before it goes back to the caller.

Every rule returns a `GuardrailVerdict`, not a boolean:

```ts
type GuardrailVerdict =
  | { action: "allow" }
  | { action: "redact"; ruleId: string; redacted: string }
  | { action: "block"; ruleId: string; reason: string };
```

The verdict carries *which* rule fired and *what* it did, not just yes/no —
that's what makes `guardrail_verdict` in the request log worth having (see
below), and it's the union type discussed under "TypeScript ideas".

**Input rules**, checked in order, each seeing the text after every earlier
rule already ran:

| order | rule id | matches | action |
|---|---|---|---|
| 1 | `pii-email` | an email address | redact → `[REDACTED:email]` |
| 2 | `pii-iban` | an IBAN-shaped string | redact → `[REDACTED:iban]` |
| 3 | `pii-card` | a 12-19 digit card-shaped number | redact → `[REDACTED:card]` |
| 4 | `pii-national-id` | a `###-##-####` pattern | redact → `[REDACTED:national-id]` |
| 5 | `injection-denylist` | one of five literal phrases (e.g. "ignore previous instructions"), matched case-insensitively | block |

IBAN is checked before card deliberately: the card pattern is looser and
would eat an IBAN's digit tail if it ran first.

**Output rules**, redact-only, run over the response text:

| order | rule id | matches | action |
|---|---|---|---|
| 1 | `secret-api-key` | an `sk-...`-shaped string | redact → `[REDACTED:api-key]` |
| 2 | `secret-cloud-key` | an `AKIA...`-shaped string | redact → `[REDACTED:cloud-key]` |
| 3 | `secret-private-key` | a `-----BEGIN ... PRIVATE KEY-----` header | redact → `[REDACTED:private-key]` |

**Ordering and folding.** `applyRules()` folds one rule list left-to-right
over a single string: each rule sees the text after every earlier
redaction, redactions accumulate into a `redactedBy` list of rule ids, and
the first `block` wins — nothing after it runs. `guardOutput()` calls
`applyRules()` directly on the response text. `guardInput()` calls it once
per message and once for the system prompt, so a redaction can't merge two
messages into one, then dedupes the collected rule ids with `new Set`.

**Why a verdict, not a boolean.** A boolean can say "flagged"; it can't say
which rule flagged it or what happened as a result. `guardrail_verdict`
in the request log — `"allow"`, `"redact:pii-email,pii-card"`,
`"block:injection-denylist"` — is built straight from this type in
`verdictLabel()`. There's no separate summarizing step that could drift
from what the rules actually did.

**Redacted text is what the provider sees.** `routes/chat.ts` calls
`guardInput()` before `route()`, and passes `guard.messages` /
`guard.system` — never the original request body — into both the router's
token estimate and the provider call. The router and the vendor never see
the caller's original PII.

**Why a block costs nothing.** An input block returns before `route()` or
`provider.complete()` run: no HTTP call to a vendor, so no tokens and no
spend, ever. The response is `403` with
`{ error: { kind: "blocked", ruleId, reason } }`, and the log row records
`guardrail_verdict: "block:<ruleId>"` and `blocked_reason`, with
`input_tokens` / `output_tokens` / `cost_eur` left `null`. An output block
is different — it's a path the type system forces `chat.ts` to handle even
though today's output rules only ever redact — but if it ever fired, the
provider call already happened, so usage would be known and logged even
though the text never reaches the caller.

## Cost and budget

**The price table.** `PRICES_EUR_PER_1K` in `pricing.ts` is a plain object,
EUR per 1000 tokens, keyed by model id, with an `{ input, output }` pair for
each of the four configured models. It's approximate list pricing at time of
writing, in code rather than a database, so a vendor price change is a
one-line edit. `computeCostEur(model, usage)` looks the model up and returns
`inputTokens * price.input / 1000 + outputTokens * price.output / 1000` — or
`null` if the model isn't in the table. That lookup, and why it returns
`null` instead of throwing or guessing, is worth reading with
`noUncheckedIndexedAccess` in mind — see "TypeScript ideas" below.

**Versioned ids vs. table keys — a real bug, fixed.** Providers report
versioned model ids at call time (`"gpt-4o-mini-2024-07-18"`), but the price
table is keyed by base id (`"gpt-4o-mini"`). `priceFor()` tries an exact
match first, then falls back to the *longest* table key the reported id
starts with. Longest matters: `"gpt-4o"` is also a prefix of
`"gpt-4o-mini-2024-07-18"`, so a naive first-match (or shortest-match) scan
would price a mini call at the full `gpt-4o` rate. This was found live — an
OpenAI chat completion came back with `costEur: null` before the fix,
because the unversioned lookup missed entirely. An id that matches no table
key at all, versioned or not, still prices as `null`, same as before.

**Cost comes from real usage, always.** `computeCostEur()` is only ever
called with `value.usage` — the token counts the provider actually reported
for that call, never an estimate. The router's `estimateInputTokens()` picks
a tier before the call happens; it has no role in pricing afterward.

**The log is the ledger.** There's no separate spend table. `spendSince()` in
`db.ts` runs `SELECT SUM(cost_eur) ... WHERE api_key = ? AND ts >= ?`
straight against the `requests` table — the same rows written for every
outcome. Enforcement and reporting both read from that one sum; there's
nothing else that could disagree with it.

**Enforcement vs. reporting — two different jobs on the same data.** The 429
check in `routes/chat.ts` (step 4 above) is the FinOps enforcement: it reads
one key's spend, compares it to `budgetEurFor(apiKey)`, and refuses before
any money can be spent this request. `GET /admin/stats` in `routes/admin.ts`
is pure reporting — it doesn't gate anything, it just reads the same log
from a wider angle (across all keys and models, plus request counts and
p95 latency) so the numbers behind the enforcement are visible.
`budgetEurFor()` returns `env.MONTHLY_BUDGET_EUR` for any key today, because
there is exactly one static key in v0; a multi-tenant setup would look the
key up instead, and nothing else in either route would need to change.

**Which paths cost money.** A request only ever spends money if the provider
was actually called: the success path and the output-guardrail-block path
(the call happened, the text was withheld, but the tokens were still
generated — see "Guardrails" above). Every other outcome is free by
construction: input-block (403, refused before the provider call), over
budget (429, refused before the provider call), and validation/provider-
lookup failures (400, never got that far). `cost_eur` is `null` on all of
those rows.

## RAG

**Ingestion.** `npm run ingest` (optionally `npm run ingest -- <folder>`,
default `rag-docs/`) reads every `.md` file, chunks each one with
`chunkText()`, embeds every chunk in a single batch call, and calls
`replaceAllChunks()` to wipe and rebuild the `chunks` table. It's a script
run by hand when the docs change, not something the server does on boot or
on a schedule.

**Chunk size and overlap.** `chunkText()` targets ~2000 characters per
chunk (~500 tokens, using the router's own 4-chars/token heuristic) with a
200-character (~50 token) overlap between consecutive chunks. It prefers to
cut at a newline rather than mid-sentence, but only if that wouldn't shrink
the chunk below half size — a wall of text with no newlines still has to
terminate somewhere. The overlap exists so a sentence sitting on a chunk
boundary appears whole in at least one chunk; without it, the answer to a
query can fall exactly into the gap between two chunks and neither one
retrieves it.

**One embedding vendor, by design.** `embedder.ts`'s `embed()` is a plain
`fetch` to OpenAI's embeddings API (`text-embedding-3-small`), validated
through zod, reusing the same `classifyHttp()` the chat adapters use. It's
the only vendor because only one of the two configured providers offers an
embeddings API — that's the seam: swapping embedding vendors later means
changing this one file's URL, model name, and response schema, nothing
else. `embed()` returns a `bad_request` error if `OPENAI_API_KEY` isn't set,
even when the gateway is otherwise running fine on Anthropic for chat.

**Storage.** Each chunk is one row in the `chunks` table (`id`, `source`,
`chunk_index`, `content`, `embedding`). The embedding is stored as a
`Float32Array`'s raw bytes in a BLOB column — half the size of float64, with
no meaningful loss to retrieval quality at this vector length. Reading a
row back copies the BLOB into a fresh, aligned `ArrayBuffer` via `.slice()`
before wrapping it in a `Float32Array`; reading the driver's `Buffer` memory
in place would risk misalignment and would alias memory the driver owns.
`replaceAllChunks()` throws if a chunk comes back from `embed()` without a
matching vector — an ingest bug should refuse to store bad data, not
silently write a row with no embedding.

**Query pipeline**, in `routes/rag.ts`, in order:

1. **Body validation** — `{ query: string (min 1 char), topK: int 1-10,
   default 4 }`.
2. **Budget check** — same gate as `/v1/chat`: over budget is a 429 before
   anything else runs. A RAG query spends real money too (the answering
   completion).
3. **Input guardrails** — `guardInput()` runs on the query, same rules as
   chat. A block is a 403, logged, nothing called. The redacted query (not
   the original) is what gets embedded and answered.
4. **No-chunks check** — if the `chunks` table is empty, a 400 telling the
   caller to run `npm run ingest`, rather than a confusing empty-results
   200.
5. **Embed the query** — one `embed()` call. A provider failure here maps
   to an HTTP status through `statusFor()`, imported from `routes/chat.ts`
   rather than re-implemented.
6. **Score every chunk** — `cosineSimilarity()` between the query vector and
   every stored chunk's vector, sorted descending, top `topK` kept.
7. **Answer** — `defaultProvider()` on the **cheap** tier, temperature
   `0.2`, with a system prompt instructing the model to answer only from
   the retrieved context and cite `[filename]`. Cheap is enough here on
   purpose: retrieval already narrowed the problem down to a page of
   relevant text, so the model's job is reading comprehension over a short
   context, not the kind of reasoning that justifies the strong tier.
8. **Output guardrails** — `guardOutput()` scans the answer, same as chat.
9. **Log row** — exactly one `logRequest()` call per request, `route_rule`
   `"rag-query"`, following the same "every outcome logs, whichever
   branch it took" discipline as `/v1/chat`.

**Cost accounting is honest, not total.** `costEur` in the response is
computed from the chat completion's real usage only — the embedding call's
own cost is not counted. That's a real gap for exact accounting (embeddings
aren't free), stated plainly rather than hidden: the pricing table only has
completion models in it today, and folding embedding cost in would mean
guessing which of two API calls a given cost belongs to when only one gets
logged.

**Why the scores are in the response.** `chunks` in the response carries
`source`, `chunkIndex`, `content`, and `score` (cosine similarity, rounded
to 4 decimals) for every chunk that was used. That's deliberate: a RAG
answer is only trustworthy if you can see what it was built from. Returning
the answer alone would make retrieval quality a black box; returning the
scored, sourced chunks alongside it makes retrieval quality something you
can inspect on every single request, not just something to trust.

**Scale and the upgrade path.** Brute-force cosine over every chunk is
milliseconds at the scale this demo runs at (a few hundred chunks) — there's
no index because there's nothing to index yet. Past that, the swap is the
`chunks` table for a vector-capable store (pgvector, a managed vector DB)
behind the same `replaceAllChunks()` / `allChunks()` functions in `db.ts` —
the query pipeline in `routes/rag.ts` wouldn't need to change shape, only
what those two functions do internally. Hybrid retrieval (keyword + vector)
and a reranking pass are the next quality lever after that, and neither
exists here — both are future work, not implied by anything in this slice.

## Dashboard

**One static file, no framework.** `public/dashboard.html` is inline CSS
and vanilla JS — no build step, no charting library. It renders three plain
tables: requests (total / blocked / block rate / p95 latency), spend by
model, and spend by key (with budget and remaining). No charts, because a
table of numbers is what you'd want to defend under questioning, and a
charting dependency isn't.

**Why a route instead of a static-file plugin.** `registerDashboardRoute()`
in `routes/dashboard.ts` is one `app.get` handler that `readFile`s the HTML
off disk and sends it, on every request. That's a deliberate trade: a real
static-file plugin (`@fastify/static`) would be the normal way to do this,
but it's a dependency to explain for one file. Reading from disk per
request also means an edit to `dashboard.html` shows up on the next reload
with no server restart — a small dev-experience win that falls out of the
simple approach for free.

**Why the page is public but the data isn't.** `GET /dashboard` has no
`requireApiKey` preHandler — the HTML itself carries no data, so there's
nothing on that route worth protecting. The page asks the visitor for the
gateway API key in a plain `<input>`, keeps it in `localStorage` for
convenience across reloads, and sends it as `Authorization: Bearer` on every
call to `/admin/stats` — the same auth-gated endpoint `curl` uses, behind
the same `requireApiKey` check as chat. The key never leaves that browser;
the dashboard makes no other network call.

**Refresh, not push.** Pressing "Load" fetches once and starts a
`setInterval` that re-fetches `/admin/stats` every 10 seconds. No
WebSocket, no server-sent events — polling a `GET` endpoint is the boring
choice and the endpoint is already cheap (it's a handful of `SELECT`s over
the request log).

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
| `cost_eur` | REAL | yes, on success and output-guardrail-block rows, when the model is in the price table; `null` on input-block, over-budget, and validation/provider-lookup rows, and on any row for an unpriced model |
| `latency_ms` | INTEGER | yes — on success, the provider call's latency (`value.latencyMs`); on failures, time from handler entry |
| `guardrail_verdict` | TEXT | yes, whenever guardrails ran — `"allow"`, `"redact:<rule ids>"`, or `"block:<rule id>"`; `null` on validation/provider-lookup failures that happen before guardrails run |
| `blocked_reason` | TEXT | yes, only when a guardrail blocked the request; `null` otherwise |
| `cache_hit` | INTEGER | **always NULL today** — stretch goal (response cache) fills this |
| `status` | INTEGER | yes, always — the HTTP status code returned |

The insert statement (`insertStmt` in `db.ts`) still hard-codes `NULL` for
`cache_hit` — that's the only column left out of `RequestLogEntry`.
`cost_eur`, `guardrail_verdict`, and `blocked_reason` are all real fields on
`RequestLogEntry` now: every handler branch in `routes/chat.ts` passes an
explicit value, `null` included, for the outcomes those columns don't apply
to. The full schema was created up front specifically so slices 4 and 5 were
a column-fill, not a migration.

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

**403 (`blocked`) is not a `ProviderError`.** It never goes through
`statusFor()`. Both guardrail checks in `routes/chat.ts` return
`reply.code(403).send({ error: { kind: "blocked", ruleId, reason } })`
directly, before or after the provider call but always outside the
`ProviderError` union. That's deliberate: a block is the gateway's own
policy refusing the request, not a vendor failure — folding it into
`ProviderError` would make `statusFor()`'s switch responsible for a case
that has nothing to do with a provider, and would force every provider
adapter to know about guardrails.

**429 (`over_budget`) is the same story, and it's easy to confuse with the
provider's own 429.** `statusFor()`'s `rate_limited` case also returns 429 —
but that's the *provider* rate-limiting the gateway, mapped through
`classifyHttp()` from a vendor HTTP response. `over_budget` never touches
`statusFor()`; `routes/chat.ts` returns it directly, before any provider
call happens. Same HTTP status code, opposite actor: `rate_limited` means
"the vendor said slow down", `over_budget` means "the gateway is refusing
its own caller". Worth saying out loud precisely because the status code
doesn't tell them apart — `error.kind` does.

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
line ~126 (`if (!result.ok) { ... }`) for it in use.

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

**`GuardrailVerdict` — illegal states unrepresentable** — `guardrails.ts`.
A third discriminated union alongside `Result` and `ProviderError`, this one
chosen to make a mistake impossible to write rather than just easy to
narrow: there is no way to construct `{ action: "redact" }` without also
supplying the `redacted` text, or `{ action: "block" }` without a `reason`.
A rule that "flags something but forgets to say what" doesn't compile.

**Exhaustive switch, no `default`** — `statusFor()` in `routes/chat.ts`.
`ProviderError` is a closed union; the switch handles all five `kind`
values and has no `default` case. `noFallthroughCasesInSwitch` plus
TypeScript's control-flow analysis means the function only compiles because
every member is covered. Add a sixth `ProviderError` member later and this
function stops compiling until the new case is added — the compiler
performing part of the code review.

**`noUncheckedIndexedAccess` again, in `pricing.ts`.** Same flag as the
`openai.ts` example above, different flavor: `PRICES_EUR_PER_1K[model]` is
typed `{ input: number; output: number } | undefined`, because `model` is a
plain `string` and the compiler has no way to know it's a key that exists in
the table. It can't — the model id came from a request or from `.env`, not
from a literal in this file. `computeCostEur()` has to check
`price === undefined` before using it, and that check is exactly the
"unpriced model" case: it returns `null` instead of crashing or silently
pricing at zero. The type system is forcing the right business behavior,
not just satisfying the compiler.

## What's next

All planned slices (1-7) are built. Per `PLAN.md`, what's left:

- **Stretch** — an exact-hash response cache, filling in `cache_hit`.
- **Demo-prep hour** — rehearsing the walkthrough, not a code change.
