import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { MymuseConfig } from "./config.js";
import type { JsonStore } from "../shared/store.js";
import type { InkboxClient } from "../shared/inkbox.js";
import type { MymuseState } from "./card.js";
import { AgentTools } from "./tools.js";
import type { PoppyClient } from "./poppy-client.js";

/**
 * The card host as an MCP connector, so a real personal agent (Meta's Muse, through a custom
 * connector) can manage John's agent card itself: see it, add agents, set routing, read the inbox.
 * Authenticated with the admin token as a bearer token or X-API-Key, which is what Muse's
 * secure credentials prompt sends.
 */
export function registerCardMcp(app: FastifyInstance, deps: { config: MymuseConfig; store: JsonStore<MymuseState>; inkbox: InkboxClient; poppy: PoppyClient }): void {
  const { config, store, inkbox, poppy } = deps;

  app.post("/mcp", async (req, reply) => {
    if (config.adminToken) {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.headers["x-api-key"] as string | undefined);
      if (token !== config.adminToken) return reply.code(401).header("www-authenticate", 'Bearer realm="mymuse"').send({ error: "unauthorized" });
    }
    const tools = new AgentTools(config, store, inkbox, poppy);
    const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
    const server = new McpServer({ name: "mymuse-card", version: "0.1.0" });
    server.registerTool("get_card", { title: "Read John's agent card", description: "The card John's NANDA Index entry points at: his agents (inboxes) and routing rules.", inputSchema: {} }, async () => text(tools.getMyCard()));
    server.registerTool(
      "add_agent",
      {
        title: "Add one of John's agents to the card",
        description: "Add an agent with its InkBox address and the topics it handles. Then call set_routing to send a topic to it.",
        inputSchema: {
          id: z.string().describe("Short id, e.g. wajo"),
          name: z.string().describe("Display name, e.g. John on Wajo"),
          harness: z.string().describe("The app it runs on, e.g. Wajo"),
          inbox_address: z.string().describe("Its InkBox address"),
          topics: z.array(z.string()).optional().describe('Topics it handles, e.g. ["travel"]'),
        },
      },
      async (i) => text(tools.addAgent(i)),
    );
    server.registerTool(
      "set_routing",
      {
        title: "Set the routing rules",
        description: "Replace the routing rules. Each rule maps a topic (or '*') to an agent id on the card. First match wins: put the specific topic first and '*' last. Companies that hold John's locator need no update; they resolve the card at send time.",
        inputSchema: { rules: z.array(z.object({ match: z.string(), deliver_to: z.string(), note: z.string().optional() })) },
      },
      async (i) => text(tools.setRouting(i.rules)),
    );
    server.registerTool("remove_agent", { title: "Remove an agent from the card", description: "Remove an agent other than muse, and any rule pointing at it.", inputSchema: { id: z.string() } }, async (i) => text(tools.removeAgent(i.id)));
    server.registerTool("check_inbox", { title: "Read the Muse inbox", description: "The most recent messages in John's Muse mailbox.", inputSchema: {} }, async () => text(await tools.checkInbox()));
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
}
