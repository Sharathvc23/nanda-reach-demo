import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMymuseConfig } from "../src/mymuse/config.js";
import { buildMymuse } from "../src/mymuse/app.js";
import { verifyCard } from "../src/shared/cardsig.js";

/**
 * mymuse as a continuity executor for act.stellarminds.ai is off unless ACT_EXECUTOR=1. Off, the
 * reach demo is unchanged; on, John on Wajo gets a Poppy client at /wajo, the card names each
 * agent's Poppy client, and the control channel answers only with its token.
 */
const dirs: string[] = [];
const build = async (extra: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "reach-act-"));
  dirs.push(dir);
  const config = loadMymuseConfig({ MODE: "mock", DATA_DIR: dir, ADMIN_TOKEN: "test-admin", AGENT_BRAIN: "scripted", PUBLIC_BASE_URL: "https://mymuse.example", ...extra });
  return { config, ...(await buildMymuse(config)) };
};

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("ACT executor switch", () => {
  it("off by default: no Wajo client, no control channel, an unchanged card and callback", async () => {
    const { app, config } = await build({});
    expect(config.act).toBeNull();
    expect((await app.inject({ method: "GET", url: "/wajo/poppy/client.json" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/act/control/muse/grantView", payload: {} })).statusCode).toBe(404);
    const card = (await app.inject({ method: "GET", url: "/.well-known/agent-card.json" })).json() as { agents: Record<string, unknown>[] };
    expect(card.agents.every((a) => a.poppy === undefined)).toBe(true);
    expect((await app.inject({ method: "GET", url: "/poppy/callback" })).json()).toMatchObject({ ok: true });
    await app.close();
  });

  it("on: Wajo's Poppy client, Poppy clients on the signed card, a token-only control channel", async () => {
    const { app, store } = await build({ ACT_EXECUTOR: "1", ACT_CONTROL_TOKEN: "control", ACT_COMPANIES: "https://travel26-act.example" });
    const wajo = (await app.inject({ method: "GET", url: "/wajo/poppy/client.json" })).json() as Record<string, unknown>;
    expect(wajo).toMatchObject({ client_id: "https://mymuse.example/wajo/poppy/client.json", jwks_uri: "https://mymuse.example/wajo/poppy/jwks.json", token_endpoint_auth_method: "private_key_jwt" });
    const keys = (await app.inject({ method: "GET", url: "/wajo/poppy/jwks.json" })).json() as { keys: { kid: string }[] };
    const museKeys = (await app.inject({ method: "GET", url: "/poppy/jwks.json" })).json() as { keys: { kid: string }[] };
    expect(keys.keys[0].kid).not.toBe(museKeys.keys[0].kid);
    expect(store.state.keys.wajo).toBeTruthy();

    // John's card lists Muse (and Wajo, once John adds him) with their Poppy clients.
    await app.inject({ method: "POST", url: "/card/preset/v2", headers: { authorization: "Bearer test-admin" } });
    const raw = (await app.inject({ method: "GET", url: "/.well-known/agent-card.json" })).json() as Record<string, unknown> & { agents: { id: string; poppy?: { client_id: string; extensions: string[] } }[] };
    expect(raw.agents.find((a) => a.id === "muse")?.poppy?.client_id).toBe("https://mymuse.example/poppy/client.json");
    expect(raw.agents.find((a) => a.id === "wajo")?.poppy?.client_id).toBe("https://mymuse.example/wajo/poppy/client.json");
    expect(raw.agents.every((a) => a.poppy?.extensions.includes("stellarminds.ai/act-continuity;v=1"))).toBe(true);
    // The card is still signed over everything, Poppy clients included.
    const sig = await verifyCard(raw, "https://mymuse.example/.well-known/agent-card.json", (async (url: string) => {
      const res = await app.inject({ method: "GET", url: new URL(url).pathname });
      return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    expect(sig.status).toBe("valid");

    expect((await app.inject({ method: "POST", url: "/act/control/muse/grantView", payload: {} })).statusCode).toBe(404);
    const refused = await app.inject({ method: "POST", url: "/act/control/muse/discover", headers: { authorization: "Bearer control" }, payload: { run: "abcdef12", owner: "https://act.stellarminds.ai/runs/abcdef12/owner", args: ["https://elsewhere.example"] } });
    expect(refused.json()).toMatchObject({ ok: false });
    expect((refused.json() as { error: { message: string } }).error.message).toMatch(/allowlist/);
    const callback = await app.inject({ method: "GET", url: "/poppy/callback?state=nobody&code=x" });
    expect(callback.statusCode).toBe(400);
    await app.close();
  });
});
