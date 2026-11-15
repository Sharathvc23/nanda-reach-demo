import type { FastifyInstance } from "fastify";
import type { Config } from "../lib/config.js";
import { newId, type PromoDelivery, type Store } from "../lib/store.js";
import { requireAdmin } from "../lib/auth.js";
import { resolveLocator } from "../lib/resolver.js";
import { InkboxClient } from "../lib/inkbox.js";

const LOCATOR = /^urn:air:[A-Za-z0-9][A-Za-z0-9.:_@/-]{0,299}$/;

/** Travel26's fictional inventory. The content is beside the point; the locator handling is the point. */
export const INVENTORY = [
  { id: "T26-FLT-001", kind: "flight", title: "Boston to Lisbon, nonstop", price_usd: 489, departs: "2026-12-04" },
  { id: "T26-FLT-002", kind: "flight", title: "New York to Tokyo, one stop", price_usd: 812, departs: "2026-12-11" },
  { id: "T26-HTL-001", kind: "hotel", title: "Alfama guesthouse, 3 nights", price_usd: 360, city: "Lisbon" },
  { id: "T26-PKG-001", kind: "package", title: "Kyoto in autumn, 6 nights with rail pass", price_usd: 1990 },
];

export function poppyManifest(config: Config) {
  const base = config.publicBaseUrl;
  return {
    poppy: "0.1",
    name: "Travel26",
    description: "Flights, stays and packages for agents that shop on behalf of people.",
    url: base,
    endpoints: {
      inventory: {
        method: "POST",
        url: `${base}/travel26/inventory`,
        body: { locator: "urn:air:... (your NANDA locator)", query: "optional free text" },
      },
    },
    contact_policy: {
      stores: ["nanda_locator"],
      does_not_store: ["agent_card", "inbox_address", "endpoint_url"],
      reaches_you_by:
        "resolving your locator in the NANDA Index at send time and following the routing rules on your card",
      message_topics: ["travel", "promotion"],
      sender: config.travel26.address,
    },
    nanda: { index: config.indexBaseUrl },
  };
}

export async function travel26Routes(app: FastifyInstance, opts: { config: Config; store: Store }): Promise<void> {
  const { config, store } = opts;
  const inkbox = new InkboxClient(config);

  app.get("/poppy.json", async () => poppyManifest(config));
  app.get("/travel26/poppy.json", async () => poppyManifest(config));

  /** An agent asks for inventory. Travel26 answers, and remembers only the locator. */
  app.post<{ Body: { locator?: string; query?: string } }>("/travel26/inventory", async (req, reply) => {
    const locator = String(req.body?.locator ?? "").trim();
    if (!LOCATOR.test(locator)) {
      return reply.code(400).send({ error: "body.locator must be a NANDA locator (urn:air:...)" });
    }
    const now = new Date().toISOString();
    const context = String(req.body?.query ?? "inventory request").slice(0, 200);
    const existing = store.state.known_agents.find((k) => k.locator === locator);
    if (existing) {
      existing.last_seen = now;
      existing.contacts += 1;
      existing.context = context;
    } else {
      store.state.known_agents.push({ locator, first_seen: now, last_seen: now, context, contacts: 1 });
    }
    store.save();
    return { merchant: "Travel26", stored: { locator }, inventory: INVENTORY };
  });

  app.get("/travel26/known-agents", async () => store.state.known_agents);
  app.get("/travel26/promo-log", async () => store.state.promo_log);

  /** Travel26 decides to send a promotion to everyone it has met. */
  app.post<{ Body: { subject?: string; body_text?: string; topics?: string[] } }>(
    "/travel26/promo",
    { preHandler: requireAdmin(config) },
    async (req) => {
      const subject = req.body?.subject ?? "Travel26: Lisbon in December from $489";
      const bodyText =
        req.body?.body_text ??
        [
          "Hi John, your agent asked us about flights.",
          "Nonstop Boston to Lisbon is $489 this week, and the Alfama guesthouse has three nights for $360.",
          "Reply through your agent to hold a seat.",
          "",
          "Sent by Travel26 by resolving your NANDA locator at send time.",
        ].join("\n");
      const topics = req.body?.topics ?? ["travel", "promotion"];
      const results: PromoDelivery[] = [];
      for (const known of store.state.known_agents) {
        const entry: PromoDelivery = {
          id: newId("promo"),
          at: new Date().toISOString(),
          locator: known.locator,
          subject,
          card_version: null,
          delivered_to: null,
          error: null,
          trace: [],
        };
        try {
          const r = await resolveLocator(config, known.locator, topics);
          entry.trace = r.trace;
          entry.card_version = r.card?.version ?? null;
          if (!r.target) throw new Error("could not resolve the locator to an inbox");
          const sent = await inkbox.send(
            config.travel26,
            { to: r.target.agent.inbox.address, subject, body_text: bodyText },
            entry.id,
          );
          entry.delivered_to = { agent: r.target.agent.id, address: r.target.agent.inbox.address };
          entry.trace.push(
            `InkBox: sent from ${config.travel26.address} to ${r.target.agent.inbox.address}${sent.id ? ` (id ${sent.id})` : ""}`,
          );
        } catch (e) {
          entry.error = (e as Error).message;
          entry.trace.push(`Error: ${entry.error}`);
        }
        results.push(entry);
        store.state.promo_log.unshift(entry);
      }
      store.state.promo_log = store.state.promo_log.slice(0, 50);
      store.save();
      return { sent: results.filter((r) => r.delivered_to).length, results };
    },
  );

  app.delete("/travel26/known-agents", { preHandler: requireAdmin(config) }, async () => {
    store.state.known_agents = [];
    store.state.promo_log = [];
    store.save();
    return { ok: true };
  });
}
