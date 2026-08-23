# PLAN.md

Total budget: 8 to 10 hours. Slice 1 is spent. Roughly 7 hours of build left,
plus a fixed final hour that is not code.

Each slice ends in a working, demoable state. If time runs out mid-plan, the
repo is still a coherent demo at whatever slice it stopped at. That is the
point of the ordering.

---

## Slice 1 — Skeleton and provider adapters. DONE

Fastify, strict TypeScript, zod-validated config and request bodies, static
bearer auth, two provider adapters behind one interface, real token usage
returned from `POST /v1/chat`.

Verified: typecheck clean, server boots, 401 on missing key, 400 with
structured issues on a bad body, real HTTP round trip to the provider.

---

## Slice 2 — Router (~1h)

Turn the tier flag into an actual routing decision, and make the decision
visible.

Build:
- A rules table (an array of rules, evaluated in order, first match wins).
- Rules for v0: explicit `tier: "strong"` in the request; estimated input
  length over a threshold; a `task` hint of `"code"` or `"analysis"`. Default
  is the cheap tier.
- A `RouteDecision` type: which provider, which model, which rule id fired, and
  a human-readable reason.
- Return the decision in the response under `routing`.

Acceptance: two requests that differ only in input length route to different
models, and the response says which rule caused it.

TS focus: another discriminated union, and a `readonly` array of rule objects
typed with `satisfies` so the rule ids stay literal types rather than widening
to `string`.

---

## Slice 3 — Request log (~1h)

Add `better-sqlite3`. One table, `requests`, written on every request including
blocked and failed ones.

Columns: `id, ts, api_key, route_rule, provider, model, tier, input_tokens,
output_tokens, cost_eur, latency_ms, guardrail_verdict, blocked_reason,
cache_hit, status`.

`cost_eur` and the guardrail columns are written as null for now. Slice 4 and 5
fill them. Creating the full schema once avoids a migration mid-build.

Acceptance: five curl calls, then `SELECT * FROM requests` shows five rows with
correct token counts.

TS focus: `better-sqlite3` is synchronous and returns `unknown`. Wrap reads in a
small typed helper rather than casting at every call site.

---

## Slice 4 — Guardrails (~1.25h)

Input and output, each a list of rules, each rule returning a structured
verdict rather than a boolean.

Input rules: PII redaction (email, IBAN, payment card, and a national ID
pattern), plus a prompt-injection heuristic on a small deny list.
Output rules: a secret-pattern scan before the response is returned.

Verdict shape: `{ action: "allow" } | { action: "redact"; ruleId; redacted } |
{ action: "block"; ruleId; reason }`.

Blocked requests return 403, are written to the log, and cost nothing.

Acceptance: one request containing a fake IBAN comes back redacted and the log
shows the rule id. One request on the deny list returns 403 and is logged.

Keep the rule implementations shallow. Regexes are fine and defensible. The
value here is the structured verdict and the audit trail, not detection
sophistication.

---

## Slice 5 — Cost and budget (~1.5h)

The FinOps slice. This is the one that differentiates the demo, so protect its
time.

Build:
- A price table in code: per-1k input and output tokens, in EUR, per model.
- Cost computed per request from the real usage numbers and written to the log.
- A monthly budget per API key.
- **Enforcement**: when a key is over budget, return 429 with the remaining
  balance in the body. Reporting is a dashboard. Enforcement is FinOps. Build
  the enforcement.
- `GET /admin/stats`: spend by model, spend by key, block rate, p95 latency,
  budget remaining.

Acceptance: set a tiny budget, spend past it, get a 429 with a clear body.

---

## Slice 6 — RAG endpoint (~1.5h)

Ingest a folder of markdown, chunk at roughly 500 tokens with 50 overlap, embed
each chunk, store vectors as a BLOB in SQLite, brute-force cosine at query
time.

`POST /v1/rag/query` returns the answer plus the retrieved chunks **with their
similarity scores and source filenames**. The scores being visible is what
makes this demoable.

No vector database. The honest interview answer is "brute force over a few
hundred chunks, and here is exactly what I would swap at scale: pgvector or a
managed store, hybrid retrieval, a reranker, and chunk-level access control."
Build the seams, prepare the scale answer verbally.

---

## Slice 7 — Dashboard (~1h)

One static HTML file served by Fastify, fetching `/admin/stats`. Plain tables.
One sparkline only if it comes free. No framework, no build step, no charting
library.

---

## Stretch, only if ahead after slice 5

Exact-hash response cache. Roughly 30 minutes. Turns the cost story from
"I measured spend" into "I reduced spend". Log the `cache_hit` column that
already exists.

---

## The final hour — not code

Non-negotiable. Protect it.

1. Seed data: run 20 or so varied requests so the dashboard and log are not
   empty on screen share.
2. Write `DEMO.md`: six steps, in order, each with the exact curl command and
   the one sentence said out loud while it runs.
3. One live run-through, out loud, start to finish, timed.

Suggested demo order: health and configured providers, a cheap request, the
same request escalated by a routing rule, a request blocked by a guardrail, the
budget 429, a RAG query with visible scores, then the dashboard showing all of
it.

The largest failure risk on this project is not scope. It is hour eight,
finding one more thing to add. Do not.
