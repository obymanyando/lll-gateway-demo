import { env } from "./env";
import type { Usage } from "./types";

/**
 * Slice 5: cost accounting and budgets.
 *
 * The price table lives in code, in EUR per 1000 tokens, keyed by model id.
 * Prices are approximate list prices at time of writing; a vendor price
 * change is a one-line edit here, not a code change. The token counts this
 * multiplies are the REAL usage numbers reported by the provider — that is
 * why the adapters return them instead of hiding them behind an SDK.
 */
const PRICES_EUR_PER_1K: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.0009, output: 0.0045 },
  "claude-sonnet-4-6": { input: 0.0027, output: 0.0135 },
  "gpt-4o-mini": { input: 0.00014, output: 0.00055 },
  "gpt-4o": { input: 0.0023, output: 0.009 },
};

/**
 * TS note: with noUncheckedIndexedAccess, PRICES_EUR_PER_1K[model] is typed
 * `{...} | undefined` — the compiler refuses to assume a string key exists.
 * An unknown model id therefore has to be handled: it prices as null (logged
 * as null, treated as zero spend) rather than crashing or guessing.
 */
export function computeCostEur(model: string, usage: Usage): number | null {
  const price = priceFor(model);
  if (price === undefined) {
    return null;
  }
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1000;
}

/**
 * Providers report versioned ids (e.g. "gpt-4o-mini-2024-07-18") while the
 * table uses the base id. Exact match first, then the LONGEST table key the
 * reported id starts with — longest, because "gpt-4o" is also a prefix of
 * "gpt-4o-mini-..." and would price the wrong model if checked first.
 */
function priceFor(model: string): { input: number; output: number } | undefined {
  const exact = PRICES_EUR_PER_1K[model];
  if (exact !== undefined) {
    return exact;
  }
  const byLengthDesc = Object.keys(PRICES_EUR_PER_1K).sort((a, b) => b.length - a.length);
  const prefix = byLengthDesc.find((key) => model.startsWith(key));
  return prefix === undefined ? undefined : PRICES_EUR_PER_1K[prefix];
}

/**
 * Monthly budget per API key. There is exactly one static key in v0, so every
 * key gets the env-configured budget; a real multi-tenant setup would look
 * the key up in a table here. The underscore prefix tells the compiler
 * (noUnusedParameters) that ignoring the argument is deliberate.
 */
export function budgetEurFor(_apiKey: string): number {
  return env.MONTHLY_BUDGET_EUR;
}

/** First instant of the current month, UTC, as ISO text — the log's ts format. */
export function monthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
