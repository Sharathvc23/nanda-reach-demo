/**
 * ACT primitives, ported from the Agent Continuity Toolkit (Python reference, read-only):
 *
 * - the owner-anchored occurrence key of `act/occurrence.py`;
 * - the receipt and profile digests of `act/provider.py` (SHA-256 of the RFC 8785 form with only
 *   the digest member removed);
 * - the receipt signature profile of ADR 0007 and `act/receipt_signing.py`: a compact JWS with a
 *   detached payload (RFC 7515 Appendix F), ES256, protected header exactly {alg, kid, typ: "JOSE"},
 *   kid = the RFC 7638 thumbprint, and the receipt's `attestation` naming that kid;
 * - the owner-signed fence statement this demo proposes for docs/21 §3.4.
 *
 * Signing and ECDSA come from `jose`; nothing here implements cryptography. A valid receipt
 * signature shows that the holder of a pinned key issued these exact bytes. It does not show that
 * the receipt is true, complete or current, or when it was signed (ADR 0007).
 */
import { CompactSign, compactVerify, calculateJwkThumbprint, importJWK, type JWK } from "jose";
import { canonicalBytes, digestWithout, sha256Hex } from "./jcs.js";

export const ALGORITHM = "ES256";
export const CURVE = "P-256";
export const RECEIPT_HEADER_TYPE = "JOSE";
export const SIGNATURE_FORMAT = "jws-compact-detached";
export const PAYLOAD_FORMAT = "rfc8785-receipt";
export const ATTESTATION_FORMAT = "provider_signature";
export const SIGNATURE_HEADER = "ACT-Receipt-Signature";
export const MAX_SIGNATURE_LENGTH = 1024;
export const MAX_PINNED_KEYS = 16;
export const FENCE_STATEMENT_TYPE = "act-fence+jwt";

const DETACHED = /^[A-Za-z0-9_-]{1,512}\.\.[A-Za-z0-9_-]{1,256}$/;
const COMPACT = /^[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,256}$/;
export const OCCURRENCE_KEY = /^[0-9a-f]{64}$/;

export class SignatureError extends Error {}

const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

function decodeJsonSegment(segment: string, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new SignatureError(`${what} is not base64url JSON`);
  }
}

const sameKeys = (obj: object, keys: string[]): boolean => {
  const own = Object.keys(obj).sort();
  return own.length === keys.length && [...keys].sort().every((k, i) => own[i] === k);
};

// ---------------------------------------------------------------------------------------------
// Occurrence identity (act/occurrence.py)

/** 64-hex SHA-256 of the RFC 8785 form of {owner_id, tenant_id, job_id, operation_id}. */
export function occurrenceKey(ownerId: string, tenantId: string, jobId: string, operationId: string): string {
  for (const [name, value] of [["owner_id", ownerId], ["tenant_id", tenantId], ["job_id", jobId], ["operation_id", operationId]] as const) {
    if (typeof value !== "string" || !value || value.length > 256) throw new Error(`${name} must be a nonempty bounded string`);
  }
  return sha256Hex(canonicalBytes({ job_id: jobId, operation_id: operationId, owner_id: ownerId, tenant_id: tenantId }));
}

export const isOccurrenceKey = (v: unknown): v is string => typeof v === "string" && OCCURRENCE_KEY.test(v);

export const receiptDigest = (receipt: Record<string, unknown>): string => digestWithout(receipt, "receipt_digest");
export const profileDigest = (profile: Record<string, unknown>): string => digestWithout(profile, "profile_digest");

// ---------------------------------------------------------------------------------------------
// Keys

export interface PublicEcJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  kid: string;
}

/** The public JWK an owner pins: exactly kty, crv, x, y and kid, with kid the RFC 7638 thumbprint. */
export async function publicJwkOf(jwk: JWK): Promise<PublicEcJwk> {
  if (jwk.kty !== "EC" || jwk.crv !== CURVE || typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new SignatureError("keys must be P-256");
  const core = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y };
  return { ...core, kid: await calculateJwkThumbprint(core, "sha256") };
}

