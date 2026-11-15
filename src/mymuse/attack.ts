import type { FastifyInstance } from "fastify";
import type { MymuseConfig } from "./config.js";
import type { JsonStore } from "../shared/store.js";
import { buildCard, DEFAULT_CARD_PATH, MOVED_CARD_PATH, type MymuseState } from "./card.js";
import { signCard } from "../shared/cardproof.js";
import { generateEs256Key, type EcKey } from "../shared/poppy.js";
import { requireAdmin } from "../shared/auth.js";
import type { AgentCard } from "../shared/card.js";

/**
 * The signed card, plus the attack simulations the corroboration demo needs:
 *   - tamper: the card host serves a card whose inbox was swapped after signing
 *   - decoy: an attacker's card that claims John's locator and client_id but is signed by another key
 *   - index point / restore: John's Index entry is re-pointed at the decoy, then put back
 */
export async function signedCard(config: MymuseConfig, store: JsonStore<MymuseState>, root: EcKey): Promise<AgentCard> {
  const card = buildCard(config, store.state);
  const proof = await signCard(card as unknown as Record<string, unknown>, root.privateJwk, root.kid);
  const signed: AgentCard = { ...card, proof };
  const t = store.state.tamper;
  if (t && signed.agents.length) {
    // Swapped after signing, so the signature no longer matches: the host is lying.
    signed.agents = signed.agents.map((a, i) => (i === 0 ? { ...a, inbox: { ...a.inbox, address: t.inbox_address } } : a));
  }
  return signed;
}

export function registerAttackControls(app: FastifyInstance, deps: { config: MymuseConfig; store: JsonStore<MymuseState>; root: EcKey }): void {
  const { config, store, root } = deps;
  const admin = requireAdmin(config.adminToken);
  let attackerKey: EcKey | null = null;
  const attacker = async () => (attackerKey ??= await generateEs256Key());

  app.post<{ Body: { inbox_address?: string } }>("/card/tamper", { preHandler: admin }, async (req) => {
    store.state.tamper = { inbox_address: req.body?.inbox_address ?? config.attackerAddress };
    store.save();
    return { tampered: true, inbox_address: store.state.tamper.inbox_address };
  });
  app.post("/card/untamper", { preHandler: admin }, async () => {
    store.state.tamper = null;
    store.save();
    return { tampered: false };
  });

  /** The attacker's card: John's locator, John's client_id, the attacker's inbox, the attacker's signature. */
  app.get("/attacker/agent-card.json", async () => {
    const key = await attacker();
    const real = buildCard(config, store.state);
    const decoy: AgentCard = {
      ...real,
      name: "mymuse",
      url: `${config.publicBaseUrl}/attacker/agent-card.json`,
      agents: [{ id: "muse", name: "John on Muse", harness: "Muse", inbox: { kind: "inkbox", address: config.attackerAddress }, topics: ["*"] }],
      routing: [{ match: "*", deliver_to: "muse" }],
      version: String(Number(real.version) + 1),
      updated_at: new Date().toISOString(),
    };
    const proof = await signCard(decoy as unknown as Record<string, unknown>, key.privateJwk, key.kid);
    return { ...decoy, proof };
  });

  // John's Index entry: where it points now, re-point it, put it back.
  const indexToken = async (): Promise<string> => {
    const { email, password } = config.indexAccount;
    if (!email || !password) throw new Error("INDEX_EMAIL / INDEX_PASSWORD are not configured on this host");
    const res = await fetch(`${config.indexBaseUrl}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !body.token) throw new Error(`Index login failed: ${res.status} ${body.error ?? ""}`);
    return body.token;
  };
  const pointIndex = async (cardUrl: string) => {
    const token = await indexToken();
    const res = await fetch(`${config.indexBaseUrl}/api/v1/orgs/${encodeURIComponent(config.indexAccount.orgId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ registry_url: cardUrl }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Index update failed: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return { registry_url: body.registry_url ?? cardUrl, status: (body.extensions as any)?.["org.projectnanda"]?.status ?? body.status ?? null };
  };
  // John moves his card to a new URL and updates his Index entry. A merchant that saved the old URL gets 410.
  const moveTo = async (path: string, reply: import("fastify").FastifyReply) => {
    store.state.card_path = path;
    store.save();
    try {
      const r = await pointIndex(`${config.publicBaseUrl}${path}`);
      return { card_url: `${config.publicBaseUrl}${path}`, index: r };
    } catch (e) {
      return reply.code(502).send({ card_url: `${config.publicBaseUrl}${path}`, error: (e as Error).message });
    }
  };
  app.post("/card/move", { preHandler: admin }, async (_req, reply) => moveTo(MOVED_CARD_PATH, reply));
  app.post("/card/move-back", { preHandler: admin }, async (_req, reply) => moveTo(DEFAULT_CARD_PATH, reply));

  app.get("/index/status", async () => {
    const res = await fetch(`${config.indexBaseUrl}/api/v1/resolve?locator=${encodeURIComponent(config.locator)}`, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as { entry?: { registry_url?: string; url?: string; extensions?: Record<string, { status?: string }> } };
    const url = body.entry?.registry_url ?? body.entry?.url ?? null;
    const own = `${config.publicBaseUrl}${store.state.card_path ?? DEFAULT_CARD_PATH}`;
    return { locator: config.locator, registry_url: url, status: body.entry?.extensions?.["org.projectnanda"]?.status ?? null, hijacked: Boolean(url && url !== own), own_card_url: own, card_path: store.state.card_path ?? DEFAULT_CARD_PATH, moved: (store.state.card_path ?? DEFAULT_CARD_PATH) !== DEFAULT_CARD_PATH, controllable: Boolean(config.indexAccount.email && config.indexAccount.password) };
  });
  app.post<{ Body: { card_url?: string } }>("/index/point", { preHandler: admin }, async (req, reply) => {
    try {
      return await pointIndex(req.body?.card_url ?? `${config.publicBaseUrl}/attacker/agent-card.json`);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
  app.post("/index/restore", { preHandler: admin }, async (_req, reply) => {
    try {
      return await pointIndex(`${config.publicBaseUrl}${store.state.card_path ?? DEFAULT_CARD_PATH}`);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
