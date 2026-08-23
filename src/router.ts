import type { Provider } from "./providers/provider";
import type { ChatMessage, ProviderName, Tier } from "./types";

/**
 * Slice 2: the router.
 *
 * A rules table, evaluated top to bottom, first match wins. Each rule maps the
 * request to a tier; the provider then maps the tier to a concrete model. The
 * decision is returned to the caller, so routing is never a black box: every
 * response says which rule fired and why.
 */

/** What a rule is allowed to look at. Kept small on purpose. */
export type RouteInput = {
  requestedTier: Tier;
  task?: "code" | "analysis";
  estimatedInputTokens: number;
};

type RouteRule = {
  id: string;
  tier: Tier;
  /** Human-readable. Goes into the response verbatim. */
  reason: string;
  matches: (input: RouteInput) => boolean;
};

/**
 * Rough token estimate: ~4 characters per token for English text. Good enough
 * for a routing threshold; the provider reports the real count afterwards, and
 * slice 5 uses the real one for cost.
 */
const CHARS_PER_TOKEN = 4;
const LONG_INPUT_TOKENS = 1000;

export function estimateInputTokens(messages: ChatMessage[], system: string | undefined): number {
  const chars =
    (system?.length ?? 0) + messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * TS note: `as const satisfies readonly RouteRule[]` does two jobs.
 * `satisfies` checks the array against the RouteRule shape WITHOUT changing its
 * inferred type — a typo in a field name is a compile error. `as const` stops
 * the ids widening to `string`, so `RuleId` below is the union
 * "explicit-strong" | "long-input" | "task-hint", not just `string`.
 */
const rules = [
  {
    id: "explicit-strong",
    tier: "strong",
    reason: "caller explicitly requested tier=strong",
    matches: (input) => input.requestedTier === "strong",
  },
  {
    id: "long-input",
    tier: "strong",
    reason: `estimated input exceeds ${LONG_INPUT_TOKENS} tokens`,
    matches: (input) => input.estimatedInputTokens > LONG_INPUT_TOKENS,
  },
  {
    id: "task-hint",
    tier: "strong",
    reason: "task hint (code or analysis) routes to the strong model",
    matches: (input) => input.task === "code" || input.task === "analysis",
  },
] as const satisfies readonly RouteRule[];

/**
 * TS note: `(typeof rules)[number]` means "the type of one element of the
 * array", and `["id"]` picks out that element's id field. The result is the
 * union of the literal ids, derived FROM the table. Add a rule and this type
 * updates itself; there is no separate list to keep in sync.
 */
export type RuleId = (typeof rules)[number]["id"] | "default-cheap";

export type RouteDecision = {
  provider: ProviderName;
  model: string;
  tier: Tier;
  ruleId: RuleId;
  reason: string;
};

export function route(input: RouteInput, provider: Provider): RouteDecision {
  for (const rule of rules) {
    if (rule.matches(input)) {
      return {
        provider: provider.name,
        model: provider.modelFor(rule.tier),
        tier: rule.tier,
        ruleId: rule.id,
        reason: rule.reason,
      };
    }
  }

  // No rule matched: the documented default. Kept out of the table so the
  // fallback is guaranteed by control flow, not by remembering to put a
  // catch-all rule last.
  return {
    provider: provider.name,
    model: provider.modelFor("cheap"),
    tier: "cheap",
    ruleId: "default-cheap",
    reason: "no routing rule matched; defaulting to the cheap tier",
  };
}