/** Validate owner-pinned public keys (act/receipt_signing.py `pinned_keys`); return them by kid. */
export async function pinnedKeys(keys: unknown): Promise<Map<string, PublicEcJwk>> {
  if (keys && typeof keys === "object" && !Array.isArray(keys) && sameKeys(keys, ["keys"])) keys = (keys as { keys: unknown }).keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_PINNED_KEYS) throw new SignatureError(`pin between 1 and ${MAX_PINNED_KEYS} public keys`);
  const out = new Map<string, PublicEcJwk>();
  for (const jwk of keys) {
    if (!jwk || typeof jwk !== "object" || !sameKeys(jwk, ["kty", "crv", "x", "y", "kid"])) throw new SignatureError("a pinned key must be a public P-256 JWK with exactly kty, crv, x, y and kid");
    const k = jwk as Record<string, unknown>;
    if (k.kty !== "EC" || k.crv !== CURVE) throw new SignatureError("a pinned key must be a P-256 EC key");
    if (typeof k.x !== "string" || typeof k.y !== "string" || typeof k.kid !== "string") throw new SignatureError("key members must be strings");
    const expected = await calculateJwkThumbprint({ kty: "EC", crv: "P-256", x: k.x, y: k.y }, "sha256");
    if (k.kid !== expected) throw new SignatureError("a pinned key's kid must be its RFC 7638 thumbprint");
    if (out.has(k.kid)) throw new SignatureError("a key is pinned twice");
    try {
      await importJWK({ kty: "EC", crv: "P-256", x: k.x, y: k.y }, ALGORITHM);
    } catch {
      throw new SignatureError("a pinned key is not a valid P-256 point");
    }
    out.set(k.kid, { kty: "EC", crv: "P-256", x: k.x, y: k.y, kid: k.kid });
  }
  return out;
}

export interface SigningDeclaration {
  format: typeof SIGNATURE_FORMAT;
  alg: typeof ALGORITHM;
  payload: typeof PAYLOAD_FORMAT;
  keys: PublicEcJwk[];
}

export const signingDeclaration = (key: PublicEcJwk): SigningDeclaration => ({ format: SIGNATURE_FORMAT, alg: ALGORITHM, payload: PAYLOAD_FORMAT, keys: [key] });

/** Parse a profile's `receipt_signing` member (`declared_keys`). */
export async function declaredKeys(declaration: unknown): Promise<Map<string, PublicEcJwk>> {
  if (!declaration || typeof declaration !== "object" || !sameKeys(declaration, ["format", "alg", "payload", "keys"])) throw new SignatureError("unsupported receipt_signing declaration");
  const d = declaration as Record<string, unknown>;
  if (d.format !== SIGNATURE_FORMAT || d.alg !== ALGORITHM || d.payload !== PAYLOAD_FORMAT) throw new SignatureError("unsupported format, algorithm or payload");
  return pinnedKeys(d.keys);
}

// ---------------------------------------------------------------------------------------------
// Receipt signatures (ADR 0007)

/** Return `header..signature` over the RFC 8785 receipt (`ReceiptSigner.sign`). */
export async function signReceipt(receipt: Record<string, unknown>, privateJwk: JWK, kid: string): Promise<string> {
  const att = receipt.attestation as Record<string, unknown> | undefined;
  if (!att || att.format !== ATTESTATION_FORMAT || att.reference !== kid || !sameKeys(att, ["format", "reference"])) throw new SignatureError("the receipt's attestation must name this signing key");
  const key = await importJWK(privateJwk, ALGORITHM);
  const jws = await new CompactSign(canonicalBytes(receipt)).setProtectedHeader({ alg: ALGORITHM, kid, typ: RECEIPT_HEADER_TYPE }).sign(key);
  const [header, , signature] = jws.split(".");
  return `${header}..${signature}`;
}

/**
 * Verify a detached receipt signature against pinned keys; return the kid
 * (`verify_receipt_signature`). The header must be exactly {"alg": "ES256", "kid": <pinned>,
 * "typ": "JOSE"} and the receipt's attestation must name the same key.
 */
export async function verifyReceiptSignature(receipt: unknown, signature: unknown, keys: Map<string, PublicEcJwk>): Promise<string> {
  if (typeof signature !== "string" || signature.length > MAX_SIGNATURE_LENGTH || !DETACHED.test(signature)) throw new SignatureError("not a compact JWS with a detached payload");
  const [encodedHeader, encodedSignature] = signature.split("..");
  const header = decodeJsonSegment(encodedHeader, "the protected header");
  if (!header || typeof header !== "object" || Array.isArray(header) || !sameKeys(header, ["alg", "kid", "typ"])) throw new SignatureError("the protected header must hold exactly alg, kid and typ");
  const h = header as Record<string, unknown>;
  if (h.alg !== ALGORITHM || h.typ !== RECEIPT_HEADER_TYPE) throw new SignatureError("unsupported algorithm or type");
  const kid = h.kid;
  if (typeof kid !== "string" || !keys.has(kid)) throw new SignatureError("the signing key is not pinned");
  if (!receipt || typeof receipt !== "object") throw new SignatureError("the receipt is not an object");
  const att = (receipt as Record<string, unknown>).attestation as Record<string, unknown> | undefined;
  if (!att || typeof att !== "object" || !sameKeys(att, ["format", "reference"]) || att.format !== ATTESTATION_FORMAT || att.reference !== kid) throw new SignatureError("the receipt's attestation does not name the signing key");
  let payload: Buffer;
  try {
    payload = canonicalBytes(receipt);
  } catch {
    throw new SignatureError("the receipt is not canonical JSON");
  }
  const token = `${encodedHeader}.${b64url(payload)}.${encodedSignature}`;
  try {
    const { kty, crv, x, y } = keys.get(kid)!;
    await compactVerify(token, await importJWK({ kty, crv, x, y }, ALGORITHM), { algorithms: [ALGORITHM] });
  } catch {
    throw new SignatureError("the signature does not verify");
  }
  return kid;
}

