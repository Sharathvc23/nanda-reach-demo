import type { Config } from "../lib/config.js";
import type { Store } from "../lib/store.js";

/**
 * John's agent card: the document his NANDA Index entry points at. John controls it, so he can
 * add agents and routing rules without telling any merchant. Two versions are kept so the demo
 * can flip between "Muse only" and "Muse plus Wajo, travel goes to Wajo".
 */
export interface CardAgent {
  id: string;
  name: string;
  harness: string;
  inbox: { kind: "inkbox"; address: string; card?: string };
  topics: string[];
}

export interface RoutingRule {
  /** A topic, or "*" for everything else. First matching rule wins. */
  match: string;
  deliver_to: string;
  note?: string;
}

/**
 * A2A agent card fields first, so the NANDA Index card check and generic A2A clients accept it,
 * then the two fields this demo adds: `agents` (John's inboxes) and `routing` (which one gets what).
 */
export interface AgentCard {
  name: string;
  description: string;
  version: string;
  url: string;
  protocolVersion: string;
  provider: { organization: string; url: string };
  supportedInterfaces: { url: string; protocolBinding: string; protocolVersion: string }[];
  capabilities: { streaming: boolean; pushNotifications: boolean; extensions: { uri: string; description: string }[] };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: { id: string; name: string; description: string; tags: string[] }[];
  nanda: { locator: string; index: string };
  agents: CardAgent[];
  routing: RoutingRule[];
  updated_at: string;
}

export function buildCard(config: Config, store: Store): AgentCard {
  const { john } = config;
  const v = store.state.card_version;
  const muse: CardAgent = {
    id: "muse",
    name: john.muse.name,
    harness: john.muse.harness,
    inbox: { kind: "inkbox", address: john.muse.address },
    topics: ["*"],
  };
  const wajo: CardAgent = {
    id: "wajo",
    name: john.wajo.name,
    harness: john.wajo.harness,
    inbox: { kind: "inkbox", address: john.wajo.address },
    topics: ["travel"],
  };
  const url = `${config.publicBaseUrl}${john.cardPath}`;
  return {
    name: "John",
    description:
      v === 1
        ? "John's personal agent, running on Muse."
        : "John's personal agents. Travel goes to the Wajo agent; everything else to Muse.",
    version: String(v),
    url,
    protocolVersion: "1.0",
    provider: { organization: "John (personal)", url: config.publicBaseUrl },
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: `${config.publicBaseUrl}/extensions/inbox-routing/v1`,
          description: "The agents and routing fields: which of the person's inboxes a message topic goes to.",
        },
      ],
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "receive-mail",
        name: "Receive messages",
        description: "Merchants and other agents write to John through the inbox his routing rules pick.",
        tags: v === 1 ? ["mail"] : ["mail", "travel"],
      },
    ],
    nanda: { locator: john.locator, index: config.indexBaseUrl },
    agents: v === 1 ? [muse] : [muse, wajo],
    routing:
      v === 1
        ? [{ match: "*", deliver_to: "muse" }]
        : [
            { match: "travel", deliver_to: "wajo", note: "John: route travel related messages via Wajo instead of Muse" },
            { match: "*", deliver_to: "muse" },
          ],
    updated_at: store.state.card_updated_at,
  };
}

/** Pick the agent a message with these topics should go to. */
export function routeCard(card: AgentCard, topics: string[]): { agent: CardAgent; rule: RoutingRule } | null {
  for (const rule of card.routing) {
    if (rule.match === "*" || topics.includes(rule.match)) {
      const agent = card.agents.find((a) => a.id === rule.deliver_to);
      if (agent) return { agent, rule };
    }
  }
  return null;
}
