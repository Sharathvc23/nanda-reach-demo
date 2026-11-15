/**
 * A detached signature over an agent card, so a relying party can check that the card the Index
 * points at was published by the key of the identity it has already met (the Poppy client).
 * Canonical form: JSON with object keys sorted, no whitespace, the `proof` field removed.
 */
import { createHash } from "node:crypto";
import { CompactSign, compactVerify, importJWK, type JWK } from "jose";

export interface CardProof {
  type: "JWS";
  alg: "ES256";
  kid: string;
  /** Compact JWS whose payload is the SHA-256 of the canonical card, base64url. */
  jws: string;
  created: string;
}

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function cardDigest(card: Record<string, unknown>): string {
  const { proof: _proof, ...rest } = card;
  return createHash("sha256").update(canonicalize(rest)).digest("base64url");
}

export async function signCard(card: Record<string, unknown>, privateJwk: JWK, kid: string): Promise<CardProof> {
  const digest = cardDigest(card);
  const key = await importJWK(privateJwk, "ES256");
  const jws = await new CompactSign(new TextEncoder().encode(digest)).setProtectedHeader({ alg: "ES256", kid, typ: "agent-card-proof+jws" }).sign(key);
  return { type: "JWS", alg: "ES256", kid, jws, created: new Date().toISOString() };
}

/** Verify a card's proof against a key set. Returns the kid that signed it, or the reason it fails. */
export async function verifyCardProof(card: Record<string, unknown>, jwks: { keys: JWK[] }): Promise<{ ok: true; kid: string } | { ok: false; reason: string }> {
  const proof = card.proof as CardProof | undefined;
  if (!proof || proof.type !== "JWS" || typeof proof.jws !== "string") return { ok: false, reason: "no proof on the card" };
  const jwk = jwks.keys.find((k) => k.kid === proof.kid);
  if (!jwk) return { ok: false, reason: `signer kid ${proof.kid} is not among the identity's keys` };
  try {
    const key = await importJWK(jwk, "ES256");
    const { payload } = await compactVerify(proof.jws, key, { algorithms: ["ES256"] });
    const signed = new TextDecoder().decode(payload);
    if (signed !== cardDigest(card)) return { ok: false, reason: "card content differs from what was signed" };
    return { ok: true, kid: proof.kid };
  } catch (e) {
    return { ok: false, reason: `signature does not verify: ${(e as Error).message}` };
  }
}
