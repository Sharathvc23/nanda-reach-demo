/**
 * A scripted Personal Agent ("John on Muse", "John on Wajo"): a Poppy 1.0 client with its own
 * client_id metadata document, keys, User ID and Sessions, which also sends the ACT headers the
 * owner's grant gives it. Deterministic; no language model.
 *
 * The identity, discovery and Session code is adapted from nanda-reach-demo
 * `src/mymuse/poppy-client.ts` (Sharath Chandra, MIT). Added here: the sign-in subset (PKCE,
 * `private_key_jwt`, `iss` check), access tokens with `ath`, the Operations approval round trip,
 * and the continuity extension (ACT headers, carrying the owner's fence statement and receipt).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { SignJWT, importJWK } from "jose";
import { SIGNATURE_HEADER, type PublicEcJwk } from "../shared/act.js";
import type { Loopback } from "../shared/net.js";
import {
  CONTINUITY_EXTENSION,
  CONTINUITY_VERSION,
  OPERATIONS_EXTENSION,
  OPERATIONS_VERSION,
  POPPY_VERSION,
  generateEs256Key,
  nowSeconds,
  randomId,
  signDelegation,
  signSessionJwt,
  type EcKey,
} from "../shared/poppy.js";
import { serializeExtensions, sfString } from "../shared/sf.js";
import type { Timeline } from "../shared/timeline.js";

export interface AgentIdentity {
  id: string;
  name: string;
  harness: string;
  origin: string;
}

export const MUSE: AgentIdentity = { id: "muse", name: "John on Muse", harness: "Muse", origin: "https://muse.test" };
export const WAJO: AgentIdentity = { id: "wajo", name: "John on Wajo", harness: "Wajo", origin: "https://wajo.test" };

/** The request left, and no answer came back: it may or may not have entered. */
export class NetworkError extends Error {}

export interface CompanyDoc {
  origin: string;
  aud: string;
  issuer: string;
  name: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  continuity: { profile: string; fence_endpoint: string; occurrence_endpoint: string; receipt_endpoint: string; participation_level: string } | null;
  operations: boolean;
}

interface CompanySession {
  sub: string;
  sid: string;
  delegated: EcKey;
  delegation: string;
  delegationExp: number;
  accessToken: string | null;
  scope: string | null;
  pending: { state: string; verifier: string; redirectUri: string; issuer: string; tokenEndpoint: string } | null;
}

export interface ActBinding {
  occurrence_key: string;
  executor_epoch: number;
  recovery_generation: number;
  job_id: string;
  operation_id: string;
}

export interface Approval {
  operation_id: string;
  revision: string;
  approver: "user" | "agent";
  approved_at: number;
  input_type?: string;
  reference: string;
}

export interface Response {
  status: number;
  headers: Headers;
  body: Record<string, any>;
}

export interface Claim {
  company: string;
  job_ref: string;
  operation_id: string;
  occurrence_key: string;
  executor_epoch: number;
  recovery_generation: number;
  request: { offer_id: string; traveler: string };
}

export interface GrantView {
  state: "pending" | "active" | "retired";
  executor_epoch: number;
  recovery_generation?: number;
  fence_statement?: string | null;
  registration?: { owner_id: string; tenant_id: string; jwk: PublicEcJwk };
  job?: { title: string; state: string; hold_reason: string | null; company: string; job_ref: string };
  operations?: { operation_id: string; description: string; request: { offer_id: string; traveler: string }; occurrence_key: string; outcome: string; authority: string; native_reference: string | null; next: string }[];
}

const approvalHeader = (a: Approval): string =>
  [
    `operation_id=${sfString(a.operation_id)}`,
    `revision=${sfString(a.revision)}`,
    `approver=${sfString(a.approver)}`,
    `approved_at=${a.approved_at}`,
    ...(a.input_type ? [`input_type=${sfString(a.input_type)}`] : []),
    `reference=${sfString(a.reference)}`,
  ].join(", ");

/** Request options that can cross a network: no functions, no foreign tokens. */
export interface PlainRequestOptions {
  body?: unknown;
  act?: ActBinding | null;
  approval?: Approval | null;
  signedOut?: boolean;
}

