/**
 * Personal Agent Protocol (Poppy) 1.0 primitives shared by the Company (travel26) and the
 * Personal Agents (muse, wajo): the Session header a Personal Agent signs for every request, the
 * delegation that vouches for its per-Company signing key, and the Company's verification of both
 * (spec 4.1, 5.2, 5.3).
 *
 * Adapted from nanda-reach-demo `src/shared/poppy.ts` (Sharath Chandra, MIT). Changes from that
 * file: the reach extension constants are replaced by the Operations and continuity extensions;
 * the verifier now accepts signed-in requests (it checks `ath` against the access token and that
 * the token was issued to the Session JWT's `iss`, spec 5.3 step 3); `Poppy-Extensions` is parsed
 * as an RFC 9651 List; and every URL must be HTTPS (the demo's loopback resolver maps `.test`
 * origins, see `net.ts`), so the `allowHttp` switch is gone.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, importJWK, exportJWK, generateKeyPair, calculateJwkThumbprint, decodeProtectedHeader, type JWK } from "jose";
import { parseExtensions } from "./sf.js";

export const POPPY_VERSION = "1.0";
export const SESSION_TYP = "poppy-session+jwt";
export const DELEGATION_TYP = "poppy-delegation+jwt";
export const OPERATIONS_EXTENSION = "operations";
export const OPERATIONS_VERSION = "3";
/**
 * The continuity extension's name. docs/21 leaves `<namespace>/continuity` as a placeholder until
 * open decision OD15; Poppy requires a non-Poppy extension name to start with a domain its author
 * controls (spec 3.3). This is a placeholder too.
 */
export const CONTINUITY_EXTENSION = "stellarminds.ai/act-continuity";
export const CONTINUITY_VERSION = "1";

export const randomId = (bytes = 16): string => randomBytes(bytes).toString("base64url");
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
/** The request URL without query or fragment, as `htu` (spec 5.2, as in DPoP). */
export const htuOf = (url: string): string => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
};
/** A Company identifier for an issuerless Company: scheme and lowercase host, no trailing slash. */
export const audienceOf = (origin: string): string => new URL(origin).origin.toLowerCase();
export const athOf = (accessToken: string): string => createHash("sha256").update(accessToken).digest("base64url");

export interface EcKey {
  privateJwk: JWK;
  publicJwk: JWK;
  kid: string;
}

export async function generateEs256Key(): Promise<EcKey> {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  return keyFromPrivateJwk(privateJwk);
}

export async function keyFromPrivateJwk(privateJwk: JWK): Promise<EcKey> {
  const { kty, crv, x, y } = privateJwk;
  const publicJwk: JWK = { kty, crv, x, y };
  const kid = await calculateJwkThumbprint(publicJwk);
  return { privateJwk: { ...privateJwk, kid }, publicJwk: { ...publicJwk, kid }, kid };
}

/** A delegation: the root key (in jwks_uri) vouches for a delegated key for at most 24 hours. */
export async function signDelegation(root: EcKey, delegated: EcKey, clientId: string, lifetimeSeconds = 2 * 3600): Promise<{ jwt: string; exp: number }> {
  const iat = nowSeconds() - 60;
  const exp = iat + Math.min(lifetimeSeconds, 24 * 3600);
  const { kty, crv, x, y } = delegated.publicJwk;
  const key = await importJWK(root.privateJwk, "ES256");
  const jwt = await new SignJWT({ iss: clientId, cnf: { jwk: { kty, crv, x, y } }, iat, exp, jti: randomId(16) })
    .setProtectedHeader({ alg: "ES256", typ: DELEGATION_TYP, kid: root.kid })
    .sign(key);
  return { jwt, exp };
}

export interface SessionJwtInput {
  delegated: EcKey;
  delegation: string;
  clientId: string;
  /** A string, always, from a conforming agent; an array only in the hostile-input tests. */
  aud: string | string[];
  sid: string;
  sub: string;
  agentId?: string;
  method: string;
  url: string;
  accessToken?: string;
}

