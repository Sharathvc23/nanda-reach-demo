import { CompactSign, base64url, compactVerify, decodeProtectedHeader, importJWK, type JWK } from "jose";
import type { EcKey } from "./poppy.js";

/**
 * Agent Card signatures (A2A `signatures`): a detached JWS over the RFC 8785 (JCS)
 * canonical form of the card without its `signatures` field.
 *
 * mymuse signs its card with the Poppy root key it already publishes at /poppy/jwks.json.
 * Travel26 verifies before routing: the card carries the person's inbox addresses and
 * routing rules, so an altered card would send their mail to someone else.
 */

export interface CardSignature {
  protected: string;
  signature: string;
}

export type SignatureStatus = "valid" | "invalid" | "missing";

/** RFC 8785 for JSON values: keys sorted by UTF-16 code units, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

function payloadOf(card: Record<string, unknown>): Uint8Array {
  const { signatures: _ignored, ...unsigned } = card;
  return new TextEncoder().encode(canonicalize(unsigned));
}

export async function signCard<T extends object>(card: T, key: EcKey, jku: string): Promise<T & { signatures: CardSignature[] }> {
  const { signatures: _ignored, ...unsigned } = card as Record<string, unknown>;
  const privateKey = await importJWK(key.privateJwk, "ES256");
  const jws = await new CompactSign(payloadOf(unsigned))
    .setProtectedHeader({ alg: "ES256", kid: key.kid, jku, typ: "JOSE" })
    .sign(privateKey);
  const [protectedHeader, , signature] = jws.split(".");
  return { ...(unsigned as T), signatures: [{ protected: protectedHeader, signature }] };
}

/**
 * Verify a card fetched from `cardUrl`. The signing key must come from a JWKS on the card's own
 * host (a jku elsewhere is ignored), so whoever can change the card cannot also choose the key.
 */
export async function verifyCard(
  card: Record<string, unknown>,
  cardUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: SignatureStatus; kid?: string; detail?: string }> {
  const sigs = Array.isArray(card.signatures) ? (card.signatures as CardSignature[]) : [];
  if (sigs.length === 0) return { status: "missing" };
  const payload = base64url.encode(payloadOf(card));
  let detail = "no signature verified";
  for (const sig of sigs) {
    try {
      const token = `${sig.protected}.${payload}.${sig.signature}`;
      const header = decodeProtectedHeader(token);
      if (header.alg !== "ES256" || typeof header.kid !== "string" || typeof header.jku !== "string") {
        detail = "unsupported signature header";
        continue;
      }
      if (new URL(header.jku).origin !== new URL(cardUrl).origin) {
        detail = "signing key is not published on the card's host";
        continue;
      }
      const res = await fetchFn(header.jku, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        detail = `key set answered ${res.status}`;
        continue;
      }
      const jwks = (await res.json()) as { keys?: JWK[] };
      const jwk = jwks.keys?.find((k) => k.kid === header.kid);
      if (!jwk) {
        detail = "signing key not in the key set";
        continue;
      }
      await compactVerify(token, await importJWK(jwk, "ES256"), { algorithms: ["ES256"] });
      return { status: "valid", kid: header.kid };
    } catch {
      detail = "signature does not match the card";
    }
  }
  return { status: "invalid", detail };
}
