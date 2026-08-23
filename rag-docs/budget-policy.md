# Budget policy

Every API key has a monthly spend budget in euros, configured by
`MONTHLY_BUDGET_EUR` and defaulting to 25 EUR per calendar month (UTC).

## How spend is measured

Each request's cost is computed from the token counts the provider actually
reports, multiplied by a per-model price table (EUR per 1000 tokens). The
cost is written to the request log. The log is the ledger: month-to-date
spend is the sum of the cost column, and there is no second bookkeeping
system that could disagree with it.

## Enforcement

When a key's month-to-date spend reaches its budget, further requests are
refused with HTTP 429 before any provider is called. The response body
states the budget, the amount spent, and the remaining balance. Enforcement
happens before guardrails and routing, so an over-budget request costs
exactly nothing.

Blocked and refused requests never spend money. The only case where a
withheld response still costs money is an output guardrail block, because
the provider had already been called before the response was scanned.

## Reporting

`GET /admin/stats` reports month-to-date spend by model and by key, each
key's remaining budget, the guardrail block rate, and p95 latency of
successful requests. All figures are read from the request log.
