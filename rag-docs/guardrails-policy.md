# Guardrails policy

Every request and every response passes through guardrails. There is no way
to opt out.

## Input rules

Personally identifiable information is redacted before any text leaves the
gateway: email addresses, IBANs, payment card numbers, and national ID
patterns are each replaced with a tag such as `[REDACTED:iban]`. The model
provider never sees the original value.

A small deny list of prompt-injection phrases blocks the request outright.
A blocked request returns HTTP 403, is written to the request log with the
rule that fired, and costs nothing, because no provider is ever called.

## Output rules

Model responses are scanned for secret patterns before being returned:
API keys, cloud access keys, and private key headers are redacted.

## Audit trail

Every guardrail decision is recorded as a structured verdict in the request
log: allow, redact with the list of rule ids, or block with the reason.
The verdict also appears in the response body, so callers can see when
their input was modified.