export type CarryResult =
  | { ok: false; response: Response }
  | { ok: true; response: Response; receipt: Record<string, unknown>; signature: string; resolutions: { operation_id: string; resolution: string }[] };

/**
 * What a scenario needs from a Personal Agent. `PersonalAgent` implements it in this process; on
 * the live site, `RemoteAgent` (src/executor/remote.ts) implements it against the agent's host,
 * where the agent's keys are.
 */
export interface AgentHandle {
  readonly identity: AgentIdentity;
  readonly clientId: string;
  setGrant(grant: string): Promise<void>;
  hasAccessToken(company: CompanyDoc): Promise<boolean>;
  /** The pairwise User ID the Company assigned this agent (spec 5.1). */
  pairwiseUserId(company: CompanyDoc): Promise<string | null>;
  discover(origin: string): Promise<CompanyDoc>;
  beginSignIn(company: CompanyDoc, scopes: string[], ownerRegistration: GrantView["registration"] | null): Promise<Record<string, any>>;
  request(company: CompanyDoc, method: string, path: string, opts?: PlainRequestOptions): Promise<Response>;
  grantView(): Promise<GrantView>;
  carryFence(company: CompanyDoc): Promise<CarryResult>;
  occurrenceStatus(company: CompanyDoc, occurrenceKey: string): Promise<Response>;
  readReceipt(company: CompanyDoc, jobRef: string): Promise<Response>;
  startBooking(company: CompanyDoc, operationId: string): Promise<{ claim: Claim; act: ActBinding; first: Response }>;
  sendApproved(company: CompanyDoc, claim: Claim, act: ActBinding | null, approval: Approval): Promise<Response>;
  report(operationId: string, report: { kind: "performed"; native_reference: string; native_status: string } | { kind: "unknown"; detail: string }): Promise<void>;
  readBooking(company: CompanyDoc, bookingId: string): Promise<Response>;
  kill(): Promise<void>;
}

export class PersonalAgent implements AgentHandle {
  readonly app: FastifyInstance;
  private readonly companies = new Map<string, CompanySession>();
  private readonly docs = new Map<string, CompanyDoc>();
  /** The owner's grant for the job this agent holds, if any. */
  grant: string | null = null;
  dead = false;

  private constructor(
    readonly identity: AgentIdentity,
    private readonly root: EcKey,
    private readonly loopback: Loopback,
    private readonly ownerOrigin: string,
    private readonly timeline: Timeline,
  ) {
    this.app = Fastify({ logger: false });
    this.app.get("/poppy/client.json", async () => this.clientMetadata());
    this.app.get("/poppy/jwks.json", async () => ({ keys: [this.root.publicJwk] }));
    // The redirect back from sign-in (spec 4.2). The demo's "browser" follows the redirect here.
    this.app.get("/poppy/callback", async (req, reply) => {
      try {
        await this.completeSignIn(req.query as Record<string, string>);
        return { signed_in: true };
      } catch (e) {
        return reply.code(400).send({ error: "sign_in_failed", error_description: (e as Error).message });
      }
    });
  }

  static async create(identity: AgentIdentity, loopback: Loopback, ownerOrigin: string, timeline: Timeline): Promise<PersonalAgent> {
    return new PersonalAgent(identity, await generateEs256Key(), loopback, ownerOrigin, timeline);
  }

  /**
   * An agent that uses a key it already has: on a host that serves the agent's client metadata
   * itself, every run's instance signs with the one key its `jwks_uri` publishes.
   */
  static withKey(identity: AgentIdentity, root: EcKey, loopback: Loopback, ownerOrigin: string, timeline: Timeline): PersonalAgent {
    const agent = new PersonalAgent(identity, root, loopback, ownerOrigin, timeline);
    agent.hosted = true;
    return agent;
  }

  /** Run by a host that serves the agent's routes itself (src/executor/host.ts); it owns no route. */
  private hosted = false;

  async setGrant(grant: string): Promise<void> {
    this.grant = grant;
  }

  async hasAccessToken(company: CompanyDoc): Promise<boolean> {
    return this.accessTokenAt(company) !== null;
  }

