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

/** One request is one card version; John can decline a topic; John can move his card and only the locator still finds him. */
let mockApp: FastifyInstance;
let t26App: FastifyInstance;
let mmApp: FastifyInstance;
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
const send = async (subject: string) => (await call(t26.publicBaseUrl, "POST", "/promo", { subject })).body.results[0];
const card = async () => (await call(mm.publicBaseUrl, "GET", "/cards/john")).body;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "reach-fb-"));
  const mock = await buildMock();
  mockApp = mock.app;
  await mockApp.listen({ port: 0, host: "127.0.0.1" });
  const mockBase = `http://127.0.0.1:${portOf(mockApp)}`;
  t26 = loadTravel26Config({ MODE: "mock", MOCK_BASE_URL: mockBase, DATA_DIR: join(dataDir, "t26"), ADMIN_TOKEN: "test-admin" });
  ({ app: t26App } = await buildTravel26(t26));
  await t26App.listen({ port: 0, host: "127.0.0.1" });
  t26.publicBaseUrl = `http://127.0.0.1:${portOf(t26App)}`;
  mm = loadMymuseConfig({ MODE: "mock", MOCK_BASE_URL: mockBase, DATA_DIR: join(dataDir, "mm"), ADMIN_TOKEN: "test-admin", AGENT_BRAIN: "scripted", TRAVEL26_URL: t26.publicBaseUrl, INDEX_EMAIL: "john@test", INDEX_PASSWORD: "x" });
  ({ app: mmApp } = await buildMymuse(mm));
  await mmApp.listen({ port: 0, host: "127.0.0.1" });
  mm.publicBaseUrl = `http://127.0.0.1:${portOf(mmApp)}`;
  mock.seed(mm.locator, `${mm.publicBaseUrl}/.well-known/agent-card.json`);
  await call(mm.publicBaseUrl, "POST", "/chat", { message: "Find me flights to Lisbon on Travel26" });
  await new Promise((r) => setTimeout(r, 300)); // let Travel26 remember the card URL
});

afterAll(async () => {
  await Promise.all([mmApp.close(), t26App.close(), mockApp.close()]);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("one request, one version", () => {
  it("rerouting travel to Wajo takes the card from v1 to v2, not v3", async () => {
    expect((await card()).version).toBe("1");
    const r = await call(mm.publicBaseUrl, "POST", "/chat", { message: `I've added a second agent on Wajo at ${mm.wajo.address}. Route travel via Wajo instead of Muse.` });
    expect(r.body.steps.map((s: any) => s.tool)).toEqual(["add_agent", "set_routing", "get_my_card"]);
    expect((await card()).version).toBe("2");
  });
});

describe("declining a topic", () => {
  it("John says no to promotions; Travel26 reads it on the card and holds", async () => {
    const r = await call(mm.publicBaseUrl, "POST", "/chat", { message: "Stop sending me promotions" });
    expect(r.body.steps.map((s: any) => s.tool)).toEqual(["set_routing", "get_my_card"]);
    const c = await card();
    expect(c.version).toBe("3");
    expect(c.routing[0]).toMatchObject({ match: "promotion", deliver_to: "none" });
    const d = await send("Declined?");
    expect(d.delivered_to).toBeNull();
    expect(d.declined).toBe("promotion");
    expect(d.error).toMatch(/declines promotion/);
  });

  it("allowing promotions again restores delivery, to Wajo per the travel rule", async () => {
    await call(mm.publicBaseUrl, "POST", "/chat", { message: "Allow promotions again" });
    const c = await card();
    expect(c.routing.some((r: any) => r.deliver_to === "none")).toBe(false);
    const d = await send("Allowed again");
    expect(d.delivered_to.agent).toBe("wajo");
  });
});

describe("moving the card", () => {
  it("Travel26 remembered the card URL a naive merchant would have saved", async () => {
    const known = (await call(t26.publicBaseUrl, "GET", "/known-agents")).body[0];
    expect(known.saved_card_url).toBe(`${mm.publicBaseUrl}/.well-known/agent-card.json`);
  });

  it("after John moves his card and updates the Index, the saved URL is gone but the locator still delivers", async () => {
    const m = await call(mm.publicBaseUrl, "POST", "/card/move");
    expect(m.status).toBe(200);
    expect((await fetch(`${mm.publicBaseUrl}/.well-known/agent-card.json`)).status).toBe(410);
    expect((await fetch(`${mm.publicBaseUrl}/john/v2/agent-card.json`)).status).toBe(200);
    const status = (await call(mm.publicBaseUrl, "GET", "/index/status")).body;
    expect(status.moved).toBe(true);
    expect(status.hijacked).toBe(false);
    const corr = (await call(t26.publicBaseUrl, "GET", "/corroborate")).body;
    expect(corr.verdict).toBe("AGREE");
    const d = await send("After the move");
    expect(d.naive).toMatchObject({ ok: false, status: 410 });
    expect(d.delivered_to.agent).toBe("wajo");
    expect(d.trace.some((t: string) => /Saved-URL merchant: .* 410/.test(t))).toBe(true);
  });

  it("moving back restores the original URL", async () => {
    await call(mm.publicBaseUrl, "POST", "/card/move-back");
    expect((await fetch(`${mm.publicBaseUrl}/.well-known/agent-card.json`)).status).toBe(200);
    expect((await call(t26.publicBaseUrl, "GET", "/corroborate")).body.verdict).toBe("AGREE");
  });
});
