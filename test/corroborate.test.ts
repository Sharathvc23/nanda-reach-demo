import { describe, expect, it } from "vitest";
import { corroborate, describeReport, type SourceView } from "../src/shared/corroborate.js";
import { canonicalize, cardDigest, signCard, verifyCardProof } from "../src/shared/cardproof.js";
import { generateEs256Key } from "../src/shared/poppy.js";

const ok = (source: string, claims: SourceView["claims"]): SourceView => ({ source, status: "ok", claims });

describe("corroboration kernel", () => {
  it("agrees when every source says the same thing", () => {
    const r = corroborate("urn:air:x", [ok("a", { card_url: "https://c/1", locator: "urn:air:x" }), ok("b", { card_url: "https://c/1", locator: "urn:air:x" })]);
    expect(r.verdict).toBe("AGREE");
    expect(r.findings).toEqual([]);
  });

  it("flags an endpoint disagreement", () => {
    const r = corroborate("urn:air:x", [ok("index", { card_url: "https://c/1" }), ok("card", { card_url: "https://evil/1" })]);
    expect(r.verdict).toBe("DIVERGENT");
    expect(r.findings[0]).toMatchObject({ kind: "endpoint", field: "card_url", sources: ["index", "card"] });
  });

  it("maps fields to the draft's finding kinds", () => {
    const r = corroborate("s", [ok("a", { locator: "1", signature: "valid", inbox: "x@y" }), ok("b", { locator: "2", signature: "invalid", inbox: "z@y" })]);
    expect(r.findings.map((f) => f.kind).sort()).toEqual(["agent_equivocation", "key", "target"]);
  });

  it("treats an unreachable source as absent, not as disagreement", () => {
    const r = corroborate("s", [ok("a", { card_url: "u" }), ok("b", { card_url: "u" }), { source: "c", status: "unreachable", claims: {} }]);
    expect(r.verdict).toBe("AGREE");
  });

  it("reports an omission when a required source has no record", () => {
    const r = corroborate("s", [ok("card", { card_url: "u" }), { source: "index", status: "not_found", claims: {} }], { required: ["index"] });
    expect(r.verdict).toBe("DIVERGENT");
    expect(r.findings[0].kind).toBe("omission");
  });

  it("is insufficient with a single answering source", () => {
    const r = corroborate("s", [ok("a", { card_url: "u" })]);
    expect(r.verdict).toBe("INSUFFICIENT");
  });

  it("ignores null claims", () => {
    const r = corroborate("s", [ok("a", { card_url: "u", inbox: null }), ok("b", { card_url: "u", inbox: "x@y" })]);
    expect(r.verdict).toBe("AGREE");
  });

  it("describes a report as trace lines", () => {
    const r = corroborate("s", [ok("a", { card_url: "u" }), ok("b", { card_url: "v" })]);
    const lines = describeReport(r);
    expect(lines.some((l) => l.startsWith("Corroboration: DIVERGENT"))).toBe(true);
    expect(lines.some((l) => l.includes("finding endpoint"))).toBe(true);
  });
});

describe("card proof", () => {
  it("canonicalizes with sorted keys and no whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, { d: null, c: "x" }] })).toBe('{"a":[true,{"c":"x","d":null}],"b":1}');
  });

  it("signs and verifies a card, and detects tampering", async () => {
    const key = await generateEs256Key();
    const card: Record<string, unknown> = { name: "John", version: "1", agents: [{ id: "muse", inbox: { address: "a@b" } }] };
    const proof = await signCard(card, key.privateJwk, key.kid);
    const signed = { ...card, proof };
    expect(cardDigest(signed)).toBe(cardDigest(card));
    const jwks = { keys: [key.publicJwk] };
    expect(await verifyCardProof(signed, jwks)).toEqual({ ok: true, kid: key.kid });
    const tampered = { ...signed, agents: [{ id: "muse", inbox: { address: "attacker@b" } }] };
    expect((await verifyCardProof(tampered, jwks)).ok).toBe(false);
    const other = await generateEs256Key();
    expect((await verifyCardProof(signed, { keys: [other.publicJwk] })).ok).toBe(false);
    expect((await verifyCardProof(card, jwks)).ok).toBe(false);
  });
});
