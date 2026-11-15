import type { Config } from "./config.js";
import { routeCard, type AgentCard, type CardAgent, type RoutingRule } from "../cards/john.js";

/**
 * The merchant-side resolution chain. Travel26 stores only a NANDA locator. Every time it
 * wants to reach the person it does the whole chain again, so whatever the person changed on
 * their card since last time is honoured.
 *
 *   locator  --Index resolve-->  entry.registry_url  --fetch-->  card  --routing-->  inbox
 */
export interface Resolution {
  locator: string;
  index_url: string;
  card_url: string | null;
  card: AgentCard | null;
  target: { agent: CardAgent; rule: RoutingRule } | null;
  trace: string[];
}

interface IndexResolveResponse {
  match?: string;
  identifier?: string;
  entry?: {
    url?: string;
    registry_url?: string;
    displayName?: string;
    extensions?: Record<string, { status?: string }>;
  };
}

export async function resolveLocator(config: Config, locator: string, topics: string[], fetchFn: typeof fetch = fetch): Promise<Resolution> {
  const trace: string[] = [];
  const indexUrl = `${config.indexBaseUrl}/api/v1/resolve?locator=${encodeURIComponent(locator)}`;
  const out: Resolution = { locator, index_url: indexUrl, card_url: null, card: null, target: null, trace };

  trace.push(`Index: GET ${indexUrl}`);
  const res = await fetchFn(indexUrl, { headers: { accept: "application/json", "user-agent": "travel26 poppy/0.1" }, signal: AbortSignal.timeout(10_000) });
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
  trace.push(`Card: version ${card.version}, ${card.agents?.length ?? 0} agent(s), ${card.routing?.length ?? 0} rule(s)`);
  if (!Array.isArray(card.agents) || !Array.isArray(card.routing)) {
    trace.push("Card has no agents/routing; cannot route");
    return out;
  }
  const target = routeCard(card, topics);
  if (!target) {
    trace.push(`No rule matched topics [${topics.join(", ")}]`);
    return out;
  }
  out.target = target;
  trace.push(`Route: topics [${topics.join(", ")}] -> rule "${target.rule.match}" -> ${target.agent.name} <${target.agent.inbox.address}>`);
  return out;
}
