import { env } from "../env";
import type { ProviderName } from "../types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import type { Provider } from "./provider";

/**
 * Build the set of providers that are actually configured.
 *
 * Slice 2 (the router) picks from this map. Today the /v1/chat route just
 * takes the default. The seam is already in place, so the router is a small
 * addition rather than a rewrite.
 */
function build(): Map<ProviderName, Provider> {
  const map = new Map<ProviderName, Provider>();

  if (env.ANTHROPIC_API_KEY !== undefined) {
    map.set("anthropic", new AnthropicProvider(env.ANTHROPIC_API_KEY));
  }
  if (env.OPENAI_API_KEY !== undefined) {
    map.set("openai", new OpenAIProvider(env.OPENAI_API_KEY));
  }

  return map;
}

export const providers = build();

/** The provider used when the caller does not name one. */
export function defaultProvider(): Provider {
  const first = providers.values().next();
  if (first.done === true) {
    throw new Error("No providers configured. This should have been caught in env.ts.");
  }
  return first.value;
}

export function getProvider(name: ProviderName | undefined): Provider | undefined {
  return name === undefined ? defaultProvider() : providers.get(name);
}
