import type { FastifyInstance } from "fastify";
import type { Config } from "../lib/config.js";
import type { Store } from "../lib/store.js";
import { requireAdmin } from "../lib/auth.js";
import { buildCard } from "./john.js";

export async function cardRoutes(app: FastifyInstance, opts: { config: Config; store: Store }): Promise<void> {
  const { config, store } = opts;

  const serve = async () => buildCard(config, store);
  app.get(config.john.cardPath, serve);
  // Resolver-compatible alias, mirroring InkBox's card host.
  app.get(`${config.john.cardPath}/.well-known/agent-card.json`, serve);

  app.put<{ Body: { version: 1 | 2 } }>(
    `${config.john.cardPath}/version`,
    { preHandler: requireAdmin(config) },
    async (req, reply) => {
      const version = Number(req.body?.version);
      if (version !== 1 && version !== 2) return reply.code(400).send({ error: "version must be 1 or 2" });
      store.state.card_version = version;
      store.state.card_updated_at = new Date().toISOString();
      store.save();
      return buildCard(config, store);
    },
  );
}
