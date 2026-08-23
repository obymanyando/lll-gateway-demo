import type { CompletionRequest, CompletionResult, ProviderName, Tier } from "../types";

/**
 * The seam the whole gateway hangs off.
 *
 * Every provider implements this identical shape, so the router can hold a
 * `Provider` without knowing or caring which vendor it is. Adding a third
 * vendor later means writing one new file and adding one registry entry. No
 * route handler changes.
 *
 * TS note: this is an `interface`, so the compiler checks each adapter against
 * it structurally. If Anthropic's adapter returns a slightly different shape
 * than OpenAI's, it fails to compile rather than failing in the demo.
 */
export interface Provider {
  readonly name: ProviderName;

  /** Resolve a quality tier to this vendor's concrete model id. */
  modelFor(tier: Tier): string;

  /** Never throws. Failures come back as Err<ProviderError>. */
  complete(model: string, req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Shared HTTP failure mapping so both adapters classify errors identically.
 * Exhaustive-by-construction: anything unmapped becomes "upstream".
 */
export function classifyHttp(status: number, message: string): CompletionResult & { ok: false } {
  if (status === 401 || status === 403) {
    return { ok: false, error: { kind: "auth", message } };
  }
  if (status === 429) {
    return { ok: false, error: { kind: "rate_limited", message } };
  }
  if (status === 400 || status === 422) {
    return { ok: false, error: { kind: "bad_request", message } };
  }
  return { ok: false, error: { kind: "upstream", status, message } };
}
