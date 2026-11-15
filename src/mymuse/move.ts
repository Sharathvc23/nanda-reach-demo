import type { FastifyInstance, FastifyReply } from "fastify";
import type { MymuseConfig } from "./config.js";
import type { JsonStore } from "../shared/store.js";
import { DEFAULT_CARD_PATH, MOVED_CARD_PATH, type MymuseState } from "./card.js";
import { requireAdmin } from "../shared/auth.js";

/** John moves his card to a new URL and updates his own Index entry. A merchant that saved the old URL gets 410. */
export function registerMoveControls(app: FastifyInstance, deps: { config: MymuseConfig; store: JsonStore<MymuseState> }): void {
  const { config, store } = deps;
  const admin = requireAdmin(config.adminToken);

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
    return { registry_url: body.registry_url ?? cardUrl, status: (body.extensions as Record<string, { status?: string }> | undefined)?.["org.projectnanda"]?.status ?? body.status ?? null };
  };
  const moveTo = async (path: string, reply: FastifyReply) => {
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
    return { locator: config.locator, registry_url: url, status: body.entry?.extensions?.["org.projectnanda"]?.status ?? null, own_card_url: own, card_path: store.state.card_path ?? DEFAULT_CARD_PATH, moved: (store.state.card_path ?? DEFAULT_CARD_PATH) !== DEFAULT_CARD_PATH, controllable: Boolean(config.indexAccount.email && config.indexAccount.password) };
  });
  /** Point the Index entry at wherever the card currently lives (after a host or domain change). */
  app.post("/index/restore", { preHandler: admin }, async (_req, reply) => {
    try {
      return await pointIndex(`${config.publicBaseUrl}${store.state.card_path ?? DEFAULT_CARD_PATH}`);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
