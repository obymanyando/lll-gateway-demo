import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "./env";

/**
 * v0 auth: one static key in an Authorization: Bearer header.
 *
 * The reason it exists at all is that slice 5 attributes cost per key. Without
 * a caller identity there is nothing to bill, budget, or cut off. Real key
 * management is deliberately out of scope: a named limitation is more honest
 * than a half-built one.
 */
/** The bearer token as presented, or undefined. Also used by the request log. */
export function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
}

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(req);

  if (token === undefined || token !== env.GATEWAY_API_KEY) {
    await reply.code(401).send({ error: { kind: "auth", message: "Missing or invalid API key" } });
  }
}
