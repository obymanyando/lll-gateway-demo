/**
 * The two TypeScript ideas this whole codebase is built on.
 *
 * 1. DISCRIMINATED UNION
 *    A union of object types that all share one literal field (here: `ok`).
 *    TypeScript uses that field to narrow the type inside an if/switch.
 *
 *      if (r.ok) { r.value }   // <- TS knows `value` exists here
 *      else      { r.error }   // <- and `error` exists here, but not `value`
 *
 *    Accessing r.value in the else branch is a compile error. That is the
 *    whole point: illegal states stop being reachable.
 *
 * 2. RESULT INSTEAD OF THROW
 *    A thrown error is invisible in a function's type signature. A returned
 *    Result is not. Every caller is forced by the compiler to handle failure.
 *    For a gateway, where the failure path (rate limited, blocked, over budget)
 *    IS the product, this matters more than it would in a normal app.
 */

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/** Which quality tier the caller asked for. The router turns this into a model. */
export type Tier = "cheap" | "strong";

/** Provider identifiers. A union of literals, not `string`, so typos fail to compile. */
export type ProviderName = "anthropic" | "openai";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type CompletionRequest = {
  messages: ChatMessage[];
  system?: string;
  maxTokens: number;
  temperature: number;
};

/** Token usage as reported by the provider. Slice 4 turns this into money. */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
};

export type CompletionSuccess = {
  text: string;
  usage: Usage;
  provider: ProviderName;
  model: string;
  latencyMs: number;
};

/**
 * Provider failures, as another discriminated union. `kind` is the discriminant.
 * Later slices add more members here (e.g. { kind: "over_budget" }) and the
 * compiler will point at every switch that has not handled it yet.
 */
export type ProviderError =
  | { kind: "auth"; message: string }
  | { kind: "rate_limited"; message: string; retryAfterMs?: number }
  | { kind: "bad_request"; message: string }
  | { kind: "upstream"; status: number; message: string }
  | { kind: "network"; message: string };

export type CompletionResult = Result<CompletionSuccess, ProviderError>;
