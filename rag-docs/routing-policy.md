# Routing policy

The gateway routes every chat request to a model tier: cheap or strong.
The cheap tier is the default. The strong tier is roughly five times more
expensive per token, so escalation has to be earned.

Three rules can escalate a request to the strong tier, checked in order,
first match wins:

1. The caller explicitly asks for it by sending `tier: "strong"`.
2. The estimated input length exceeds 1000 tokens. Long inputs usually mean
   summarization or document analysis, where the cheap tier's quality drops
   noticeably.
3. The caller sends a task hint of `code` or `analysis`. Code generation and
   analytical reasoning are where tier quality differences are most visible.

If no rule matches, the request stays on the cheap tier.

Every response includes the routing decision: which rule fired, which model
was chosen, and a human-readable reason. Routing is never silent. If a bill
looks wrong, the request log records which rule was responsible for every
single request.
