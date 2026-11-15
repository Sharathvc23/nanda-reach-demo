import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Travel26Config } from "./config.js";
import { JsonStore, newId } from "../shared/store.js";
import { requireAdmin } from "../shared/auth.js";
import { InkboxClient } from "../shared/inkbox.js";
import { LOCATOR } from "../shared/env.js";
import { PoppyError, POPPY_VERSION, REACH_EXTENSION, REACH_VERSION, SessionVerifier, audienceOf, type VerifiedSession } from "../shared/poppy.js";
import { resolveLocator } from "./resolver.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * What Travel26 keeps about a Personal Agent that shopped here: the Poppy identity (client_id and
 * the pseudonymous User ID it gave us) and, when the agent opted in through the reach extension,
 * the person's NANDA locator. No card, no address, no endpoint.
 */
export interface KnownAgent {
  client_id: string;
  client_name: string;
  sub: string;
  nanda_locator: string | null;
  first_seen: string;
  last_seen: string;
  sessions: number;
  requests: number;
  context: string;
}

export interface PromoDelivery {
  id: string;
  at: string;
  client_name: string;
  sub: string;
  locator: string | null;
  subject: string;
  card_version: string | null;
  delivered_to: { agent: string; address: string } | null;
  error: string | null;
  trace: string[];
}

interface Travel26State {
  known_agents: KnownAgent[];
  sessions: Record<string, { client_id: string; sub: string; started: string }>;
  promo_log: PromoDelivery[];
}

/** Travel26's fictional inventory. The content is beside the point; the identity handling is the point. */
export const INVENTORY = [
  { id: "T26-FLT-001", kind: "flight", title: "Boston to Lisbon, nonstop", price_usd: 489, departs: "2026-12-04" },
  { id: "T26-FLT-002", kind: "flight", title: "New York to Tokyo, one stop", price_usd: 812, departs: "2026-12-11" },
  { id: "T26-HTL-001", kind: "hotel", title: "Alfama guesthouse, 3 nights", price_usd: 360, city: "Lisbon" },
  { id: "T26-PKG-001", kind: "package", title: "Kyoto in autumn, 6 nights with rail pass", price_usd: 1990 },
];

/** The Poppy discovery document (spec section 3). Issuerless: signed-out Sessions only. */
export function poppyJson(config: Travel26Config) {
  const base = config.publicBaseUrl;
  const u = new URL(base);
  return {
    protocol_version: POPPY_VERSION,
    organization: { name: "Travel26", domain: u.host.toLowerCase() },
    apis: [{ type: "mcp", url: `${base}/mcp`, description: "Search Travel26's flights, stays and packages. Signed-out Sessions welcome." }],
    web: { disabled: true },
    extensions: {
      [REACH_EXTENSION]: [
        {
          version: REACH_VERSION,
          endpoint: `${base}/poppy/reach`,
          description:
            "Travel26 keeps only your NANDA locator, never your card, inbox address or endpoint. Give it either by declaring this extension and publishing nanda_locator in your client metadata, or by calling the share_nanda_locator tool on the MCP API. To reach you later Travel26 resolves the locator in the NANDA Index at send time and follows your card's routing rules.",
          index: config.indexBaseUrl,
          message_topics: ["travel", "promotion"],
          sender: config.address,
        },
      ],
    },
  };
}

