import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { env } from "./env";

/**
 * Slice 3: the request log. One table, one row per request, written on every
 * outcome — success, failure, and (from slice 4 on) blocked.
 *
 * better-sqlite3 is synchronous. For a single-process gateway that is a
 * feature: no async plumbing in the handlers, and a write is done before the
 * response goes out. Only cache_hit is still written as NULL (the stretch
 * cache would fill it); creating the full schema up front avoided any
 * migration. Slice 4 filled the guardrail columns, slice 5 filled cost_eur.
 */

// Deployed, DB_PATH points at a mounted volume (/data/gateway.db). Create the
// directory first: better-sqlite3 otherwise fails with an opaque "unable to
// open database file". The resolved path is logged at boot because the bad
// case is silent — an unmounted volume falls back to the container's own
// filesystem, and the gateway runs happily while spend, the dashboard, and the
// RAG chunks reset on every redeploy.
const dbPath = path.resolve(env.DB_PATH);
mkdirSync(path.dirname(dbPath), { recursive: true });
console.log(`request log: ${dbPath}`);

const db = new Database(dbPath);
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

// Slice 6: RAG chunks. One row per chunk; the embedding is a Float32Array
// serialized as a BLOB. Brute-force cosine at query time reads them all —
// honest and fine for a few hundred chunks. The scale answer is a swap of
// this table for pgvector or a managed store, behind the same functions.
db.exec(`
  CREATE TABLE IF NOT EXISTS chunks (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    embedding   BLOB NOT NULL
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
  /** Real usage times the price table; null when nothing was spent or the model is unpriced. */
  costEur: number | null;
  latencyMs: number | null;
  /** "allow", "redact:<rule ids>", or "block:<rule id>"; null when guardrails never ran. */
  guardrailVerdict: string | null;
  /** Human-readable reason, only when blocked. */
  blockedReason: string | null;
  /** true/false on completions that consulted the cache; null everywhere else. */
  cacheHit: boolean | null;
  status: number;
};

const insertStmt = db.prepare(`
  INSERT INTO requests (id, ts, api_key, route_rule, provider, model, tier,
    input_tokens, output_tokens, cost_eur, latency_ms, guardrail_verdict,
    blocked_reason, cache_hit, status)
  VALUES (@id, @ts, @apiKey, @routeRule, @provider, @model, @tier,
    @inputTokens, @outputTokens, @costEur, @latencyMs, @guardrailVerdict,
    @blockedReason, @cacheHit, @status)
`);

/**
 * Never throws: a broken audit log must not take down the request path.
 * The error is printed and the request continues.
 */
export function logRequest(entry: RequestLogEntry): void {
  try {
    insertStmt.run({
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...entry,
      // SQLite has no boolean; store 1/0/NULL.
      cacheHit: entry.cacheHit === null ? null : entry.cacheHit ? 1 : 0,
    });
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

// --- Slice 5: aggregate reads for budget enforcement and /admin/stats. ---
// Same principle as above: every read crosses one zod schema on its way out
// of the driver, so the rest of the app never touches `unknown`.

const sumSchema = z.object({ total: z.number().nullable() });

/** EUR spent by one key since an ISO timestamp. NULL costs sum as zero. */
export function spendSince(apiKey: string, sinceIso: string): number {
  const row = db
    .prepare("SELECT SUM(cost_eur) AS total FROM requests WHERE api_key = ? AND ts >= ?")
    .get(apiKey, sinceIso);
  return sumSchema.parse(row).total ?? 0;
}

const spendByModelSchema = z.object({ model: z.string(), costEur: z.number() });

export function spendByModelSince(sinceIso: string): { model: string; costEur: number }[] {
  const rows = db
    .prepare(
      `SELECT model, SUM(cost_eur) AS costEur FROM requests
       WHERE ts >= ? AND cost_eur IS NOT NULL GROUP BY model ORDER BY costEur DESC`,
    )
    .all(sinceIso);
  return rows.map((row) => spendByModelSchema.parse(row));
}

const spendByKeySchema = z.object({ apiKey: z.string(), costEur: z.number() });

export function spendByKeySince(sinceIso: string): { apiKey: string; costEur: number }[] {
  const rows = db
    .prepare(
      `SELECT api_key AS apiKey, SUM(cost_eur) AS costEur FROM requests
       WHERE ts >= ? AND cost_eur IS NOT NULL GROUP BY api_key ORDER BY costEur DESC`,
    )
    .all(sinceIso);
  return rows.map((row) => spendByKeySchema.parse(row));
}

const countsSchema = z.object({ total: z.number(), blocked: z.number() });

/** Total requests and how many a guardrail blocked (status 403). */
export function requestCountsSince(sinceIso: string): { total: number; blocked: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 403 THEN 1 ELSE 0 END), 0) AS blocked
       FROM requests WHERE ts >= ?`,
    )
    .get(sinceIso);
  return countsSchema.parse(row);
}

/** Latencies of successful requests, sorted ascending — p95 is computed in JS. */
export function successLatenciesSince(sinceIso: string): number[] {
  const rows = db
    .prepare(
      `SELECT latency_ms FROM requests
       WHERE ts >= ? AND status = 200 AND latency_ms IS NOT NULL ORDER BY latency_ms ASC`,
    )
    .all(sinceIso);
  return rows.map((row) => z.object({ latency_ms: z.number() }).parse(row).latency_ms);
}

// --- Slice 6: chunk storage for the RAG endpoint. ---

export type StoredChunk = {
  source: string;
  chunkIndex: number;
  content: string;
  embedding: Float32Array;
};

const insertChunkStmt = db.prepare(`
  INSERT INTO chunks (id, source, chunk_index, content, embedding)
  VALUES (@id, @source, @chunkIndex, @content, @embedding)
`);

/** A chunk before it has an embedding — what the ingest script produces. */
export type ChunkInput = {
  source: string;
  chunkIndex: number;
  content: string;
};

/** Ingest wipes and rebuilds; no incremental sync to reason about in v0. */
export function replaceAllChunks(chunks: ChunkInput[], embeddings: number[][]): void {
  db.prepare("DELETE FROM chunks").run();
  chunks.forEach((chunk, i) => {
    const vector = embeddings[i];
    if (vector === undefined) {
      throw new Error(`No embedding for chunk ${i}. Ingest is broken, refusing to store.`);
    }
    insertChunkStmt.run({
      id: randomUUID(),
      source: chunk.source,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      // Float32 halves the storage of float64 with no retrieval-quality cost.
      embedding: Buffer.from(new Float32Array(vector).buffer),
    });
  });
}

const chunkRowSchema = z.object({
  source: z.string(),
  chunk_index: z.number(),
  content: z.string(),
  embedding: z.instanceof(Buffer),
});

export function allChunks(): StoredChunk[] {
  const rows = db.prepare("SELECT source, chunk_index, content, embedding FROM chunks").all();
  return rows.map((row) => {
    const parsed = chunkRowSchema.parse(row);
    // .slice() copies into a fresh, aligned ArrayBuffer. Reading the Buffer's
    // memory in place could be misaligned for Float32Array and would also
    // alias driver-owned memory.
    const buf = parsed.embedding;
    const embedding = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return {
      source: parsed.source,
      chunkIndex: parsed.chunk_index,
      content: parsed.content,
      embedding,
    };
  });
}
