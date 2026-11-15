import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MymuseConfig } from "./config.js";
import { JsonStore } from "../shared/store.js";
import { requireAdmin } from "../shared/auth.js";
import { InkboxClient } from "../shared/inkbox.js";
import { buildCard, freshState, wajoAgent, type MymuseState } from "./card.js";
import { AgentTools } from "./tools.js";
import { makeBrain } from "./brain.js";
import { PoppyClient } from "./poppy-client.js";
import { registerCardMcp } from "./mcp.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildMymuse(config: MymuseConfig): Promise<{ app: FastifyInstance; store: JsonStore<MymuseState>; poppy: PoppyClient }> {
  const store = new JsonStore<MymuseState>(config.dataDir, "mymuse.json", () => freshState(config));
  const inkbox = new InkboxClient(config.inkboxBaseUrl);
  const poppy = new PoppyClient(config, store);
  await poppy.rootKey();
  const brain = makeBrain(config);
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const admin = requireAdmin(config.adminToken);

  app.get("/health", async () => ({ ok: true, service: "mymuse", mode: config.mode, brain: config.brain }));

  // John's agent card. The NANDA Index entry's registry_url points here.
  const card = async () => buildCard(config, store.state);
  app.get("/.well-known/agent-card.json", card);
  app.get("/cards/john", card);

  // Poppy Personal Agent identity (spec 4.1).
  app.get("/poppy/client.json", async (_req, reply) => reply.header("cache-control", "public, max-age=300").send(await poppy.clientMetadata()));
  app.get("/poppy/jwks.json", async (_req, reply) => reply.header("cache-control", "public, max-age=300").send(await poppy.jwks()));
  app.get("/poppy/callback", async () => ({ ok: true, note: "Direct Sign-In redirect target. This demo uses signed-out Sessions only." }));

  app.get("/config", async () => ({
    service: "mymuse",
    mode: config.mode,
    brain: config.brain,
    model: config.brain === "llm" ? config.model : null,
    public_base_url: config.publicBaseUrl,
    index_base_url: config.indexBaseUrl,
    inkbox_base_url: config.inkboxBaseUrl,
    admin_required: Boolean(config.adminToken),
    owner: config.owner,
    locator: config.locator,
    card_url: `${config.publicBaseUrl}/.well-known/agent-card.json`,
    poppy_client_id: poppy.clientId,
    card_mcp_url: `${config.publicBaseUrl}/mcp`,
    share_locator: config.shareLocator,
    muse: { name: config.muse.name, address: config.muse.address },
    wajo: { name: config.wajo.name, address: config.wajo.address },
    travel26_url: config.travel26Url,
  }));

  /** John talks to his agent. */
  app.post<{ Body: { message?: string } }>("/chat", { preHandler: admin }, async (req, reply) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return reply.code(400).send({ error: "message required" });
    const tools = new AgentTools(config, store, inkbox, poppy);
    let text: string;
    let ok = true;
    try {
      text = await brain.reply(message, store.state.chat, tools);
    } catch (e) {
      ok = false;
      text = `Something went wrong: ${(e as Error).message}`;
    }
    store.state.chat.push({ role: "user", text: message, at: new Date().toISOString() });
    store.state.chat.push({ role: "assistant", text, at: new Date().toISOString(), steps: tools.steps });
    store.state.chat = store.state.chat.slice(-40);
    store.save();
    return { ok, reply: text, steps: tools.steps, card_version: store.state.version };
  });

  app.get("/chat", async () => store.state.chat);

  /** The inbox of an agent on the card. The address comes from the card; a key is used only when this host holds one for that address. */
  app.get<{ Params: { agent: string } }>("/inbox/:agent", async (req, reply) => {
    const agent = store.state.agents.find((a) => a.id === req.params.agent);
    if (!agent) return reply.code(404).send({ error: "no such agent on the card" });
    const address = agent.inbox.address;
    const key = [config.muse, config.wajo].find((m) => m.address === address && m.apiKey)?.apiKey;
    if (!key) return { agent: agent.id, address, items: [], error: `Read in ${agent.harness}.` };
    try {
      return { agent: agent.id, address, items: await inkbox.listInbound({ address, apiKey: key }, 20) };
    } catch (e) {
      return reply.code(502).send({ agent: agent.id, address, error: (e as Error).message, items: [] });
    }
  });

  // The card as an MCP connector, for a real personal agent such as Meta's Muse.
  registerCardMcp(app, { config, store, inkbox, poppy });

  // The merchant's side, proxied so one page can show both halves of the story.
  const merchant = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${config.travel26Url}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  app.get("/merchant/state", async (_req, reply) => {
    try {
      const [known, log, cfg, reach] = await Promise.all([merchant("/known-agents"), merchant("/promo-log"), merchant("/config"), merchant("/reach")]);
      return { url: config.travel26Url, known_agents: known.body, promo_log: log.body, config: cfg.body, reach: reach.body };
    } catch (e) {
      return reply.code(502).send({ url: config.travel26Url, error: (e as Error).message, known_agents: [], promo_log: [] });
    }
  });
  app.post<{ Body: { subject?: string; body_text?: string } }>("/merchant/promo", { preHandler: admin }, async (req, reply) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    const r = await merchant("/promo", { method: "POST", headers, body: JSON.stringify(req.body ?? {}) });
    return reply.code(r.status).send(r.body);
  });
  app.post("/merchant/reset", { preHandler: admin }, async (req, reply) => {
    const headers: Record<string, string> = {};
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    const r = await merchant("/reset", { method: "POST", headers });
    return reply.code(r.status).send(r.body);
  });

  app.get("/state", async () => ({
    card: buildCard(config, store.state),
    chat: store.state.chat,
    companies: Object.fromEntries(Object.entries(store.state.companies).map(([aud, c]) => [aud, { user_id: c.sub, session_id: c.sid, share_locator: c.share_locator }])),
  }));

  /** Deterministic fallbacks for the stage: the same card changes the agent makes in chat, without the chat. */
  app.post<{ Params: { which: string } }>("/card/preset/:which", { preHandler: admin }, async (req, reply) => {
    const tools = new AgentTools(config, store, inkbox, poppy);
    if (req.params.which === "v1") {
      store.state.agents = store.state.agents.filter((a) => a.id === "muse");
      store.state.routing = [{ match: "*", deliver_to: "muse" }];
      store.state.version += 1;
      store.state.updated_at = new Date().toISOString();
      store.save();
    } else if (req.params.which === "v2") {
      const w = wajoAgent(config);
      tools.addAgent({ id: w.id, name: w.name, harness: w.harness, inbox_address: w.inbox.address, topics: w.topics });
      tools.setRouting([
        { match: "travel", deliver_to: "wajo", note: `${config.owner}: route travel related messages via Wajo instead of Muse` },
        { match: "*", deliver_to: "muse" },
      ]);
    } else return reply.code(404).send({ error: "preset must be v1 or v2" });
    return buildCard(config, store.state);
  });

  /** Back to the start. Keys are kept so the published jwks stays valid; Sessions and the card are reset. */
  app.post("/reset", { preHandler: admin }, async () => {
    const keys = store.state.keys;
    store.reset();
    store.state.keys = keys;
    store.save();
    return { ok: true };
  });

  await app.register(fastifyStatic, { root: join(here, "..", "..", "public", "mymuse"), prefix: "/" });
  return { app, store, poppy };
}
