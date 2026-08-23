# Running and calling the gateway

This covers the gateway as it exists today: provider routing and a request
log. Guardrails, cost/budget enforcement, RAG, and a dashboard are not built
yet — see "what's next" at the end.

## Prerequisites

Node 20 or newer. There is no build step; `tsx` runs the TypeScript directly.

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set GATEWAY_API_KEY to anything, and at least one provider key
```

## Scripts

```bash
npm run dev         # tsx watch, restarts on file change
npm run start        # tsx, no watch
npm run typecheck    # tsc --noEmit, strict mode
```

## `.env` reference

| variable | default | required? |
|---|---|---|
| `PORT` | `8080` | no |
| `GATEWAY_API_KEY` | — | **yes** — callers send this as `Authorization: Bearer <value>` |
| `DB_PATH` | `gateway.db` | no — SQLite file for the request log |
| `ANTHROPIC_API_KEY` | — | at least one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is required |
| `OPENAI_API_KEY` | — | see above |
| `ANTHROPIC_MODEL_CHEAP` | `claude-haiku-4-5-20251001` | no |
| `ANTHROPIC_MODEL_STRONG` | `claude-sonnet-4-6` | no |
| `OPENAI_MODEL_CHEAP` | `gpt-4o-mini` | no |
| `OPENAI_MODEL_STRONG` | `gpt-4o` | no |

If neither provider key is set, or `GATEWAY_API_KEY` is missing, the process
prints the validation errors and exits — it will not start half-configured.

## Endpoints

### `GET /health`

No auth required.

```bash
curl -s localhost:8080/health
```

```json
{ "status": "ok", "providers": ["anthropic"] }
```

`providers` lists whichever vendors have an API key configured. It does not
call out to the vendor to check the key is valid — only that one was set.

### `POST /v1/chat`

Requires `Authorization: Bearer <GATEWAY_API_KEY>`.

Request body:

| field | type | required | default | notes |
|---|---|---|---|---|
| `messages` | array of `{ role, content }` | yes | — | at least 1 message; `role` is `"user"` or `"assistant"`; `content` is a non-empty string |
| `system` | string | no | — | optional system prompt |
| `tier` | `"cheap"` \| `"strong"` | no | `"cheap"` | see routing below |
| `task` | `"code"` \| `"analysis"` | no | — | a hint to the router, not sent to the provider |
| `provider` | `"anthropic"` \| `"openai"` | no | first configured provider | |
| `maxTokens` | integer 1-4096 | no | `1024` | |
| `temperature` | number 0-2 | no | `0.7` | |

Success response (`200`):

```json
{
  "text": "...",
  "usage": { "inputTokens": 14, "outputTokens": 9 },
  "routing": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "tier": "cheap",
    "ruleId": "default-cheap",
    "reason": "no routing rule matched; defaulting to the cheap tier"
  },
  "latencyMs": 812
}
```

Error response shape: `{ "error": { "kind": "...", ... } }`. If the request
made it past routing before failing, the response also carries `routing`,
same shape as above, so you can see which model the gateway was about to
call even though the call failed.

## How routing works

The router picks a tier (`cheap` or `strong`), which the provider then maps
to a concrete model. Three rules, checked in order, first match wins; if
none match, the request defaults to the cheap tier.

**Rule 1 — explicit tier.** Ask for `strong` directly.

```bash
curl -s -X POST localhost:8080/v1/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_GATEWAY_API_KEY' \
  -d '{"messages":[{"role":"user","content":"hi"}],"tier":"strong"}'
```

`routing.ruleId` comes back `"explicit-strong"`.

**Rule 2 — long input.** No `tier` set, but the input is long — roughly
1000 estimated tokens (~4 characters per token), estimated from the message
and system text before the call is made.

```bash
curl -s -X POST localhost:8080/v1/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_GATEWAY_API_KEY' \
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$(python3 -c 'print("word " * 1200)')\"}]}"
```

`routing.ruleId` comes back `"long-input"`.

**Rule 3 — task hint.** `task` is `"code"` or `"analysis"`.

```bash
curl -s -X POST localhost:8080/v1/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_GATEWAY_API_KEY' \
  -d '{"messages":[{"role":"user","content":"review this function"}],"task":"code"}'
```

`routing.ruleId` comes back `"task-hint"`.

**No rule matches — default.** A short request with no tier, task, or long
input.

```bash
curl -s -X POST localhost:8080/v1/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_GATEWAY_API_KEY' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

`routing.ruleId` comes back `"default-cheap"`.

## HTTP status codes

| status | when |
|---|---|
| 200 | success |
| 400 | request body failed validation, or `provider` names a vendor with no API key set |
| 401 | missing or wrong `GATEWAY_API_KEY` |
| 429 | the provider rate-limited the gateway |
| 502 | the provider rejected the gateway's credentials, or returned an error/unparseable response |
| 504 | the HTTP call to the provider failed outright (network error) |

## The request log

Every request — success, validation failure, unconfigured-provider, provider
error — writes exactly one row to a SQLite file at `DB_PATH` (default
`gateway.db`, WAL mode, gitignored). Query it directly:

```bash
sqlite3 gateway.db "SELECT * FROM requests ORDER BY ts DESC LIMIT 5;"
```

Columns: `id, ts, api_key, route_rule, provider, model, tier, input_tokens,
output_tokens, cost_eur, latency_ms, guardrail_verdict, blocked_reason,
cache_hit, status`.

`cost_eur`, `guardrail_verdict`, `blocked_reason`, and `cache_hit` are
reserved columns — they exist in the table today but are always written
`NULL`. Slice 4 (guardrails) and slice 5 (cost/budget) fill the guardrail
and cost columns; a possible later stretch fills `cache_hit`.

## What's next

Not built yet, per `PLAN.md`:

- **Slice 4** — guardrails: PII redaction and a prompt-injection check on
  input, a secret scan on output, blocked requests return 403.
- **Slice 5** — cost and budget: per-request cost in EUR, a monthly budget
  per API key enforced with 429, a `GET /admin/stats` endpoint.
- **Slice 6** — `POST /v1/rag/query`, a retrieval endpoint over embedded
  markdown chunks.
- **Slice 7** — a static HTML dashboard.
