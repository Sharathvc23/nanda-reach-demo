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
 * Corroboration before every send, and the two attacks: a tampered card host and a hijacked
 * Index entry. Travel26 must refuse both and recover when the chain is restored.
 */
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

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "reach-corro-"));
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
});

afterAll(async () => {
  await Promise.all([mmApp.close(), t26App.close(), mockApp.close()]);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("corroboration", () => {
  it("the card is signed by the Poppy identity's key", async () => {
    const card = (await call(mm.publicBaseUrl, "GET", "/.well-known/agent-card.json")).body;
    const jwks = (await call(mm.publicBaseUrl, "GET", "/poppy/jwks.json")).body;
    expect(card.proof.type).toBe("JWS");
    expect(card.proof.kid).toBe(jwks.keys[0].kid);
  });

  it("agrees across five sources and sends", async () => {
    const r = (await call(t26.publicBaseUrl, "GET", "/corroborate")).body;
    expect(r.verdict).toBe("AGREE");
    expect(r.sources.map((s: any) => s.source).sort()).toEqual(["card", "inkbox", "nanda-index", "poppy-identity", "travel26"]);
    expect(r.sources.every((s: any) => s.status === "ok")).toBe(true);
    const d = await send("Baseline");
    expect(d.delivered_to.agent).toBe("muse");
    expect(d.trace).toContain("Verification: passed");
    expect(d.trace.join("\n")).not.toMatch(/corroborat/i);
  });

  it("attack 1: a tampered card host is caught by the signature and the send is held", async () => {
    await call(mm.publicBaseUrl, "POST", "/card/tamper", {});
    const card = (await call(mm.publicBaseUrl, "GET", "/.well-known/agent-card.json")).body;
    expect(card.agents[0].inbox.address).toBe(mm.attackerAddress);
    const r = (await call(t26.publicBaseUrl, "GET", "/corroborate")).body;
    expect(r.verdict).toBe("DIVERGENT");
    expect(r.findings.map((f: any) => f.kind)).toContain("key");
    const d = await send("Tampered");
    expect(d.delivered_to).toBeNull();
    // The tampered inbox is the attacker's, which also has no InkBox card, so an omission rides along with the key finding.
    expect(d.error).toMatch(/held: the locator could not be verified \(.*key.*\)/);
    await call(mm.publicBaseUrl, "POST", "/card/untamper");
    { const rr = (await call(t26.publicBaseUrl, "GET", "/corroborate")).body; expect(rr.verdict, JSON.stringify(rr.findings)).toBe("AGREE"); }
    expect((await send("Restored")).delivered_to.agent).toBe("muse");
  });

  it("attack 2: a hijacked Index entry pointing at an attacker's card is caught, and recovers", async () => {
    const status0 = (await call(mm.publicBaseUrl, "GET", "/index/status")).body;
    expect(status0.hijacked).toBe(false);
    const p = await call(mm.publicBaseUrl, "POST", "/index/point", {});
    expect(p.status).toBe(200);
    expect((await call(mm.publicBaseUrl, "GET", "/index/status")).body.hijacked).toBe(true);
    const r = (await call(t26.publicBaseUrl, "GET", "/corroborate")).body;
    expect(r.verdict).toBe("DIVERGENT");
    const kinds = r.findings.map((f: any) => f.kind);
    expect(kinds).toContain("key");
    expect(kinds).toContain("omission"); // attacker mailbox has no InkBox card
    const d = await send("Hijacked");
    expect(d.delivered_to).toBeNull();
    expect(d.error).toMatch(/held: the locator could not be verified/);
    expect(d.trace.some((t: string) => /^Verification: failed/.test(t))).toBe(true);
    await call(mm.publicBaseUrl, "POST", "/index/restore");
    expect((await call(mm.publicBaseUrl, "GET", "/index/status")).body.hijacked).toBe(false);
    { const rr = (await call(t26.publicBaseUrl, "GET", "/corroborate")).body; expect(rr.verdict, JSON.stringify(rr.findings)).toBe("AGREE"); }
    expect((await send("Recovered")).delivered_to.agent).toBe("muse");
  });

  it("the attacker's decoy card really is signed by a different key", async () => {
    const decoy = (await call(mm.publicBaseUrl, "GET", "/attacker/agent-card.json")).body;
    const jwks = (await call(mm.publicBaseUrl, "GET", "/poppy/jwks.json")).body;
    expect(decoy.nanda.locator).toBe(mm.locator);
    expect(decoy.proof.kid).not.toBe(jwks.keys[0].kid);
    expect(decoy.agents[0].inbox.address).toBe(mm.attackerAddress);
  });
});
