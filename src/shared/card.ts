/**
 * The personal agent card. A2A agent card fields first, so the NANDA Index card
 * check and generic A2A clients accept it, then what Poppy adds: the person's inboxes
 * (`agents`) and which one a message topic goes to (`routing`).
 *
 * mymuse produces it; Travel26 consumes it. Neither side needs the other's code.
 */
export interface CardAgent {
  id: string;
  name: string;
  harness: string;
  inbox: { kind: "inkbox"; address: string };
  topics: string[];
  /** The agent's Poppy client and the extensions it implements, when it has one (ACT_EXECUTOR). */
  poppy?: { client_id: string; extensions: string[] };
}

export interface RoutingRule {
  /** A topic, or "*" for everything else. First matching rule wins. */
  match: string;
  /** An agent id on the card, or "none": the person declines messages on this topic. */
  deliver_to: string;
  note?: string;
}

export const DECLINE = "none";

export interface AgentCard {
  kind: "personal";
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
  poppy: { client_id: string };
  owner: { name: string };
  chat: { url: string };
  agents: CardAgent[];
  routing: RoutingRule[];
  updated_at: string;
  /** A2A card signatures; see shared/cardsig.ts. */
  signatures?: { protected: string; signature: string }[];
}

/**
 * Pick the agent a message with these topics should go to. A rule that delivers to "none" is the
 * person declining that topic: the match is returned with no agent, and the sender must not send.
 */
export function routeCard(card: Pick<AgentCard, "agents" | "routing">, topics: string[]): { agent: CardAgent | null; rule: RoutingRule; declined: boolean } | null {
  for (const rule of card.routing) {
    if (rule.match === "*" || topics.includes(rule.match)) {
      if (rule.deliver_to === DECLINE) return { agent: null, rule, declined: true };
      const agent = card.agents.find((a) => a.id === rule.deliver_to);
      if (agent) return { agent, rule, declined: false };
    }
  }
  return null;
}
