import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildMock } from "../src/mock/app.js";
import { loadTravel26Config, type Travel26Config } from "../src/travel26/config.js";
import { buildTravel26 } from "../src/travel26/app.js";
import { loadMymuseConfig, type MymuseConfig } from "../src/mymuse/config.js";
import { buildMymuse } from "../src/mymuse/app.js";

/**
 * The three acts across the two real services, with the mock Index and InkBox in between.
 * Travel26 and mymuse talk to each other and to the mocks over real HTTP, exactly as in live
 * mode; only the base URLs differ. The agent runs its scripted brain, so no API key is needed.
 */
let mockApp: FastifyInstance;
let t26App: FastifyInstance;
let mmApp: FastifyInstance;
let mmPoppy: import("../src/mymuse/poppy-client.js").PoppyClient;
let t26: Travel26Config;
let mm: MymuseConfig;
let dataDir: string;

const portOf = (app: FastifyInstance): number => {
  const a = app.server.address();
  return typeof a === "object" && a ? a.port : 0;
};

const call = async (base: string, method: "GET" | "POST", url: string, body?: unknown) => {
  const headers: Record<string, string> = { authorization: "Bearer test-admin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "reach-demo-"));
  const mock = await buildMock();
  mockApp = mock.app;
  await mockApp.listen({ port: 0, host: "127.0.0.1" });
  const mockBase = `http://127.0.0.1:${portOf(mockApp)}`;

  t26 = loadTravel26Config({ MODE: "mock", MOCK_BASE_URL: mockBase, DATA_DIR: join(dataDir, "t26"), ADMIN_TOKEN: "test-admin" });
  ({ app: t26App } = await buildTravel26(t26));
  await t26App.listen({ port: 0, host: "127.0.0.1" });
  t26.publicBaseUrl = `http://127.0.0.1:${portOf(t26App)}`;

  mm = loadMymuseConfig({ MODE: "mock", MOCK_BASE_URL: mockBase, DATA_DIR: join(dataDir, "mm"), ADMIN_TOKEN: "test-admin", AGENT_BRAIN: "scripted", TRAVEL26_URL: t26.publicBaseUrl });
  ({ app: mmApp, poppy: mmPoppy } = await buildMymuse(mm));
  await mmApp.listen({ port: 0, host: "127.0.0.1" });
  mm.publicBaseUrl = `http://127.0.0.1:${portOf(mmApp)}`;

  mock.seed(mm.locator, `${mm.publicBaseUrl}/.well-known/agent-card.json`);
});

