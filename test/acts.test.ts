import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/lib/config.js";
import { buildApp } from "../src/app.js";

/**
 * The three acts, end to end, against the in-process stand-ins for the Index and InkBox.
 * The resolver and the InkBox client go over real HTTP to the listening server, exactly as
 * they do in live mode; only the two base URLs differ.
 */
let app: FastifyInstance;
let config: Config;
let base: string;
let dataDir: string;

const json = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) => {
  const headers: Record<string, string> = { authorization: "Bearer test-admin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "reach-demo-"));
  // Listen first on a random port, then build the config around the real address.
  const probe = loadConfig({ MODE: "mock", DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin", PORT: "0" });
  const built = await buildApp(probe);
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = built.app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await built.app.close();
  base = `http://127.0.0.1:${port}`;
  config = loadConfig({ MODE: "mock", DATA_DIR: dataDir, ADMIN_TOKEN: "test-admin", PORT: String(port), PUBLIC_BASE_URL: base });
  ({ app } = await buildApp(config));
  await app.listen({ port, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the three acts", () => {
  it("serves poppy.json and an A2A-shaped card", async () => {
    const poppy = await json("GET", "/poppy.json");
    expect(poppy.status).toBe(200);
    expect(poppy.body.contact_policy.stores).toEqual(["nanda_locator"]);
    const card = await json("GET", "/cards/john");
    expect(card.body.version).toBe("1");
    expect(card.body.protocolVersion).toBe("1.0");
    expect(card.body.agents.map((a: any) => a.id)).toEqual(["muse"]);
  });

  it("act 1: Travel26 stores only the locator", async () => {
    const r = await json("POST", "/demo/act1");
    expect(r.status).toBe(200);
    expect(r.body.inventory.length).toBeGreaterThan(0);
    const known = await json("GET", "/travel26/known-agents");
    expect(known.body).toHaveLength(1);
    expect(known.body[0].locator).toBe(config.john.locator);
    expect(JSON.stringify(known.body)).not.toContain("inkboxmail");
  });

  it("rejects a non-locator", async () => {
    const r = await json("POST", "/travel26/inventory", { locator: "john@example.test" });
    expect(r.status).toBe(400);
  });

  it("act 2: with card v1 the promotion lands in Muse", async () => {
    const r = await json("POST", "/travel26/promo");
    expect(r.body.sent).toBe(1);
    const d = r.body.results[0];
    expect(d.card_version).toBe("1");
    expect(d.delivered_to.agent).toBe("muse");
    expect(d.trace.some((t: string) => t.startsWith("Index: GET"))).toBe(true);
    const muse = await json("GET", "/demo/inbox/muse");
    const wajo = await json("GET", "/demo/inbox/wajo");
    expect(muse.body.items).toHaveLength(1);
    expect(muse.body.items[0].from_address).toBe(config.travel26.address);
    expect(wajo.body.items).toHaveLength(0);
  });

  it("act 3: John publishes card v2 and Travel26 is not told", async () => {
    const before = await json("GET", "/travel26/known-agents");
    const r = await json("PUT", "/cards/john/version", { version: 2 });
    expect(r.body.version).toBe("2");
    expect(r.body.routing[0]).toMatchObject({ match: "travel", deliver_to: "wajo" });
    const after = await json("GET", "/travel26/known-agents");
    expect(after.body).toEqual(before.body);
  });

  it("act 2 again: the same locator now lands in Wajo, Muse unchanged", async () => {
    const r = await json("POST", "/travel26/promo", { subject: "Second promotion" });
    const d = r.body.results[0];
    expect(d.card_version).toBe("2");
    expect(d.delivered_to.agent).toBe("wajo");
    const muse = await json("GET", "/demo/inbox/muse");
    const wajo = await json("GET", "/demo/inbox/wajo");
    expect(muse.body.items).toHaveLength(1);
    expect(wajo.body.items).toHaveLength(1);
    expect(wajo.body.items[0].subject).toBe("Second promotion");
  });

  it("a non-travel message still goes to Muse under card v2", async () => {
    const r = await json("POST", "/travel26/promo", { subject: "Receipt", topics: ["billing"] });
    expect(r.body.results[0].delivered_to.agent).toBe("muse");
  });

  it("admin endpoints need the token", async () => {
    const res = await fetch(`${base}/travel26/promo`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("reset returns to card v1 with no known agents", async () => {
    await json("POST", "/demo/reset");
    const s = await json("GET", "/demo/state");
    expect(s.body.card.version).toBe("1");
    expect(s.body.known_agents).toEqual([]);
  });
});
