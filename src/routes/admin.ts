import type { FastifyInstance } from "fastify";
import { requireApiKey } from "../auth";
import {
  requestCountsSince,
  spendByKeySince,
  spendByModelSince,
  successLatenciesSince,
} from "../db";
import { budgetEurFor, monthStartIso } from "../pricing";

/**
 * Slice 5: GET /admin/stats — the reporting half of the FinOps story.
 * Everything here is derived from the request log; there is no separate
 * metrics store that could disagree with it. All figures are month-to-date.
 */
export function registerAdminRoutes(app: FastifyInstance): void {
  app.get("/admin/stats", { preHandler: requireApiKey }, async () => {
    const since = monthStartIso();

    const spendByModel = spendByModelSince(since).map((row) => ({
      model: row.model,
      costEur: round6(row.costEur),
    }));

    const spendByKey = spendByKeySince(since).map((row) => {
      const budgetEur = budgetEurFor(row.apiKey);
      return {
        apiKey: row.apiKey,
        costEur: round6(row.costEur),
        budgetEur,
        budgetRemainingEur: round6(Math.max(0, budgetEur - row.costEur)),
      };
    });

    const counts = requestCountsSince(since);
    const latencies = successLatenciesSince(since);

    return {
      since,
      requests: {
        total: counts.total,
        blocked: counts.blocked,
        blockRate: counts.total === 0 ? 0 : round6(counts.blocked / counts.total),
      },
      p95LatencyMs: p95(latencies),
      spendByModel,
      spendByKey,
    };
  });
}

/**
 * Nearest-rank p95 over an already-sorted ascending list. Fine at this scale;
 * at real volume this becomes a histogram, not a full sort.
 */
function p95(sortedAsc: number[]): number | null {
  if (sortedAsc.length === 0) {
    return null;
  }
  const index = Math.ceil(sortedAsc.length * 0.95) - 1;
  return sortedAsc[index] ?? null;
}

function round6(n: number): number {
  return Number(n.toFixed(6));
}
