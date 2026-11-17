/**
 * RFC 8785 JSON Canonicalization Scheme, for the JSON this demo signs and digests.
 *
 * Keys are sorted by UTF-16 code units (RFC 8785 §3.2.3, which is JavaScript's default string
 * order), strings and numbers are serialized as ECMAScript's JSON.stringify does (§3.2.2), and
 * anything that has no canonical form is refused instead of being dropped: undefined, functions,
 * non-finite numbers and strings with lone surrogates. The Python reference (`rfc8785`) is the
 * cross-check: every receipt this demo signs is re-canonicalized and verified there.
 */
import { createHash } from "node:crypto";

export class CanonicalizationError extends TypeError {}

function str(s: string): string {
  if (!s.isWellFormed()) throw new CanonicalizationError("JCS: string has a lone surrogate");
  return JSON.stringify(s);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError("JCS: non-finite number");
      return JSON.stringify(value);
    case "string":
      return str(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new CanonicalizationError("JCS: only plain objects");
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((k) => `${str(k)}:${serialize(record[k])}`)
        .join(",")}}`;
    }
    default:
      throw new CanonicalizationError(`JCS: ${typeof value} has no JSON form`);
  }
}

export const canonicalize = (value: unknown): string => serialize(value);
export const canonicalBytes = (value: unknown): Buffer => Buffer.from(serialize(value), "utf8");
export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** SHA-256 (hex) of the RFC 8785 form of `obj` with only `field` removed: ACT's receipt and profile digests. */
export function digestWithout(obj: Record<string, unknown>, field: string): string {
  const { [field]: _omitted, ...rest } = obj;
  return sha256Hex(canonicalBytes(rest));
}
