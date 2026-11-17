import { describe, expect, it } from "vitest";
import { canonicalize, signCard, verifyCard } from "../src/shared/cardsig.js";
import { generateEs256Key } from "../src/shared/poppy.js";

const CARD_URL = "https://mymuse.example/.well-known/agent-card.json";
const JKU = "https://mymuse.example/poppy/jwks.json";

const card = () => ({
  name: "mymuse",
  version: "3",
  agents: [{ id: "muse", name: "John on Muse", inbox: { kind: "inkbox", address: "john@inbox.example" }, topics: ["*"] }],
  routing: [{ match: "travel", deliver_to: "muse" }],
  capabilities: { streaming: false, pushNotifications: false },
});

/** A fetch that serves only the given key set at the given URL. */
const serving = (url: string, jwks: unknown): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    if (String(input) === url) return new Response(JSON.stringify(jwks), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

describe("agent card signatures", () => {
  it("canonicalizes like RFC 8785 for plain JSON", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  });

  it("a signed card verifies against the key set on its own host", async () => {
    const key = await generateEs256Key();
    const signed = await signCard(card(), key, JKU);
    const res = await verifyCard(signed, CARD_URL, serving(JKU, { keys: [key.publicJwk] }));
    expect(res.status).toBe("valid");
  });

  it("rejects a card whose routing was changed after signing", async () => {
    const key = await generateEs256Key();
    const signed = await signCard(card(), key, JKU);
    signed.agents[0].inbox.address = "attacker@inbox.example";
    expect((await verifyCard(signed, CARD_URL, serving(JKU, { keys: [key.publicJwk] }))).status).toBe("invalid");
  });

  it("ignores a key set hosted anywhere but the card's host", async () => {
    const attacker = await generateEs256Key();
    const evilJku = "https://attacker.example/jwks.json";
    const forged = await signCard({ ...card(), routing: [{ match: "*", deliver_to: "muse" }] }, attacker, evilJku);
    const res = await verifyCard(forged, CARD_URL, serving(evilJku, { keys: [attacker.publicJwk] }));
    expect(res.status).toBe("invalid");
  });

  it("rejects a signature from a key that is not in the published set", async () => {
    const real = await generateEs256Key();
    const other = await generateEs256Key();
    const signed = await signCard(card(), other, JKU);
    expect((await verifyCard(signed, CARD_URL, serving(JKU, { keys: [real.publicJwk] }))).status).toBe("invalid");
  });

  it("reports an unsigned card as missing, not invalid", async () => {
    expect((await verifyCard(card(), CARD_URL, serving(JKU, { keys: [] }))).status).toBe("missing");
  });
});