  async pairwiseUserId(company: CompanyDoc): Promise<string | null> {
    return this.userIdAt(company) ?? null;
  }

  /** This agent's own discovery of a Company, if it has made one. No I/O. */
  cachedCompany(origin: string): CompanyDoc | undefined {
    return this.docs.get(new URL(origin).origin);
  }

  /** Whether a sign-in this agent started is waiting for the redirect that carries `state`. */
  ownsSignInState(state: string): boolean {
    return [...this.companies.values()].some((c) => c.pending?.state === state);
  }

  /** The redirect back from sign-in, when a host other than this agent's own server receives it. */
  async handleCallback(query: Record<string, string>): Promise<void> {
    this.alive();
    await this.completeSignIn(query);
  }

  get clientId(): string {
    return `${this.identity.origin}/poppy/client.json`;
  }

  private log(text: string, data?: Record<string, unknown>): void {
    this.timeline.add(this.identity.name, text, data);
  }

  private alive(): void {
    if (this.dead) throw new Error(`${this.identity.name} is not running`);
  }

  /** The client metadata document (spec 4.1). */
  clientMetadata() {
    return {
      client_id: this.clientId,
      client_name: this.identity.name,
      jwks_uri: `${this.identity.origin}/poppy/jwks.json`,
      redirect_uris: [`${this.identity.origin}/poppy/callback`],
      token_endpoint_auth_method: "private_key_jwt",
    };
  }

  // -- discovery (spec 3, 3.2) ------------------------------------------------------------------

  async discover(origin: string): Promise<CompanyDoc> {
    this.alive();
    const u = new URL(origin);
    if (u.protocol !== "https:") throw new Error("Poppy requires https");
    const cached = this.docs.get(u.origin);
    if (cached) return cached;
    const get = async (url: string) => {
      const res = await this.loopback.fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return (await res.json()) as Record<string, any>;
    };
    const doc = await get(`${u.origin}/.well-known/poppy.json`);
    if (String(doc.protocol_version ?? "").split(".")[0] !== POPPY_VERSION.split(".")[0]) throw new Error("incompatible protocol_version");
    if (String(doc.organization?.domain ?? "").toLowerCase() !== u.host.toLowerCase()) throw new Error("organization.domain is not the host that served poppy.json");
    const prm = await get(`${u.origin}/.well-known/oauth-protected-resource`);
    if (prm.resource !== `https://${doc.organization.domain}`) throw new Error("protected resource metadata names another resource");
    const issuer = prm.authorization_servers?.[0];
    if (typeof issuer !== "string" || prm.authorization_servers.length !== 1) throw new Error("expected exactly one authorization server");
    const as = await get(`${new URL(issuer).origin}/.well-known/oauth-authorization-server${new URL(issuer).pathname.replace(/\/$/, "")}`);
    if (as.issuer !== issuer) throw new Error("issuer metadata does not match the issuer");
    if (!Array.isArray(as.protected_resources) || !as.protected_resources.includes(`https://${doc.organization.domain}`)) throw new Error("the issuer does not list this domain");
    const cont = doc.extensions?.[CONTINUITY_EXTENSION]?.find((e: { version: string }) => e.version === CONTINUITY_VERSION) ?? null;
    const company: CompanyDoc = {
      origin: u.origin,
      aud: issuer,
      issuer,
      name: doc.organization.name,
      authorizationEndpoint: as.authorization_endpoint,
      tokenEndpoint: as.token_endpoint,
      continuity: cont ? { profile: cont.profile, fence_endpoint: cont.fence_endpoint, occurrence_endpoint: cont.occurrence_endpoint, receipt_endpoint: cont.receipt_endpoint, participation_level: cont.participation_level } : null,
      operations: Boolean(doc.extensions?.[OPERATIONS_EXTENSION]?.some((e: { version: string }) => e.version === OPERATIONS_VERSION)),
    };
    this.docs.set(u.origin, company);
    this.log(`discovered ${company.name} (Poppy ${doc.protocol_version}; operations v3: ${company.operations}; continuity: ${company.continuity?.participation_level ?? "no"})`);
    return company;
  }

