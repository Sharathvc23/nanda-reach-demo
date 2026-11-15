import { routeCard, type AgentCard, type CardAgent, type RoutingRule } from "../shared/card.js";

/**
 * The merchant-side resolution chain. Travel26 stores only a NANDA locator. Every time it wants
 * to reach the person it runs the whole chain again, so whatever the person changed on their
 * card since last time is honoured.
 *
 *   locator  --Index resolve-->  entry.registry_url  --fetch-->  card  --routing-->  inbox
 */
export interface Resolution {
  locator: string;
  index_url: string;
  card_url: string | null;
  card: AgentCard | null;
  target: { agent: CardAgent; rule: RoutingRule } | null;
  /** The card declines this topic: no delivery, and that is the person's choice, not a failure. */
  declined: RoutingRule | null;
  trace: string[];
}

interface IndexResolveResponse {
  match?: string;
  entry?: { url?: string; registry_url?: string; extensions?: Record<string, { status?: string }> };
}

export async function resolveLocator(indexBaseUrl: string, locator: string, topics: string[], fetchFn: typeof fetch = fetch): Promise<Resolution> {
  const trace: string[] = [];
  const indexUrl = `${indexBaseUrl}/api/v1/resolve?locator=${encodeURIComponent(locator)}`;
  const out: Resolution = { locator, index_url: indexUrl, card_url: null, card: null, target: null, declined: null, trace };

  trace.push(`Index: GET ${indexUrl}`);
  const res = await fetchFn(indexUrl, { headers: { accept: "application/json", "user-agent": "travel26/0.1" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    trace.push(`Index answered ${res.status}`);
    return out;
  }
  const doc = (await res.json()) as IndexResolveResponse;
  const status = doc.entry?.extensions?.["org.projectnanda"]?.status;
  const cardUrl = doc.entry?.registry_url ?? doc.entry?.url ?? null;
  trace.push(`Index: match=${doc.match ?? "?"} status=${status ?? "?"} card=${cardUrl ?? "none"}`);
  if (!cardUrl) return out;
  out.card_url = cardUrl;

  trace.push(`Card: GET ${cardUrl}`);
  const cres = await fetchFn(cardUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!cres.ok) {
    trace.push(`Card host answered ${cres.status}`);
    return out;
  }
  const card = (await cres.json()) as AgentCard;
  out.card = card;
  if (!Array.isArray(card.agents) || !Array.isArray(card.routing)) {
    trace.push("Card has no agents/routing fields; cannot route");
    return out;
  }
  trace.push(`Card: version ${card.version}, ${card.agents.length} agent(s), ${card.routing.length} rule(s)`);
  const routed = routeCard(card, topics);
  if (!routed) {
    trace.push(`No rule matched topics [${topics.join(", ")}]`);
    return out;
  }
  if (routed.declined || !routed.agent) {
    out.declined = routed.rule;
    trace.push(`Route: topics [${topics.join(", ")}] -> rule "${routed.rule.match}" -> declined by the card`);
    return out;
  }
  out.target = { agent: routed.agent, rule: routed.rule };
  trace.push(`Route: topics [${topics.join(", ")}] -> rule "${routed.rule.match}" -> ${routed.agent.name} <${routed.agent.inbox.address}>`);
  return out;
}
