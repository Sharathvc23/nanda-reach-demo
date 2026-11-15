import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";

/**
 * Admin actions (flipping the card, sending a promotion, resetting) need the admin token when
 * one is configured. With no token configured, as in local mock runs, everything is open.
 */
export function requireAdmin(config: Config) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!config.adminToken) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-admin-token"] as string | undefined);
    if (token !== config.adminToken) {
      await reply.code(401).send({ error: "admin token required" });
    }
  };
}