  /** The per-Company User ID, Session and delegated key (spec 5.1, 5.2). */
  private async session(company: CompanyDoc): Promise<CompanySession> {
    let c = this.companies.get(company.aud);
    if (!c) {
      const delegated = await generateEs256Key();
      c = { sub: `u_${randomId(12)}`, sid: randomId(16), delegated, delegation: "", delegationExp: 0, accessToken: null, scope: null, pending: null };
      this.companies.set(company.aud, c);
    }
    if (c.delegationExp - 300 < nowSeconds()) {
      const d = await signDelegation(this.root, c.delegated, this.clientId, 2 * 3600);
      c.delegation = d.jwt;
      c.delegationExp = d.exp;
    }
    return c;
  }

  userIdAt(company: CompanyDoc): string | undefined {
    return this.companies.get(company.aud)?.sub;
  }

  accessTokenAt(company: CompanyDoc): string | null {
    return this.companies.get(company.aud)?.accessToken ?? null;
  }

  // -- sign-in (the demo's subset, see travel26/oauth.ts) ---------------------------------------

  /** Start Direct Sign-In; returns the Company's consent page, which John answers. */
  async beginSignIn(company: CompanyDoc, scopes: string[], ownerRegistration: GrantView["registration"] | null) {
    this.alive();
    const c = await this.session(company);
    const verifier = randomBytes(32).toString("base64url");
    const state = randomId(12);
    const redirectUri = `${this.identity.origin}/poppy/callback`;
    c.pending = { state, verifier, redirectUri, issuer: company.issuer, tokenEndpoint: company.tokenEndpoint };
    const url = new URL(company.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "consent");
    if (ownerRegistration) url.searchParams.set("act_owner", Buffer.from(JSON.stringify(ownerRegistration)).toString("base64url"));
    const res = await this.loopback.fetch(url.toString(), { headers: { accept: "application/json" } });
    const page = (await res.json()) as Record<string, any>;
    if (!res.ok) throw new Error(`authorization request refused: ${page.error}: ${page.error_description}`);
    this.log(`asked John to sign in at ${company.name} (scopes ${scopes.join(" ")}${ownerRegistration ? `; owner key ${ownerRegistration.jwk.kid.slice(0, 10)}…` : ""})`);
    return page;
  }

  /** A private_key_jwt client assertion (spec 4.1): signed with the jwks_uri key, `aud` the issuer, at most 5 minutes. */
  async clientAssertion(audience: string, lifetimeSeconds = 120, iatOffsetSeconds = 0): Promise<string> {
    const iat = nowSeconds() + iatOffsetSeconds;
    return new SignJWT({ jti: randomId(16) })
      .setProtectedHeader({ alg: "ES256", kid: this.root.kid })
      .setIssuer(this.clientId)
      .setSubject(this.clientId)
      .setAudience(audience)
      .setIssuedAt(iat)
      .setExpirationTime(iat + lifetimeSeconds)
      .sign(await importJWK(this.root.privateJwk, "ES256"));
  }