export async function buildTravel26(config: Travel26Config): Promise<{ app: FastifyInstance; store: JsonStore<Travel26State> }> {
  const store = new JsonStore<Travel26State>(config.dataDir, "travel26.json", () => ({ known_agents: [], sessions: {}, promo_log: [] }));
  const inkbox = new InkboxClient(config.inkboxBaseUrl);
  // Built on first use so the public origin is final (tests assign the port after construction).
  let verifier: SessionVerifier | null = null;
  const getVerifier = () => (verifier ??= new SessionVerifier({ audience: audienceOf(config.publicBaseUrl), publicOrigin: config.publicBaseUrl, allowHttp: config.mode === "mock" }));
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const admin = requireAdmin(config.adminToken);

  const sendPoppyError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof PoppyError) return reply.code(e.status).send(e.body());
    app.log.error(e);
    return reply.code(500).send({ error: "server_error" });
  };

  /** Verify the Session header and record the Session and the agent (spec 5.3 step 4). */
  const verifyAndRecord = async (req: FastifyRequest, context: string): Promise<VerifiedSession> => {
    const session = await getVerifier().verify({ method: req.method, url: req.url, headers: req.headers as Record<string, string | string[] | undefined> });
    const now = new Date().toISOString();
    const key = `${session.clientId}|${session.sid}|${session.sub}`;
    const newSession = !store.state.sessions[key];
    if (newSession) store.state.sessions[key] = { client_id: session.clientId, sub: session.sub, started: now };
    const optedIn = session.extensions.get(REACH_EXTENSION) === REACH_VERSION;
    const locator = optedIn && typeof session.clientMetadata.nanda_locator === "string" && LOCATOR.test(session.clientMetadata.nanda_locator) ? session.clientMetadata.nanda_locator : null;
    let known = store.state.known_agents.find((k) => k.client_id === session.clientId && k.sub === session.sub);
    if (!known) {
      known = { client_id: session.clientId, client_name: session.clientMetadata.client_name, sub: session.sub, nanda_locator: locator, first_seen: now, last_seen: now, sessions: 0, requests: 0, context };
      store.state.known_agents.push(known);
    }
    known.last_seen = now;
    known.requests += 1;
    if (newSession) known.sessions += 1;
    if (locator) known.nanda_locator = locator;
    if (context) known.context = context;
    store.save();
    return session;
  };

  app.get("/health", async () => ({ ok: true, service: "travel26", mode: config.mode }));
  app.get("/.well-known/poppy.json", async (_req, reply) => reply.header("cache-control", "public, max-age=60").send(poppyJson(config)));
  // Issuerless Company: no authorization server (spec 3.2, foundation milestone "Without OAuth").
  app.get("/.well-known/oauth-protected-resource", async (_req, reply) => reply.code(404).send({ error: "not_found" }));
  app.get("/config", async () => ({
    service: "travel26",
    mode: config.mode,
    public_base_url: config.publicBaseUrl,
    index_base_url: config.indexBaseUrl,
    inkbox_base_url: config.inkboxBaseUrl,
    admin_required: Boolean(config.adminToken),
    address: config.address,
    poppy_url: `${config.publicBaseUrl}/.well-known/poppy.json`,
    mcp_url: `${config.publicBaseUrl}/mcp`,
  }));

  /** The MCP API listed in poppy.json. Every call carries the Session header; a new server per request (stateless). */
  app.post("/mcp", async (req, reply) => {
    let session: VerifiedSession;
    try {
      session = await verifyAndRecord(req, "");
    } catch (e) {
      return sendPoppyError(reply, e);
    }
    const server = new McpServer({ name: "travel26", version: "0.1.0" });
    server.registerTool(
      "search_inventory",
      {
        title: "Search Travel26 inventory",
        description: "Flights, stays and packages. Returns matching items with prices in USD.",
        inputSchema: { query: z.string().describe("What the person is looking for, in plain words") },
      },
      async ({ query }) => {
        const known = store.state.known_agents.find((k) => k.client_id === session.clientId && k.sub === session.sub);
        if (known) {
          known.context = query.slice(0, 200);
          store.save();
        }
        const q = query.toLowerCase();
        const items = INVENTORY.filter((i) => !q || q.split(/\W+/).some((w) => w.length > 2 && JSON.stringify(i).toLowerCase().includes(w)));
        const result = { merchant: "Travel26", session: { user: session.sub, reach: known?.nanda_locator ? "nanda" : "none" }, inventory: items.length ? items : INVENTORY };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
      },
    );
    server.registerTool(
      "share_nanda_locator",
      {
        title: "Let Travel26 reach the person later",
        description:
          "If the person you act for has a NANDA locator (urn:air:...), pass it here so Travel26 can send them offers later. Travel26 stores only the locator and resolves it in the NANDA Index at send time, so the person stays in control of where messages land through their agent card.",
        inputSchema: { nanda_locator: z.string().describe("The person's NANDA locator, e.g. urn:air:host39.org:personal:someone@inkboxmail.com") },
      },
      async ({ nanda_locator }) => {
        const locator = nanda_locator.trim();
        if (!LOCATOR.test(locator)) return { content: [{ type: "text", text: "That is not a NANDA locator (expected urn:air:...)." }], isError: true };
        const known = store.state.known_agents.find((k) => k.client_id === session.clientId && k.sub === session.sub);
        if (known) {
          known.nanda_locator = locator;
          store.save();
        }
        const result = {
          ok: true,
          stored: { nanda_locator: locator },
          not_stored: ["agent_card", "inbox_address", "endpoint_url"],
          how_we_reach_you: "resolve the locator in the NANDA Index at send time, then follow your card's routing",
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  app.get("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send({ error: "method_not_allowed" }));
  app.delete("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send({ error: "method_not_allowed" }));

  /** The reach extension endpoint named in poppy.json: documentation only; the locator travels in client metadata. */
  app.get("/poppy/reach", async () => ({
    extension: REACH_EXTENSION,
    version: REACH_VERSION,
    how: "Send Poppy-Extensions: \"nandaindex.org/reach\";v=\"1\" and publish nanda_locator in your client metadata document. Travel26 then keeps the locator, and nothing else, to reach you later through the NANDA Index.",
    stores: ["client_id", "user_id", "nanda_locator"],
    does_not_store: ["agent_card", "inbox_address", "endpoint_url"],
  }));

  app.get("/known-agents", async () => store.state.known_agents);
  app.get("/promo-log", async () => store.state.promo_log);

  /** Dry run of the resolution chain for one locator, without sending. */
  app.get<{ Querystring: { locator?: string; topics?: string } }>("/resolve", async (req, reply) => {
    const locator = req.query.locator ?? store.state.known_agents.find((k) => k.nanda_locator)?.nanda_locator;
    if (!locator) return reply.code(400).send({ error: "locator required" });
    const topics = (req.query.topics ?? "travel,promotion").split(",").map((s) => s.trim()).filter(Boolean);
    return resolveLocator(config.indexBaseUrl, locator, topics);
  });

  /** Travel26 decides to send a promotion to everyone it has met. Poppy gives it no way to; the locator does. */
  app.post<{ Body: { subject?: string; body_text?: string; topics?: string[] } }>("/promo", { preHandler: admin }, async (req) => {
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
      const entry: PromoDelivery = { id: newId("promo"), at: new Date().toISOString(), client_name: known.client_name, sub: known.sub, locator: known.nanda_locator, subject, card_version: null, delivered_to: null, error: null, trace: [] };
      try {
        if (!known.nanda_locator) throw new Error("no NANDA locator: Poppy alone gives Travel26 no way to reach this person");
        const r = await resolveLocator(config.indexBaseUrl, known.nanda_locator, topics);
        entry.trace = r.trace;
        entry.card_version = r.card?.version ?? null;
        if (!r.target) throw new Error("could not resolve the locator to an inbox");
        const sent = await inkbox.send({ address: config.address, apiKey: config.apiKey }, { to: r.target.agent.inbox.address, subject, body_text: bodyText }, entry.id);
        entry.delivered_to = { agent: r.target.agent.id, address: r.target.agent.inbox.address };
        entry.trace.push(`InkBox: sent from ${config.address} to ${r.target.agent.inbox.address}${sent.id ? ` (id ${sent.id})` : ""}`);
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
  });

  app.post("/reset", { preHandler: admin }, async () => {
    store.reset();
    return { ok: true };
  });

  await app.register(fastifyStatic, { root: join(here, "..", "..", "public", "travel26"), prefix: "/" });
  return { app, store };
}
