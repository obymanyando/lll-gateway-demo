import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { env } from "./env";

/**
 * Slice 3: the request log. One table, one row per request, written on every
 * outcome — success, failure, and (from slice 4 on) blocked.
 *
 * better-sqlite3 is synchronous. For a single-process gateway that is a
 * feature: no async plumbing in the handlers, and a write is done before the
 * response goes out. The columns cost_eur, guardrail_verdict, blocked_reason
 * and cache_hit are written as NULL until slices 4 and 5 fill them; creating
 * the full schema now avoids a migration mid-build.
 */

const db = new Database(env.DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id                TEXT PRIMARY KEY,
    ts                TEXT NOT NULL,
    api_key           TEXT NOT NULL,
    route_rule        TEXT,
    provider          TEXT,
    model             TEXT,
    tier              TEXT,
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    cost_eur          REAL,
    latency_ms        INTEGER,
    guardrail_verdict TEXT,
    blocked_reason    TEXT,
    cache_hit         INTEGER,
    status            INTEGER NOT NULL
  )
`);

/**
 * What a handler reports about one request. Fields that do not apply to a
 * given outcome are explicit `null`, not optional: every call site is forced
 * to say "there was no model" rather than silently forgetting a field.
 */
export type RequestLogEntry = {
  apiKey: string;
  routeRule: string | null;
  provider: string | null;
  model: string | null;
  tier: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  status: number;
};

const insertStmt = db.prepare(`
  INSERT INTO requests (id, ts, api_key, route_rule, provider, model, tier,
    input_tokens, output_tokens, cost_eur, latency_ms, guardrail_verdict,
    blocked_reason, cache_hit, status)
  VALUES (@id, @ts, @apiKey, @routeRule, @provider, @model, @tier,
    @inputTokens, @outputTokens, NULL, @latencyMs, NULL,
    NULL, NULL, @status)
`);

/**
 * Never throws: a broken audit log must not take down the request path.
 * The error is printed and the request continues.
 */
export function logRequest(entry: RequestLogEntry): void {
  try {
    insertStmt.run({ id: randomUUID(), ts: new Date().toISOString(), ...entry });
  } catch (cause) {
    console.error("request log write failed:", cause);
  }
}

/**
 * TS note: better-sqlite3's .all() returns unknown[] — the driver cannot know
 * what a row looks like. Instead of casting with `as` at every call site, the
 * rows go through a zod schema once, here. Reads elsewhere in the app get a
 * typed RequestRow and the cast never happens.
 */
const rowSchema = z.object({
  id: z.string(),
  ts: z.string(),
  api_key: z.string(),
  route_rule: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tier: z.string().nullable(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  cost_eur: z.number().nullable(),
  latency_ms: z.number().nullable(),
  guardrail_verdict: z.string().nullable(),
  blocked_reason: z.string().nullable(),
  cache_hit: z.number().nullable(),
  status: z.number(),
});

export type RequestRow = z.infer<typeof rowSchema>;

export function listRecentRequests(limit: number): RequestRow[] {
  const rows = db.prepare("SELECT * FROM requests ORDER BY ts DESC LIMIT ?").all(limit);
  // .parse throws on mismatch. This is our own table: a shape mismatch is a
  // bug in this file, and crashing loudly beats returning wrong data quietly.
  return rows.map((row) => rowSchema.parse(row));
}
