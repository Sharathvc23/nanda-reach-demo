import type { FastifyInstance } from "fastify";
import type { Config } from "../lib/config.js";
import type { Store } from "../lib/store.js";
import { requireAdmin } from "../lib/auth.js";
import { InkboxClient } from "../lib/inkbox.js";
import { buildCard } from "../cards/john.js";
import { resolveLocator } from "../lib/resolver.js";

/**
 * Presenter-facing endpoints behind the console. Act 1 plays the part of John's Muse agent
 * calling Travel26; the inbox endpoints read John's two InkBox mailboxes so the audience can
 * watch where the promotion lands. Everything else the console does calls the real Travel26
 * and card endpoints directly.
 */
export async function demoRoutes(app: FastifyInstance, opts: { config: Config; store: Store }): Promise<void> {
  const { config, store } = opts;
  const inkbox = new InkboxClient(config);

  app.get("/demo/config", async () => ({
    mode: config.mode,
    public_base_url: config.publicBaseUrl,
    index_base_url: config.indexBaseUrl,
    inkbox_base_url: config.inkboxBaseUrl,
    admin_required: Boolean(config.adminToken),
    john: {
      locator: config.john.locator,
      card_url: `${config.publicBaseUrl}${config.john.cardPath}`,
      muse: { name: config.john.muse.name, address: config.john.muse.address },
      wajo: { name: config.john.wajo.name, address: config.john.wajo.address },
    },
    travel26: { address: config.travel26.address, poppy_url: `${config.publicBaseUrl}/poppy.json` },
  }));

  /** Act 1: John's Muse agent reads poppy.json and asks Travel26 for inventory, identifying itself by locator. */
  app.post("/demo/act1", { preHandler: requireAdmin(config) }, async () => {
    const trace: string[] = [];
    const poppyUrl = `${config.publicBaseUrl}/poppy.json`;
    trace.push(`Muse agent: GET ${poppyUrl}`);
    const poppy = await app.inject({ method: "GET", url: "/poppy.json" });
    const manifest = poppy.json() as { endpoints: { inventory: { url: string } } };
    trace.push(`Muse agent: found inventory endpoint ${manifest.endpoints.inventory.url}`);
    trace.push(`Muse agent: POST inventory with locator ${config.john.locator}`);
    const res = await app.inject({
      method: "POST",
      url: "/travel26/inventory",
      payload: { locator: config.john.locator, query: "flights from Boston in December" },
    });
    const body = res.json() as { inventory: unknown[] };
    trace.push(`Travel26: answered ${body.inventory?.length ?? 0} item(s) and stored the locator`);
    return { ok: res.statusCode === 200, trace, inventory: body.inventory };
  });

  /** Dry run of the merchant's resolution chain, without sending. Useful on stage to show the hops. */
  app.get<{ Querystring: { topics?: string } }>("/demo/resolve", async (req) => {
    const topics = (req.query.topics ?? "travel,promotion").split(",").map((s) => s.trim()).filter(Boolean);
    return resolveLocator(config, config.john.locator, topics);
  });

  app.get<{ Params: { agent: string } }>("/demo/inbox/:agent", async (req, reply) => {
    const box = req.params.agent === "muse" ? config.john.muse : req.params.agent === "wajo" ? config.john.wajo : null;
    if (!box) return reply.code(404).send({ error: "agent must be muse or wajo" });
    try {
      const items = await inkbox.listInbound(box, 20);
      return { agent: box.id, address: box.address, items };
    } catch (e) {
      return reply.code(502).send({ agent: box.id, address: box.address, error: (e as Error).message, items: [] });
    }
  });

  app.get("/demo/state", async () => ({
    card: buildCard(config, store),
    known_agents: store.state.known_agents,
    promo_log: store.state.promo_log,
  }));

  /** Back to the start: card v1, Travel26 forgets everyone. Live InkBox inboxes keep their mail. */
  app.post("/demo/reset", { preHandler: requireAdmin(config) }, async () => {
    store.reset(true);
    return { ok: true };
  });
}
