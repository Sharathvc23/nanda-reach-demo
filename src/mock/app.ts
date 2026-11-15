import Fastify, { type FastifyInstance } from "fastify";
import { newId } from "../shared/store.js";

/**
 * In-memory stand-ins for the NANDA Index resolve endpoint and the InkBox mail API, shaped like
 * the real ones. Used by the automated tests and the local all-in-one dev runner. The demo
 * itself runs against the live services.
 */
interface MockMessage {
  id: string;
  thread_id: string;
  from_address: string;
  to: string[];
  subject: string;
  body_text: string;
  snippet: string;
  created_at: string;
  is_read: boolean;
  direction: "inbound" | "outbound";
}

export interface MockApp {
  app: FastifyInstance;
  /** Register (or re-point) an Index entry: locator -> card URL. */
  seed(locator: string, cardUrl: string, displayName?: string): void;
}

export async function buildMock(): Promise<MockApp> {
  const index = new Map<string, { registry_url: string; displayName: string }>();
  const boxes = new Map<string, MockMessage[]>();
  const box = (addr: string): MockMessage[] => {
    if (!boxes.has(addr)) boxes.set(addr, []);
    return boxes.get(addr)!;
  };
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ ok: true, service: "mock" }));

  app.get<{ Querystring: { locator?: string } }>("/index/api/v1/resolve", async (req, reply) => {
    const locator = req.query.locator ?? "";
    const entry = index.get(locator);
    if (!entry) return reply.code(404).send({ error: "not found" });
    return {
      locator,
      identifier: locator,
      match: "exact",
      entry: {
        identifier: locator,
        displayName: entry.displayName,
        type: "application/a2a-agent-card+json",
        url: entry.registry_url,
        registry_url: entry.registry_url,
        publisher: { identifier: "urn:air:host39.org", displayName: "host39.org", identityType: "personal" },
        extensions: { "org.projectnanda": { resolutionRole: "agent-card", status: "active" } },
      },
    };
  });

  // InkBox agent cards for mailboxes: any handle exists except an attacker's.
  app.get<{ Params: { handle: string } }>("/inkbox/a2a/:handle/card", async (req, reply) => {
    if (/^attacker/i.test(req.params.handle)) return reply.code(404).send({ error: "not found" });
    return { name: `@${req.params.handle}`, description: "mock InkBox agent card", version: "1" };
  });

  // Index account and entry update, enough for the attack controls.
  app.post("/index/auth/login", async () => ({ token: "mock-index-token" }));
  app.put<{ Params: { id: string }; Body: { registry_url?: string } }>("/index/api/v1/orgs/:id", async (req, reply) => {
    const url = req.body?.registry_url;
    if (!url) return reply.code(400).send({ error: "registry_url required" });
    // Single-tenant mock: there is one entry, re-point it.
    for (const e of index.values()) e.registry_url = url;
    return { org_id: req.params.id, registry_url: url, status: "active", extensions: { "org.projectnanda": { status: "active" } } };
  });

  type SendBody = { recipients?: { to?: string[] }; subject?: string; body_text?: string };
  app.post<{ Params: { addr: string }; Body: SendBody }>("/inkbox/mail/mailboxes/:addr/messages", async (req, reply) => {
    if (!req.headers["x-api-key"]) return reply.code(401).send({ error: "X-API-Key required" });
    const from = decodeURIComponent(req.params.addr);
    const to = req.body?.recipients?.to ?? [];
    if (to.length === 0) return reply.code(400).send({ error: "recipients.to required" });
    const text = req.body?.body_text ?? "";
    const base = { id: newId("msg"), thread_id: newId("thr"), from_address: from, to, subject: req.body?.subject ?? "", body_text: text, snippet: text.slice(0, 120), created_at: new Date().toISOString(), is_read: false };
    box(from).push({ ...base, direction: "outbound" });
    for (const rcpt of to) box(rcpt).push({ ...base, direction: "inbound" });
    return reply.code(201).send({ id: base.id, status: "queued" });
  });

  app.get<{ Params: { addr: string }; Querystring: { direction?: string; limit?: string } }>("/inkbox/mail/mailboxes/:addr/messages", async (req, reply) => {
    if (!req.headers["x-api-key"]) return reply.code(401).send({ error: "X-API-Key required" });
    const addr = decodeURIComponent(req.params.addr);
    const dir = req.query.direction ?? "inbound";
    const limit = Number(req.query.limit ?? 50);
    const items = box(addr).filter((m) => m.direction === dir).slice(-limit).reverse();
    return { items };
  });

  app.get<{ Params: { addr: string; id: string } }>("/inkbox/mail/mailboxes/:addr/messages/:id", async (req, reply) => {
    if (!req.headers["x-api-key"]) return reply.code(401).send({ error: "X-API-Key required" });
    const m = box(decodeURIComponent(req.params.addr)).find((x) => x.id === req.params.id);
    return m ?? reply.code(404).send({ error: "not found" });
  });

  return {
    app,
    seed(locator, cardUrl, displayName = "mymuse") {
      index.set(locator, { registry_url: cardUrl, displayName });
    },
  };
}
