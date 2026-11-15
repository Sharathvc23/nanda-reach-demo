import type { Travel26Config } from "./config.js";
import type { KnownAgent } from "./app.js";
import { corroborate, type CorroborationReport, type SourceView } from "../shared/corroborate.js";
import { verifyCardProof } from "../shared/cardproof.js";
import { routeCard, type AgentCard } from "../shared/card.js";
import type { JWK } from "jose";

/**
 * Before Travel26 pushes anything to a locator it asks independent sources about it and sends
 * only on agreement:
 *
 *   travel26        what it saw first-hand in the Poppy session: the client_id, and the locator that client shared
 *   nanda-index     the Index entry for the locator: which card URL it points at
 *   card            the card itself: whose locator and client_id it claims, which inbox the rules pick, and its signature
 *   poppy-identity  the client metadata and keys of the identity Travel26 met, used to check the card's signature
 *   inkbox          InkBox's own card for the target mailbox: does that mailbox exist as an agent mailbox
 */
export interface CorroboratedResolution {
  report: CorroborationReport;
  card: AgentCard | null;
  card_url: string | null;
  target: { agent: string; name: string; address: string; rule: string } | null;
  /** The card declines this topic. */
  declined: string | null;
}

const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T | null; ms: number; error: string | null }> => {
  const t0 = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - t0, error: null };
  } catch (e) {
    return { value: null, ms: Date.now() - t0, error: (e as Error).message };
  }
};

const getJson = async (fetchFn: typeof fetch, url: string): Promise<{ status: number; body: any }> => {
  const res = await fetchFn(url, { headers: { accept: "application/json", "user-agent": "travel26/0.1 corroboration" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
};

export async function corroborateLocator(config: Travel26Config, known: Pick<KnownAgent, "client_id" | "nanda_locator">, topics: string[], fetchFn: typeof fetch = fetch): Promise<CorroboratedResolution> {
  const locator = known.nanda_locator!;
  const views: SourceView[] = [];
  const out: CorroboratedResolution = { report: null as unknown as CorroborationReport, card: null, card_url: null, target: null, declined: null };

  // First-hand: what the Poppy session told us. The expectation that the card is signed by that identity is a claim too.
  views.push({ source: "travel26", status: "ok", claims: { locator, client_id: known.client_id, signature: "valid" }, detail: "from the Poppy session" });

  // The Index.
  const idx = await timed(() => getJson(fetchFn, `${config.indexBaseUrl}/api/v1/resolve?locator=${encodeURIComponent(locator)}`));
  const entry = idx.value?.body?.entry;
  const indexStatus = entry?.extensions?.["org.projectnanda"]?.status;
  const cardUrl: string | null = entry?.registry_url ?? entry?.url ?? null;
  if (idx.error) views.push({ source: "nanda-index", status: "unreachable", claims: {}, detail: idx.error, ms: idx.ms });
  else if (!idx.value || idx.value.status !== 200 || !cardUrl) views.push({ source: "nanda-index", status: "not_found", claims: {}, detail: `HTTP ${idx.value?.status ?? "?"}`, ms: idx.ms });
  else views.push({ source: "nanda-index", status: indexStatus === "active" ? "ok" : "not_found", claims: { locator: entry.identifier ?? locator, card_url: cardUrl }, detail: `entry ${indexStatus ?? "?"} → ${cardUrl}`, ms: idx.ms });
  out.card_url = cardUrl;

  // The identity we met: its keys.
  const meta = await timed(() => getJson(fetchFn, known.client_id));
  let jwks: { keys: JWK[] } | null = null;
  if (meta.value?.status === 200 && meta.value.body?.jwks_uri) {
    const j = await timed(() => getJson(fetchFn, meta.value!.body.jwks_uri));
    if (j.value?.status === 200 && Array.isArray(j.value.body?.keys)) jwks = j.value.body;
    views.push({ source: "poppy-identity", status: jwks ? "ok" : "unreachable", claims: { client_id: meta.value.body.client_id ?? known.client_id }, detail: jwks ? `${jwks.keys.length} key(s) at jwks_uri` : "jwks unreachable", ms: meta.ms + (j.ms ?? 0) });
  } else views.push({ source: "poppy-identity", status: meta.error ? "unreachable" : "not_found", claims: {}, detail: meta.error ?? `client metadata HTTP ${meta.value?.status ?? "?"}`, ms: meta.ms });

  // The card.
  let card: AgentCard | null = null;
  if (cardUrl) {
    const c = await timed(() => getJson(fetchFn, cardUrl));
    if (c.error) views.push({ source: "card", status: "unreachable", claims: {}, detail: c.error, ms: c.ms });
    else if (c.value?.status !== 200 || !c.value.body) views.push({ source: "card", status: "not_found", claims: {}, detail: `HTTP ${c.value?.status ?? "?"}`, ms: c.ms });
    else {
      card = c.value.body as AgentCard;
      out.card = card;
      const routed = Array.isArray(card.agents) && Array.isArray(card.routing) ? routeCard(card, topics) : null;
      if (routed?.declined) out.declined = routed.rule.match;
      else if (routed?.agent) out.target = { agent: routed.agent.id, name: routed.agent.name, address: routed.agent.inbox.address, rule: routed.rule.match };
      const sig = jwks ? await verifyCardProof(card as unknown as Record<string, unknown>, jwks) : { ok: false as const, reason: "identity keys unavailable" };
      views.push({
        source: "card",
        status: "ok",
        claims: { card_url: card.url ?? cardUrl, locator: card.nanda?.locator ?? null, client_id: card.poppy?.client_id ?? null, signature: sig.ok ? "valid" : `invalid: ${sig.reason}`, inbox: out.target?.address ?? null, version: card.version ?? null },
        detail: `v${card.version ?? "?"}, signature ${sig.ok ? `valid (kid ${sig.kid.slice(0, 8)}…)` : sig.reason}`,
        ms: c.ms,
      });
    }
  }

  // InkBox's own card for the target mailbox.
  if (out.target) {
    const handle = out.target.address.split("@")[0];
    const ib = await timed(() => getJson(fetchFn, `${config.inkboxA2aBase}/a2a/${encodeURIComponent(handle)}/card`));
    if (ib.error) views.push({ source: "inkbox", status: "unreachable", claims: {}, detail: ib.error, ms: ib.ms });
    else if (ib.value?.status === 200) views.push({ source: "inkbox", status: "ok", claims: { inbox: out.target.address }, detail: `mailbox ${handle} exists (${ib.value.body?.name ?? "card"})`, ms: ib.ms });
    else views.push({ source: "inkbox", status: "not_found", claims: {}, detail: `no agent card for ${handle} (HTTP ${ib.value?.status ?? "?"})`, ms: ib.ms });
  }

  out.report = corroborate(locator, views, { required: out.declined ? ["nanda-index", "card"] : ["nanda-index", "card", "inkbox"] });
  return out;
}