/** One Session JWT, for one request (spec 5.2). */
export async function signSessionJwt(i: SessionJwtInput): Promise<string> {
  const key = await importJWK(i.delegated.privateJwk, "ES256");
  const payload: Record<string, unknown> = {
    iss: i.clientId,
    aud: i.aud,
    sid: i.sid,
    sub: i.sub,
    ...(i.agentId ? { agent_id: i.agentId } : {}),
    htm: i.method.toUpperCase(),
    htu: htuOf(i.url),
    iat: nowSeconds(),
    jti: randomId(16),
  };
  if (i.accessToken) payload.ath = athOf(i.accessToken);
  return new SignJWT(payload).setProtectedHeader({ alg: "ES256", typ: SESSION_TYP, kid: i.delegated.kid, poppy_dlg: i.delegation }).sign(key);
}

/** Error shapes from spec 5.3 / 7, as a JSON body. */
export class PoppyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    description?: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(description ?? code);
  }
  body(): Record<string, unknown> {
    return { error: this.code, error_description: this.message, ...this.extra };
  }
}

/** An access token error: OAuth puts it in WWW-Authenticate, not in a JSON body (spec 7). */
export class TokenError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly code: "invalid_token" | "insufficient_scope" | "",
    description: string,
    public readonly scope?: string,
  ) {
    super(description);
  }
  challenge(): string {
    const parts = [`Bearer`];
    const attrs: string[] = [];
    if (this.code) attrs.push(`error="${this.code}"`);
    if (this.scope) attrs.push(`scope="${this.scope}"`);
    return attrs.length ? `${parts[0]} ${attrs.join(", ")}` : parts[0];
  }
}

export interface ClientMetadata {
  client_id: string;
  client_name: string;
  logo_uri?: string;
  jwks_uri: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  [k: string]: unknown;
}

export interface AccessGrant {
  clientId: string;
  account: string;
  scopes: string[];
}

export interface VerifiedSession {
  clientId: string;
  clientMetadata: ClientMetadata;
  sub: string;
  sid: string;
  agentId?: string;
  extensions: Map<string, string>;
  version: string;
  /** Present when the request carried a valid access token issued to the same client_id. */
  access: AccessGrant | null;
}

export interface VerifierOptions {
  /** The Company identifier Session JWTs must name as `aud`. */
  audience: string;
  /** The public origin, used to rebuild the expected `htu` behind the loopback resolver. */
  publicOrigin: string;
  fetchFn: typeof fetch;
  /** Acceptance window for `iat`, seconds. */
  windowSeconds?: number;
  /** Validates an access token the Company issued; throws TokenError. */
  verifyAccessToken?: (token: string) => Promise<AccessGrant>;
}

interface CachedMetadata {
  metadata: ClientMetadata;
  jwks: { keys: JWK[] };
  fetchedAt: number;
}

/**
 * Company-side verification of the Poppy-Session header, in the order spec 5.3 gives. Throws a
 * PoppyError or TokenError the caller turns into the HTTP response.
 */
export class SessionVerifier {
  private readonly cache = new Map<string, CachedMetadata>();
  private readonly delegations = new Map<string, { iss: string; jwk: JWK; exp: number }>();
  private readonly seenJti = new Map<string, number>();

  constructor(private readonly opts: VerifierOptions) {}

