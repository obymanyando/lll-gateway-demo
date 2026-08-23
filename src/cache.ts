import { createHash } from "node:crypto";
import type { ChatMessage, ProviderName, Usage } from "./types";

/**
 * Stretch: exact-hash response cache.
 *
 * The key is a hash of everything that determines the completion: the routed
 * model, the (already redacted) messages and system prompt, maxTokens and
 * temperature. Two byte-identical requests to the same model get the same
 * answer back without a provider call — which is the point: a cache hit
 * costs exactly zero, and the log's cache_hit column proves how often.
 *
 * In-memory on purpose. It empties on restart and grows unbounded; for a
 * single-process demo both are fine, and the honest production answer is a
 * shared store with TTL and an eviction policy, plus caching only
 * temperature-0 requests if repeatability matters.
 */
export type CachedCompletion = {
  text: string;
  usage: Usage;
  provider: ProviderName;
  model: string;
};

const store = new Map<string, CachedCompletion>();

export function cacheKey(
  model: string,
  messages: ChatMessage[],
  system: string | undefined,
  maxTokens: number,
  temperature: number,
): string {
  // JSON.stringify is stable here because the object is built literally in
  // one place — key order cannot drift between calls.
  const payload = JSON.stringify({ model, messages, system: system ?? null, maxTokens, temperature });
  return createHash("sha256").update(payload).digest("hex");
}

export function cacheGet(key: string): CachedCompletion | undefined {
  return store.get(key);
}

export function cacheSet(key: string, value: CachedCompletion): void {
  store.set(key, value);
}