// ---------------------------------------------------------------------------------------------
// Owner-signed fence statements (docs/21 §3.4, as built here)

/**
 * What the owner signs to advance a Company's fence. docs/21 §3.4 names tenant, owner, job, the
 * new executor epoch and the recovery generation. This demo adds `aud` (the Company identifier),
 * `executor` (the client_id the epoch is granted to, so a retired agent cannot simply claim the
 * new epoch), `iat` and `jti`.
 */
export interface FenceStatement {
  aud: string;
  tenant_id: string;
  owner_id: string;
  job_id: string;
  executor_epoch: number;
  recovery_generation: number;
  executor: string;
  iat: number;
  jti: string;
}

const FENCE_CLAIMS = ["aud", "tenant_id", "owner_id", "job_id", "executor_epoch", "recovery_generation", "executor", "iat", "jti"];
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export async function signFenceStatement(claims: FenceStatement, privateJwk: JWK, kid: string): Promise<string> {
  const key = await importJWK(privateJwk, ALGORITHM);
  return new CompactSign(Buffer.from(JSON.stringify(claims), "utf8")).setProtectedHeader({ alg: ALGORITHM, kid, typ: FENCE_STATEMENT_TYPE }).sign(key);
}

/** Parse the header without verifying, to find which key it names. Throws SignatureError. */
export function fenceStatementHeader(statement: unknown): { alg: string; kid: string; typ: string } {
  if (typeof statement !== "string" || statement.length > 8192 || !COMPACT.test(statement)) throw new SignatureError("the fence statement is not a compact JWS");
  const header = decodeJsonSegment(statement.split(".")[0], "the fence statement header");
  if (!header || typeof header !== "object" || Array.isArray(header) || !sameKeys(header, ["alg", "kid", "typ"])) throw new SignatureError("the fence statement header must hold exactly alg, kid and typ");
  const h = header as Record<string, unknown>;
  if (h.alg !== ALGORITHM || h.typ !== FENCE_STATEMENT_TYPE || typeof h.kid !== "string") throw new SignatureError("unsupported fence statement algorithm or type");
  return { alg: h.alg, kid: h.kid, typ: h.typ };
}

/** Verify a fence statement against the one owner key registered for the account. */
export async function verifyFenceStatement(statement: unknown, ownerKey: PublicEcJwk): Promise<FenceStatement> {
  const header = fenceStatementHeader(statement);
  if (header.kid !== ownerKey.kid) throw new SignatureError("the fence statement is not signed by the registered owner key");
  let payload: Uint8Array;
  try {
    const { kty, crv, x, y } = ownerKey;
    ({ payload } = await compactVerify(statement as string, await importJWK({ kty, crv, x, y }, ALGORITHM), { algorithms: [ALGORITHM] }));
  } catch {
    throw new SignatureError("the fence statement signature does not verify");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    throw new SignatureError("the fence statement payload is not JSON");
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims) || !sameKeys(claims, FENCE_CLAIMS)) throw new SignatureError(`the fence statement must hold exactly ${FENCE_CLAIMS.join(", ")}`);
  const c = claims as Record<string, unknown>;
  for (const k of ["aud", "tenant_id", "owner_id", "job_id", "executor", "jti"]) {
    if (typeof c[k] !== "string" || !(c[k] as string) || (c[k] as string).length > 256) throw new SignatureError(`${k} must be a nonempty bounded string`);
  }
  if (!Number.isSafeInteger(c.executor_epoch) || (c.executor_epoch as number) < 1 || (c.executor_epoch as number) > MAX_SAFE) throw new SignatureError("executor_epoch must be a positive integer");
  if (!Number.isSafeInteger(c.recovery_generation) || (c.recovery_generation as number) < 0) throw new SignatureError("recovery_generation must be a nonnegative integer");
  if (!Number.isSafeInteger(c.iat)) throw new SignatureError("iat must be an integer");
  return c as unknown as FenceStatement;
}