  private checkUrl(url: string, what: string): URL {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new PoppyError(400, "invalid_session", `${what} is not a URL`);
    }
    if (u.protocol !== "https:") throw new PoppyError(400, "invalid_session", `${what} must be https`);
    return u;
  }

  /** The client metadata document and key set of a `client_id` (spec 4.1), cached for a minute. */
  async clientKeys(clientId: string): Promise<CachedMetadata> {
    const cached = this.cache.get(clientId);
    if (cached && Date.now() - cached.fetchedAt < 60_000) return cached;
    const idUrl = this.checkUrl(clientId, "client_id");
    const res = await this.opts.fetchFn(clientId, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!res || !res.ok) throw new PoppyError(400, "invalid_session", "client metadata could not be fetched");
    const metadata = (await res.json().catch(() => null)) as ClientMetadata | null;
    if (!metadata || metadata.client_id !== clientId) throw new PoppyError(400, "invalid_session", "client_id does not match its metadata document");
    const jwksUrl = this.checkUrl(metadata.jwks_uri, "jwks_uri");
    if (jwksUrl.host !== idUrl.host) throw new PoppyError(400, "invalid_session", "jwks_uri is not on the client_id domain");
    const jres = await this.opts.fetchFn(metadata.jwks_uri, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!jres || !jres.ok) throw new PoppyError(400, "invalid_session", "jwks could not be fetched");
    const jwks = (await jres.json().catch(() => null)) as { keys?: JWK[] } | null;
    if (!jwks || !Array.isArray(jwks.keys)) throw new PoppyError(400, "invalid_session", "jwks is malformed");
    if (jwks.keys.some((k) => "d" in k)) throw new PoppyError(400, "invalid_session", "jwks holds a private key");
    const entry = { metadata, jwks: { keys: jwks.keys }, fetchedAt: Date.now() };
    this.cache.set(clientId, entry);
    return entry;
  }

  async verify(req: { method: string; url: string; headers: Record<string, string | string[] | undefined> }): Promise<VerifiedSession> {
    const h = (name: string): string | undefined => {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    const version = h("poppy-version");
    if (!version || version.split(".")[0] !== POPPY_VERSION.split(".")[0]) throw new PoppyError(400, "version_unsupported", `Poppy-Version ${version ?? "(missing)"} is not served here`);
    const token = h("poppy-session");
    if (!token) throw new PoppyError(400, "invalid_session", "Poppy-Session header missing");

    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new PoppyError(400, "invalid_session", "Poppy-Session is not a JWT");
    }
    if (header.typ !== SESSION_TYP) throw new PoppyError(400, "invalid_session", "typ must be poppy-session+jwt");
    if (header.alg !== "ES256") throw new PoppyError(400, "invalid_session", "alg must be ES256");
    const dlg = (header as { poppy_dlg?: unknown }).poppy_dlg;
    if (typeof dlg !== "string" || !dlg) throw new PoppyError(400, "invalid_session", "poppy_dlg missing: Session JWTs are signed only with delegated keys");

    // Unverified peek at iss to know whose keys to fetch.
    let issUnverified: string;
    try {
      issUnverified = String(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).iss ?? "");
    } catch {
      throw new PoppyError(400, "invalid_session", "payload is not JSON");
    }
    const { metadata, jwks } = await this.clientKeys(issUnverified);

    // The delegation, with the jwks key its kid names (spec 5.2, Delegated keys).
    const dlgHash = createHash("sha256").update(dlg).digest("hex");
    let delegated = this.delegations.get(dlgHash);
    if (!delegated || delegated.exp <= nowSeconds()) {
      let dh: ReturnType<typeof decodeProtectedHeader>;
      try {
        dh = decodeProtectedHeader(dlg);
      } catch {
        throw new PoppyError(400, "invalid_session", "delegation is not a JWT");
      }
      if (dh.typ !== DELEGATION_TYP) throw new PoppyError(400, "invalid_session", "delegation typ must be poppy-delegation+jwt");
      const rootJwk = jwks.keys.find((k) => k.kid === dh.kid);
      if (!rootJwk) throw new PoppyError(400, "invalid_session", "delegation kid is not in jwks_uri");
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(dlg, rootJwk, { algorithms: ["ES256", "PS384"], typ: DELEGATION_TYP }));
      } catch {
        throw new PoppyError(400, "invalid_session", "delegation signature failed");
      }
      if (payload.iss !== issUnverified) throw new PoppyError(400, "invalid_session", "delegation iss differs from the Session JWT iss");
      const iat = Number(payload.iat),
        exp = Number(payload.exp);
      if (!iat || !exp || exp - iat > 24 * 3600) throw new PoppyError(400, "invalid_session", "delegation lifetime exceeds 24 hours");
      // Hardening beyond spec 5.2's literal check: a future iat would stretch the 24-hour limit.
      if (iat > nowSeconds() + 300) throw new PoppyError(400, "invalid_session", "delegation iat is in the future");
      const jwk = (payload.cnf as { jwk?: JWK } | undefined)?.jwk;
      if (!jwk || "d" in jwk) throw new PoppyError(400, "invalid_session", "delegation cnf.jwk missing or private");
      delegated = { iss: String(payload.iss), jwk, exp };
      this.delegations.set(dlgHash, delegated);
    }

    // The Session JWT itself.
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(token, delegated.jwk, {
        algorithms: ["ES256"],
        typ: SESSION_TYP,
        audience: this.opts.audience,
        maxTokenAge: `${this.opts.windowSeconds ?? 60}s`,
        clockTolerance: "30s",
      }));
    } catch (e) {
      throw new PoppyError(400, "invalid_session", `Session JWT rejected: ${(e as Error).message}`);
    }
    if (typeof claims.aud !== "string") throw new PoppyError(400, "invalid_session", "aud must be a single string (spec 5.2, 10.4)");
    if (header.kid !== (await calculateJwkThumbprint(delegated.jwk))) throw new PoppyError(400, "invalid_session", "kid is not the delegated key's thumbprint");
    if (claims.iss !== delegated.iss) throw new PoppyError(400, "invalid_session", "iss differs from the delegation");
    const expectedHtu = htuOf(`${this.opts.publicOrigin}${req.url}`);
    if (claims.htm !== req.method.toUpperCase() || claims.htu !== expectedHtu) throw new PoppyError(400, "invalid_session", `htm/htu do not match this request (${req.method} ${expectedHtu})`);
    for (const c of ["sid", "sub", "jti"]) if (typeof claims[c] !== "string" || !(claims[c] as string)) throw new PoppyError(400, "invalid_session", `${c} missing`);

    // Step 3: the access token, if any. `ath` must match it, and it must be issued to `iss`.
    const authorization = h("authorization");
    let access: AccessGrant | null = null;
    if (authorization) {
      const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorization);
      if (!m) throw new TokenError(401, "invalid_token", "Authorization must be a Bearer token");
      const accessToken = m[1];
      const expected = Buffer.from(athOf(accessToken));
      const given = Buffer.from(typeof claims.ath === "string" ? claims.ath : "");
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new PoppyError(400, "invalid_session", "ath does not match the access token");
      if (!this.opts.verifyAccessToken) throw new TokenError(401, "invalid_token", "this endpoint takes no access tokens");
      access = await this.opts.verifyAccessToken(accessToken);
      if (access.clientId !== claims.iss) throw new PoppyError(400, "invalid_session", "the access token was issued to another client_id");
    } else if (claims.ath !== undefined) {
      throw new PoppyError(400, "invalid_session", "ath present without an access token");
    }

    // Optional replay rejection, in memory (spec 5.3, Replayed JWTs).
    const jti = claims.jti as string;
    const cutoff = nowSeconds() - 120;
    for (const [k, t] of this.seenJti) if (t < cutoff) this.seenJti.delete(k);
    if (this.seenJti.has(jti)) throw new PoppyError(400, "invalid_session", "jti reused");
    this.seenJti.set(jti, nowSeconds());

    return {
      clientId: claims.iss as string,
      clientMetadata: metadata,
      sub: claims.sub as string,
      sid: claims.sid as string,
      agentId: typeof claims.agent_id === "string" ? claims.agent_id : undefined,
      extensions: parseExtensions(h("poppy-extensions")),
      version,
      access,
    };
  }
}
