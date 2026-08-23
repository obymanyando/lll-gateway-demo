---
# No `title` here on purpose: the theme's banner then falls back to the site
# title from _config.yml, rather than heading the landing page "Overview".
layout: default
---

A small gateway that sits between an application and its model providers, and
makes what happens in between visible: which model a request was routed to and
why, what was redacted or blocked, what it cost, and what it retrieved.

Built in TypeScript under strict compiler settings, in seven slices, each one
ending in a working state.

## Documentation

- **[Running and calling the gateway](USER.html)** — setup, the `.env`
  reference, every endpoint with its request and response shapes, and a curl
  example for each behaviour.
- **[Technical notes](TECHNICAL.html)** — architecture and request flow, the
  reasoning behind each design decision, and the TypeScript constructs the
  codebase is built on.

## What it does

**Routing.** A rules table decides the model tier — an explicit request, an
input over a length threshold, or a task hint. First match wins, and every
response names the rule that fired and why. Routing is never silent, so a
surprising bill is always traceable to a decision.

**Guardrails.** Input rules redact PII (email, IBAN, card, national ID) before
anything leaves the gateway; a deny list blocks prompt-injection attempts
outright. Output rules scan responses for secret patterns. Every rule returns
a structured verdict rather than a boolean, so the log records which rule
fired and what it did.

**Cost and budgets.** Each request is priced from the token counts the provider
actually reports, against a per-model price table. Each API key has a monthly
budget, and exceeding it returns a 429 *before* a provider is called. That
distinction is the point: reporting is a dashboard, enforcement is the part
that controls spend.

**A request log that is the ledger.** Every outcome — success, redaction,
block, budget refusal, validation failure — writes exactly one row to SQLite.
Month-to-date spend is a sum over that table. There is no second bookkeeping
system that could disagree with it.

**Retrieval.** A RAG endpoint over embedded markdown chunks, scored by cosine
similarity. Responses return the retrieved chunks with their scores and source
files, so retrieval quality can be inspected per request instead of trusted.

**A response cache.** Identical requests are served from an exact-hash cache:
no provider call, zero cost, logged as a cache hit. The lookup runs after the
budget and guardrail checks, so a hit can never bypass policy.

## What it deliberately does not do

Streaming, retry and failover, multi-tenant key management, a vector database,
reranking, hybrid retrieval, and a frontend framework are all absent on
purpose. Each is a reasonable thing to want and a poor thing to half-build.
The seams they would attach to exist; the scale-up answer for each is written
down in the technical notes rather than approximated in code.

## Source

The full source, including the plan the build followed and the constraints it
was held to, is on [GitHub](https://github.com/obymanyando/lll-gateway-demo).