  private async completeSignIn(q: Record<string, string>): Promise<void> {
    const entry = [...this.companies.entries()].find(([, c]) => c.pending?.state === q.state);
    if (!entry) throw new Error("unknown state");
    const [, c] = entry;
    const pending = c.pending!;
    c.pending = null;
    if (q.iss !== pending.issuer) throw new Error("iss does not match the issuer sign-in started with (RFC 9207)");
    if (q.error) throw new Error(`sign-in declined: ${q.error}`);
    const assertion = await this.clientAssertion(pending.issuer);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: q.code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
      client_id: this.clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });
    const res = await this.loopback.fetch(pending.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const body = (await res.json()) as Record<string, any>;
    if (!res.ok) throw new Error(`token request refused: ${body.error}: ${body.error_description}`);
    c.accessToken = body.access_token;
    c.scope = body.scope;
    this.log(`signed in (access token for scopes "${body.scope}", ${body.expires_in}s)`);
  }

  // -- requests (spec 5.2, 3.4; Operations §6; continuity docs/21 §3.2) --------------------------

  /**
   * One Poppy request. `accessToken`, `aud` and `tamper` exist for the hostile-input tests: they sign
   * the Session JWT over another token or with an array audience, or edit headers after signing.
   */
  async request(
    company: CompanyDoc,
    method: string,
    path: string,
    opts: { body?: unknown; act?: ActBinding | null; approval?: Approval | null; signedOut?: boolean; accessToken?: string; aud?: string[]; tamper?: (h: Record<string, string>) => void } = {},
  ): Promise<Response> {
    this.alive();
    // A path, never an authority: "@other.example/x" or "//other.example" must not move the
    // request, with its Session JWT and access token, to another host.
    if (!/^\/(?!\/)/.test(path)) throw new Error(`request path must start with a single "/": ${path}`);
    const target = new URL(path, company.origin);
    if (target.origin !== new URL(company.origin).origin) throw new Error(`request path leaves ${company.origin}`);
    const c = await this.session(company);
    const url = target.toString();
    const token = opts.signedOut ? null : (opts.accessToken ?? c.accessToken);
    const extensions: Record<string, string> = {};
    if (company.operations) extensions[OPERATIONS_EXTENSION] = OPERATIONS_VERSION;
    if (company.continuity) extensions[CONTINUITY_EXTENSION] = CONTINUITY_VERSION;
    const headers: Record<string, string> = {
      accept: "application/json",
      "poppy-session": await signSessionJwt({ delegated: c.delegated, delegation: c.delegation, clientId: this.clientId, aud: opts.aud ?? company.aud, sid: c.sid, sub: c.sub, method, url, accessToken: token ?? undefined }),
      "poppy-version": POPPY_VERSION,
    };
    // The same Poppy-Extensions on every request in a Session (spec 3.4).
    if (Object.keys(extensions).length) headers["poppy-extensions"] = serializeExtensions(extensions);
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.act) {
      headers["act-occurrence-key"] = opts.act.occurrence_key;
      headers["act-executor-epoch"] = String(opts.act.executor_epoch);
      headers["act-recovery-generation"] = String(opts.act.recovery_generation);
      headers["act-job"] = opts.act.job_id;
      headers["act-operation"] = opts.act.operation_id;
    }
    if (opts.approval) headers["poppy-approval"] = approvalHeader(opts.approval);
    opts.tamper?.(headers);
    let res: globalThis.Response;
    try {
      res = await this.loopback.fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    } catch (e) {
      throw new NetworkError(`${method} ${path}: no response (${(e as Error).message})`);
    }
    const text = await res.text();
    let body: Record<string, any> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, headers: res.headers, body };
  }

  // -- the owner channel ------------------------------------------------------------------------

  private async owner(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, any>> {
    this.alive();
    const res = await this.loopback.fetch(`${this.ownerOrigin}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.grant}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = (await res.json()) as Record<string, any>;
    if (!res.ok) throw Object.assign(new Error(`owner ${path}: ${out.error}: ${out.error_description}`), { status: res.status, code: out.error });
    return out;
  }

  async grantView(): Promise<GrantView> {
    return (await this.owner("GET", "/v1/grant")) as GrantView;
  }

  /**
   * Carry the owner's fence statement to the Company (docs/21 §3.4) and the sealed receipt back to
   * the owner. The receipt passes through this agent, so the owner trusts it only because of the
   * Company's signature, which it checks against the key it pinned for the profile digest.
   */
  async carryFence(company: CompanyDoc) {
    const view = await this.grantView();
    if (!view.fence_statement) throw new Error("no fence statement to carry");
    const res = await this.request(company, "POST", new URL(company.continuity!.fence_endpoint).pathname, { body: { fence_statement: view.fence_statement } });
    if (res.status !== 200) {
      this.log(`fence refused by ${company.name}: ${res.status} ${res.body.error}`, { body: res.body });
      // Tell the owner, which holds the job: a fence that was not adopted decides nothing about entry.
      await this.owner("POST", "/v1/fence-failures", { status: res.status, error: res.body.error ?? null });
      return { ok: false as const, response: res };
    }
    const signature = res.headers.get(SIGNATURE_HEADER);
    this.log(`fence adopted at epoch ${res.body.fence.executor_epoch}; receipt ${res.body.receipt.receipt_id} seals through epoch ${res.body.receipt.sealed_through_executor_epoch} and lists ${res.body.receipt.sealed_occurrences.length} occurrence(s)`);
    const recorded = await this.owner("POST", "/v1/fence-receipts", { receipt: res.body.receipt, receipt_signature: signature });
    this.log(`handed the receipt to the owner; it verified the signature (kid ${String(recorded.kid).slice(0, 10)}…)`, { resolutions: recorded.resolutions });
    return { ok: true as const, response: res, receipt: res.body.receipt as Record<string, unknown>, signature: signature!, resolutions: recorded.resolutions as { operation_id: string; resolution: string }[] };
  }

  /** PL1 status by occurrence key, at the endpoint the Company's poppy.json names (docs/21 §3.1). */
  async occurrenceStatus(company: CompanyDoc, occurrenceKey: string): Promise<Response> {
    const url = company.continuity!.occurrence_endpoint.replace("{occurrence_key}", encodeURIComponent(occurrenceKey));
    return this.request(company, "GET", new URL(url).pathname);
  }

  /** The latest fence adoption receipt for a job, at the endpoint poppy.json names. */
  async readReceipt(company: CompanyDoc, jobRef: string): Promise<Response> {
    const url = company.continuity!.receipt_endpoint.replace("{job}", encodeURIComponent(jobRef));
    return this.request(company, "GET", new URL(url).pathname);
  }

  /** Commit the send claim at the owner (before any I/O), then ask the Company. Stops at approval_required. */
  async startBooking(company: CompanyDoc, operationId: string): Promise<{ claim: Claim; act: ActBinding; first: Response }> {
    const claim = (await this.owner("POST", "/v1/claims", { operation_id: operationId })) as Claim;
    const act: ActBinding = { occurrence_key: claim.occurrence_key, executor_epoch: claim.executor_epoch, recovery_generation: claim.recovery_generation, job_id: claim.job_ref, operation_id: claim.operation_id };
    this.log(`claimed ${operationId} at the owner (epoch ${claim.executor_epoch}, occurrence ${claim.occurrence_key.slice(0, 12)}…)`);
    const first = await this.request(company, "POST", "/api/bookings", { body: claim.request, act });
    this.log(`POST /api/bookings -> ${first.status} ${first.body.error ?? first.headers.get("travel26-disposition") ?? ""}`.trim());
    return { claim, act, first };
  }

  /** Send the same request again with John's approval (Operations §6). */
  async sendApproved(company: CompanyDoc, claim: Claim, act: ActBinding | null, approval: Approval): Promise<Response> {
    let res: Response;
    try {
      res = await this.request(company, "POST", "/api/bookings", { body: claim.request, act, approval });
    } catch (e) {
      if (e instanceof NetworkError) this.log(`POST /api/bookings with approval of ${approval.operation_id} (epoch ${act?.executor_epoch ?? "none"}) -> no response: did it enter?`);
      throw e;
    }
    this.log(`POST /api/bookings with approval of ${approval.operation_id} (epoch ${act?.executor_epoch ?? "none"}) -> ${res.status} ${res.body.error ?? res.headers.get("travel26-disposition") ?? ""}`.trim());
    return res;
  }

  async report(operationId: string, report: { kind: "performed"; native_reference: string; native_status: string } | { kind: "unknown"; detail: string }): Promise<void> {
    await this.owner("POST", "/v1/outcomes", { operation_id: operationId, report });
  }

  async readBooking(company: CompanyDoc, bookingId: string): Promise<Response> {
    const res = await this.request(company, "GET", `/api/bookings/${encodeURIComponent(bookingId)}`);
    this.log(`GET /api/bookings/${bookingId} -> ${res.status} ${res.body.booking?.status ?? res.body.error ?? ""}`);
    return res;
  }

  /** Simulated kill: the agent stops, its server closes, and its route disappears. In-process; see README. */
  async kill(): Promise<void> {
    this.dead = true;
    await this.app.close();
    // On a host, the route belongs to the host and its other agents; this instance just stops.
    if (!this.hosted) this.loopback.unroute(this.identity.origin);
    this.log("killed (process stopped; no further requests, no report to the owner)");
  }
}

