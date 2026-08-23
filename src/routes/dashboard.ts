import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

/**
 * Slice 7: GET /dashboard serves one static HTML file, read from disk on
 * each request (the file is tiny and this keeps edits live in dev). No
 * static-file plugin — one route and one readFile is less to explain than a
 * dependency. The page itself is public; the data it fetches
 * (/admin/stats) still requires the bearer key, which the page asks for.
 */
export function registerDashboardRoute(app: FastifyInstance): void {
  app.get("/dashboard", async (_request, reply) => {
    const html = await readFile("public/dashboard.html", "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
