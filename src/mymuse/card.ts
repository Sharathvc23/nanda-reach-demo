import type { JWK } from "jose";
import type { AgentCard, CardAgent, RoutingRule } from "../shared/card.js";
import type { MymuseConfig } from "./config.js";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  at: string;
  steps?: ToolStep[];
}

export interface ToolStep {
  tool: string;
  input: unknown;
  output: string;
  ok: boolean;
}

export interface CompanyState {
  /** The pseudonymous User ID this agent gave the Company (Poppy `sub`). */
  sub: string;
  sid: string;
  delegated_private_jwk: JWK;
  delegation: string | null;
  delegation_exp: number;
  share_locator: boolean;
}

export interface MymuseState {
  agents: CardAgent[];
  routing: RoutingRule[];
  version: number;
  updated_at: string;
  chat: ChatTurn[];
  keys: { root: JWK | null };
  companies: Record<string, CompanyState>;
}

export function freshState(config: MymuseConfig): MymuseState {
  return {
    agents: [museAgent(config)],
    routing: [{ match: "*", deliver_to: "muse" }],
    version: 1,
    updated_at: new Date().toISOString(),
    chat: [],
    keys: { root: null },
    companies: {},
  };
}

export function museAgent(config: MymuseConfig): CardAgent {
  return { id: "muse", name: config.muse.name, harness: config.muse.harness, inbox: { kind: "inkbox", address: config.muse.address }, topics: ["*"] };
}

export function wajoAgent(config: MymuseConfig, address = config.wajo.address): CardAgent {
  return { id: "wajo", name: config.wajo.name, harness: config.wajo.harness, inbox: { kind: "inkbox", address }, topics: ["travel"] };
}

/** John's agent card: the document his NANDA Index entry points at. */
export function buildCard(config: MymuseConfig, state: MymuseState): AgentCard {
  const url = `${config.publicBaseUrl}/.well-known/agent-card.json`;
  const topics = [...new Set(state.routing.map((r) => r.match).filter((m) => m !== "*"))];
  return {
    kind: "personal",
    name: "mymuse",
    description:
      state.agents.length === 1
        ? `${config.owner}'s personal agent, running on ${config.muse.harness}. Speaks the Personal Agent Protocol (Poppy) 1.0.`
        : `${config.owner}'s personal agents: ${state.agents.map((a) => a.name).join(", ")}. Routing rules decide which inbox a topic reaches.`,
    version: String(state.version),
    url,
    protocolVersion: "1.0",
    provider: { organization: `${config.owner} (personal)`, url: config.publicBaseUrl },
    supportedInterfaces: [{ url: `${config.publicBaseUrl}/chat`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        { uri: "https://nandaindex.org/extensions/inbox-routing/v1", description: "The agents and routing fields: which of the person's inboxes a message topic goes to." },
        { uri: "https://personalagentprotocol.org/docs/1.0/spec", description: "Personal Agent Protocol 1.0 client. Client metadata at /poppy/client.json." },
      ],
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      { id: "shop", name: "Shop with Poppy companies", description: "Discovers a company's poppy.json, starts a signed-out Session and uses its MCP API. Identifies the person by a pseudonymous ID, and by NANDA locator only where the person allows it.", tags: ["shopping", "travel", "poppy"] },
      { id: "receive-mail", name: "Receive messages", description: `Companies and other agents write to ${config.owner} through the inbox the routing rules pick.`, tags: ["mail", ...topics] },
    ],
    nanda: { locator: config.locator, index: config.indexBaseUrl },
    poppy: { client_id: `${config.publicBaseUrl}/poppy/client.json` },
    owner: { name: config.owner },
    chat: { url: `${config.publicBaseUrl}/chat` },
    agents: state.agents,
    routing: state.routing,
    updated_at: state.updated_at,
  };
}
