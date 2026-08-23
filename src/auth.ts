import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "./env";

/**
 * v0 auth: one static key in an Authorization: Bearer header.
 *
 * The reason it exists at all is that slice 4 attributes cost per key. Without
 * a caller identity there is nothing to bill, budget, or cut off. Real key
 * management is deliberately out of scope, and saying so in the interview is a
 * better answer than half-building it.
 */
export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;

  if (token === undefined || token !== env.GATEWAY_API_KEY) {
    await reply.code(401).send({ error: { kind: "auth", message: "Missing or invalid API key" } });
  }
}
