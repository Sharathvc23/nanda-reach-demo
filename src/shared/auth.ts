import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Actions that change state (sending a promotion, chatting as John, resetting) need the admin
 * token when one is configured. With no token configured, as in local runs and tests, they are open.
 */
export function requireAdmin(adminToken: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!adminToken) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : (req.headers["x-admin-token"] as string | undefined);
    if (token !== adminToken) await reply.code(401).send({ error: "admin token required" });
  };
}