afterAll(async () => {
  await Promise.all([mmApp.close(), t26App.close(), mockApp.close()]);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the three acts", () => {
  it("Travel26 publishes poppy.json and mymuse publishes its identity and card", async () => {
    const poppy = await call(t26.publicBaseUrl, "GET", "/.well-known/poppy.json");
    expect(poppy.body.protocol_version).toBe("1.0");
    expect(poppy.body.organization.domain).toBe(new URL(t26.publicBaseUrl).host);
    expect(poppy.body.apis[0].type).toBe("mcp");
    expect(poppy.body.extensions["nandaindex.org/reach"][0].version).toBe("1");
    const prm = await fetch(`${t26.publicBaseUrl}/.well-known/oauth-protected-resource`);
    expect(prm.status).toBe(404);
    const client = await call(mm.publicBaseUrl, "GET", "/poppy/client.json");
    expect(client.body.client_id).toBe(`${mm.publicBaseUrl}/poppy/client.json`);
    expect(client.body.token_endpoint_auth_method).toBe("private_key_jwt");
    expect(client.body.nanda_locator).toBe(mm.locator);
    const jwks = await call(mm.publicBaseUrl, "GET", "/poppy/jwks.json");
    expect(jwks.body.keys[0].kty).toBe("EC");
    expect(jwks.body.keys[0].d).toBeUndefined();
    const card = await call(mm.publicBaseUrl, "GET", "/.well-known/agent-card.json");
    expect(card.body.kind).toBe("personal");
    expect(card.body.version).toBe("1");
    expect(card.body.protocolVersion).toBe("1.0");
    expect(card.body.agents.map((a: any) => a.id)).toEqual(["muse"]);
    expect(card.body.nanda.locator).toBe(mm.locator);
  });

  it("Travel26 refuses MCP calls without a verified Poppy Session", async () => {
    const noHeaders = await fetch(`${t26.publicBaseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(noHeaders.status).toBe(400);
    expect(((await noHeaders.json()) as any).error).toBe("version_unsupported");
    const noSession = await fetch(`${t26.publicBaseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", "poppy-version": "1.0" }, body: "{}" });
    expect(noSession.status).toBe(400);
    expect(((await noSession.json()) as any).error).toBe("invalid_session");
    const forged = await fetch(`${t26.publicBaseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", "poppy-version": "1.0", "poppy-session": "eyJhbGciOiJFUzI1NiJ9.e30.c2ln" }, body: "{}" });
    expect(forged.status).toBe(400);
  });

  it("act 1: John asks mymuse to shop; Travel26 stores only the locator", async () => {
    const r = await call(mm.publicBaseUrl, "POST", "/chat", { message: "Find me flights to Lisbon in December on Travel26" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.steps.map((s: any) => s.tool)).toEqual(["discover_company", "shop_with_company"]);
    expect(r.body.reply).toMatch(/Lisbon/);
    const known = await call(t26.publicBaseUrl, "GET", "/known-agents");
    expect(known.body).toHaveLength(1);
    expect(known.body[0].client_id).toBe(`${mm.publicBaseUrl}/poppy/client.json`);
    expect(known.body[0].client_name).toBe("mymuse");
    expect(known.body[0].sub).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(known.body[0].nanda_locator).toBe(mm.locator);
    expect(known.body[0].context).toMatch(/Lisbon/);
    // The locator is derived from the Muse address by NANDA's own rule; nothing else about the inboxes is stored.
    expect(Object.keys(known.body[0])).not.toEqual(expect.arrayContaining(["address", "inbox", "card"]));
    expect(JSON.stringify(known.body)).not.toContain(mm.wajo.address);
    expect(JSON.stringify(known.body)).not.toContain("routing");
  });

  it("a second shop reuses the same Poppy Session and User ID", async () => {
    const before = (await call(t26.publicBaseUrl, "GET", "/known-agents")).body[0];
    await call(mm.publicBaseUrl, "POST", "/chat", { message: "Any hotels in Lisbon?" });
    const after = (await call(t26.publicBaseUrl, "GET", "/known-agents")).body;
    expect(after).toHaveLength(1);
    expect(after[0].sub).toBe(before.sub);
    expect(after[0].sessions).toBe(1);
    expect(after[0].requests).toBeGreaterThan(before.requests);
  });

  it("act 2: with card v1 the promotion lands in Muse", async () => {
    const r = await call(t26.publicBaseUrl, "POST", "/promo");
    expect(r.body.sent).toBe(1);
    const d = r.body.results[0];
    expect(d.card_version).toBe("1");
    expect(d.delivered_to.agent).toBe("muse");
    expect(d.trace.some((t: string) => t.startsWith("Index: GET"))).toBe(true);
    const muse = await call(mm.publicBaseUrl, "GET", "/inbox/muse");
    const wajo = await call(mm.publicBaseUrl, "GET", "/inbox/wajo");
    expect(muse.body.items).toHaveLength(1);
    expect(muse.body.items[0].from_address).toBe(t26.address);
    // Wajo is not on the card yet, so it has no inbox here.
    expect(wajo.status).toBe(404);
  });

  it("mymuse can read the promotion from its own inbox", async () => {
    const r = await call(mm.publicBaseUrl, "POST", "/chat", { message: "Check my inbox" });
    expect(r.body.steps.map((s: any) => s.tool)).toEqual(["check_inbox"]);
    expect(r.body.reply).toMatch(/Lisbon/);
  });

  it("act 3: John tells mymuse to route travel via Wajo; Travel26 is not told", async () => {
    const before = await call(t26.publicBaseUrl, "GET", "/known-agents");
    const r = await call(mm.publicBaseUrl, "POST", "/chat", { message: `I've added a second agent on Wajo at ${mm.wajo.address}. Route travel related messages via Wajo instead of Muse.` });
    expect(r.body.steps.map((s: any) => s.tool)).toEqual(["add_agent", "set_routing", "get_my_card"]);
    const card = await call(mm.publicBaseUrl, "GET", "/.well-known/agent-card.json");
    expect(card.body.agents.map((a: any) => a.id)).toEqual(["muse", "wajo"]);
    expect(card.body.routing[0]).toMatchObject({ match: "travel", deliver_to: "wajo" });
    expect(Number(card.body.version)).toBeGreaterThan(1);
    const after = await call(t26.publicBaseUrl, "GET", "/known-agents");
    expect(after.body).toEqual(before.body);
  });

  it("act 2 again: the same locator now lands in Wajo, Muse unchanged", async () => {
    const r = await call(t26.publicBaseUrl, "POST", "/promo", { subject: "Second promotion" });
    const d = r.body.results[0];
    expect(d.delivered_to.agent).toBe("wajo");
    expect(d.trace.join("\n")).toMatch(/rule "travel"/);
    const muse = await call(mm.publicBaseUrl, "GET", "/inbox/muse");
    const wajo = await call(mm.publicBaseUrl, "GET", "/inbox/wajo");
    expect(muse.body.items).toHaveLength(1);
    expect(wajo.body.items).toHaveLength(1);
    expect(wajo.body.items[0].subject).toBe("Second promotion");
  });

  it("a non-travel message still goes to Muse under the new card", async () => {
    const r = await call(t26.publicBaseUrl, "POST", "/promo", { subject: "Receipt", topics: ["billing"] });
    expect(r.body.results[0].delivered_to.agent).toBe("muse");
  });

  it("a personal agent without the extension can hand over the locator through the MCP tool", async () => {
    const doc = await mmPoppy.discover(t26.publicBaseUrl);
    const r = await mmPoppy.callMcpTool(doc, `${t26.publicBaseUrl}/mcp`, "share_nanda_locator", { nanda_locator: mm.locator });
    expect((r.structured as any).stored.nanda_locator).toBe(mm.locator);
    const bad = await mmPoppy.callMcpTool(doc, `${t26.publicBaseUrl}/mcp`, "share_nanda_locator", { nanda_locator: "not-a-locator" }).catch((e: Error) => e.message);
    expect(String(bad)).toMatch(/not a NANDA locator/);
  });

  it("the card host is an MCP connector a real Muse can drive", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const unauth = await fetch(`${mm.publicBaseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauth.status).toBe(401);
    const client = new Client({ name: "muse-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mm.publicBaseUrl}/mcp`), { requestInit: { headers: { authorization: "Bearer test-admin" } } }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["add_agent", "check_inbox", "get_card", "remove_agent", "set_routing"]);
    const card = await client.callTool({ name: "get_card", arguments: {} });
    expect(JSON.stringify(card.content)).toContain("routing");
    await client.close();
  });

  it("act 4: John routes travel back to Muse; Wajo stays on the card", async () => {
    const r = await call(mm.publicBaseUrl, "POST", "/chat", { message: "Route travel messages back to Muse. Keep Wajo on my card." });
    expect(r.body.steps.map((s: any) => s.tool)).toEqual(["set_routing", "get_my_card"]);
    const card = await call(mm.publicBaseUrl, "GET", "/.well-known/agent-card.json");
    expect(card.body.routing).toEqual([expect.objectContaining({ match: "*", deliver_to: "muse" })]);
    expect(card.body.agents.map((a: any) => a.id)).toEqual(["muse", "wajo"]);
    const send = await call(t26.publicBaseUrl, "POST", "/promo", { subject: "Back to Muse" });
    expect(send.body.results[0].delivered_to.agent).toBe("muse");
  });

  it("admin endpoints need the token", async () => {
    expect((await fetch(`${t26.publicBaseUrl}/promo`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${mm.publicBaseUrl}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) })).status).toBe(401);
  });

  it("reset returns both services to the start", async () => {
    await call(mm.publicBaseUrl, "POST", "/reset");
    await call(t26.publicBaseUrl, "POST", "/reset");
    const card = await call(mm.publicBaseUrl, "GET", "/.well-known/agent-card.json");
    expect(card.body.version).toBe("1");
    expect(card.body.agents).toHaveLength(1);
    const known = await call(t26.publicBaseUrl, "GET", "/known-agents");
    expect(known.body).toEqual([]);
  });
});
