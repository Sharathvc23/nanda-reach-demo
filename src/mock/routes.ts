import type { FastifyInstance } from "fastify";
import type { Config } from "../lib/config.js";
import { newId, type MockMessage, type Store } from "../lib/store.js";

/**
 * Stand-ins for the NANDA Index resolve endpoint and the InkBox mail API, shaped like the real
 * ones. Mounted only when MODE=mock, which the automated tests use. The demo itself runs live.
 */
export async function mockRoutes(app: FastifyInstance, opts: { config: Config; store: Store }): Promise<void> {
  const { config, store } = opts;
  const index = store.state.mock_index;
  const boxes = store.state.mock_messages;

  // Seed John's Index entry pointing at his card, as a real registration would. Always rewritten
  // so a stale public base URL from an earlier run never survives.
  index[config.john.locator] = {
    identifier: config.john.locator,
    displayName: "John",
    registry_url: `${config.publicBaseUrl}${config.john.cardPath}`,
    status: "active",
  };
  store.save();

  app.get<{ Querystring: { locator?: string } }>("/mock/index/api/v1/resolve", async (req, reply) => {
    const entry = index[req.query.locator ?? ""];
    if (!entry) return reply.code(404).send({ error: "not found" });
    return {
      locator: entry.identifier,
      identifier: entry.identifier,
      match: "exact",
      entry: {
        identifier: entry.identifier,
        displayName: entry.displayName,
        type: "application/a2a-agent-card+json",
        url: entry.registry_url,
        registry_url: entry.registry_url,
        publisher: { identifier: "urn:air:host39.org", displayName: "host39.org", identityType: "personal" },
        extensions: { "org.projectnanda": { resolutionRole: "agent-card", status: entry.status } },
      },
    };
  });

  const box = (addr: string): MockMessage[] => (boxes[addr] ??= []);

  type SendBody = { recipients?: { to?: string[] }; subject?: string; body_text?: string };
  app.post<{ Params: { addr: string }; Body: SendBody }>(
    "/mock/inkbox/mail/mailboxes/:addr/messages",
    async (req, reply) => {
      if (!req.headers["x-api-key"]) return reply.code(401).send({ error: "X-API-Key required" });
      const from = decodeURIComponent(req.params.addr);
      const to = req.body?.recipients?.to ?? [];
      if (to.length === 0) return reply.code(400).send({ error: "recipients.to required" });
      const id = newId("msg");
      const text = req.body?.body_text ?? "";
      const base = {
        id,
        thread_id: newId("thr"),
        from_address: from,
        to,
        subject: req.body?.subject ?? "",
        body_text: text,
        snippet: text.slice(0, 120),
        created_at: new Date().toISOString(),
        is_read: false,
      };
      box(from).push({ ...base, direction: "outbound" });
      for (const rcpt of to) box(rcpt).push({ ...base, direction: "inbound" });
      store.save();
      return reply.code(201).send({ id, status: "queued" });
    },
  );

  app.get<{ Params: { addr: string }; Querystring: { direction?: string; limit?: string } }>(
    "/mock/inkbox/mail/mailboxes/:addr/messages",
    async (req, reply) => {
      if (!req.headers["x-api-key"]) return reply.code(401).send({ error: "X-API-Key required" });
      const addr = decodeURIComponent(req.params.addr);
      const dir = req.query.direction ?? "inbound";
      const limit = Number(req.query.limit ?? 50);
      const items = box(addr)
        .filter((m) => m.direction === dir)
        .slice(-limit)
        .reverse();
      return { items };
    },
  );
}
