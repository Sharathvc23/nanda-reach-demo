import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonStore } from "../shared/store.js";
import { POPPY_VERSION, REACH_EXTENSION, REACH_VERSION, audienceOf, generateEs256Key, keyFromPrivateJwk, nowSeconds, randomId, signDelegation, signSessionJwt, type EcKey } from "../shared/poppy.js";
import type { MymuseConfig } from "./config.js";
import type { MymuseState } from "./card.js";

/** A Company's poppy.json, the parts a Personal Agent needs. */
export interface CompanyDoc {
  url: string;
  aud: string;
  protocol_version: string;
  organization: { name: string; domain: string };
  apis: { type: string; url: string; description: string }[];
  agent?: { protocols: { type: string; endpoint: string; description: string }[] };
  extensions: Record<string, { version: string; [k: string]: unknown }[]>;
  reach: boolean;
  raw: unknown;
}

/**
 * The Personal Agent side of Poppy 1.0: identity (client metadata and keys), one pseudonymous
 * User ID and Session per Company, a Session JWT on every request, and MCP calls through it.
 */
export class PoppyClient {
  private root: EcKey | null = null;

  constructor(private readonly config: MymuseConfig, private readonly store: JsonStore<MymuseState>, private readonly fetchFn: typeof fetch = fetch) {}

  get clientId(): string {
    return `${this.config.publicBaseUrl}/poppy/client.json`;
  }

  /** The root key, generated once and kept in the store. Its public half is served at jwks_uri. */
  async rootKey(): Promise<EcKey> {
    if (this.root) return this.root;
    if (!this.store.state.keys.root) {
      this.store.state.keys.root = (await generateEs256Key()).privateJwk;
      this.store.save();
    }
    this.root = await keyFromPrivateJwk(this.store.state.keys.root);
    return this.root;
  }

  /** The client metadata document (spec 4.1), plus the reach extension's field. */
  async clientMetadata() {
    const base = this.config.publicBaseUrl;
    return {
      client_id: this.clientId,
      client_name: "mymuse",
      jwks_uri: `${base}/poppy/jwks.json`,
      redirect_uris: [`${base}/poppy/callback`],
      token_endpoint_auth_method: "private_key_jwt",
      nanda_locator: this.config.locator,
      nanda_card: `${base}${this.store.state.card_path ?? "/.well-known/agent-card.json"}`,
    };
  }

  async jwks() {
    const root = await this.rootKey();
    return { keys: [root.publicJwk] };
  }

  private checkUrl(url: string): URL {
    const u = new URL(url);
    if (u.protocol !== "https:" && !(this.config.mode === "mock" && u.protocol === "http:")) throw new Error(`${url}: Poppy requires https`);
    return u;
  }

  /** Discover a Company from its origin (spec section 3). */
  async discover(origin: string): Promise<CompanyDoc> {
    const u = this.checkUrl(origin);
    const url = `${u.origin}/.well-known/poppy.json`;
    const res = await this.fetchFn(url, { headers: { accept: "application/json", "user-agent": "mymuse/0.1 (poppy)" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}: not a Poppy Company`);
    const doc = (await res.json()) as Record<string, unknown>;
    const pv = String(doc.protocol_version ?? "");
    if (pv.split(".")[0] !== POPPY_VERSION.split(".")[0]) throw new Error(`poppy.json protocol_version ${pv} is not one I speak`);
    const org = doc.organization as { name: string; domain: string } | undefined;
    if (!org?.domain || org.domain.toLowerCase() !== u.host.toLowerCase()) throw new Error(`organization.domain ${org?.domain ?? "(missing)"} does not match ${u.host}`);
    const extensions = (doc.extensions ?? {}) as CompanyDoc["extensions"];
    const reach = Array.isArray(extensions[REACH_EXTENSION]) && extensions[REACH_EXTENSION].some((e) => e.version === REACH_VERSION);
    return {
      url,
      aud: audienceOf(`${u.protocol}//${org.domain}`),
      protocol_version: pv,
      organization: org,
      apis: (doc.apis as CompanyDoc["apis"]) ?? [],
      agent: doc.agent as CompanyDoc["agent"],
      extensions,
      reach,
      raw: doc,
    };
  }

  /** The per-Company state: pseudonymous User ID, Session ID, delegated key and its delegation (spec 5.1, 5.2). */
  private async companyState(aud: string) {
    const companies = this.store.state.companies;
    let c = companies[aud];
    if (!c) {
      const delegated = await generateEs256Key();
      c = { sub: randomId(16), sid: randomId(16), delegated_private_jwk: delegated.privateJwk, delegation: null, delegation_exp: 0, share_locator: this.config.shareLocator };
      companies[aud] = c;
    }
    const delegated = await keyFromPrivateJwk(c.delegated_private_jwk);
    if (!c.delegation || c.delegation_exp - 300 < nowSeconds()) {
      const d = await signDelegation(await this.rootKey(), delegated, this.clientId, 2 * 3600);
      c.delegation = d.jwt;
      c.delegation_exp = d.exp;
    }
    this.store.save();
    return { ...c, delegated };
  }

  /** Headers for one request to this Company (spec 5.2, 3.4). */
  async headersFor(company: CompanyDoc, method: string, url: string): Promise<Record<string, string>> {
    const c = await this.companyState(company.aud);
    const headers: Record<string, string> = {
      "poppy-session": await signSessionJwt({ delegated: c.delegated, delegation: c.delegation!, clientId: this.clientId, aud: company.aud, sid: c.sid, sub: c.sub, agentId: "muse", method, url }),
      "poppy-version": POPPY_VERSION,
    };
    if (company.reach && c.share_locator) headers["poppy-extensions"] = `"${REACH_EXTENSION}";v="${REACH_VERSION}"`;
    return headers;
  }

  /** Start a fresh Session with this Company (spec 5.5: after session_ended). */
  async newSession(aud: string): Promise<void> {
    const c = this.store.state.companies[aud];
    if (c) {
      c.sid = randomId(16);
      this.store.save();
    }
  }

  /** Call a tool on one of the Company's MCP servers, with a Session JWT on every HTTP request. */
  async callMcpTool(company: CompanyDoc, mcpUrl: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; structured: unknown }> {
    this.checkUrl(mcpUrl);
    const poppyFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(await this.headersFor(company, method, url))) headers.set(k, v);
      headers.set("user-agent", "mymuse/0.1 (poppy)");
      return this.fetchFn(input, { ...init, headers });
    };
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { fetch: poppyFetch });
    const client = new Client({ name: "mymuse", version: "0.1.0" });
    try {
      await client.connect(transport);
      const result = (await client.callTool({ name: tool, arguments: args })) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
      const text = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      if (result.isError) throw new Error(`tool ${tool} failed: ${text.slice(0, 300)}`);
      return { text, structured: result.structuredContent ?? null };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** What this agent currently holds for a Company, for the console. */
  sessionSummary(aud: string) {
    const c = this.store.state.companies[aud];
    return c ? { user_id: c.sub, session_id: c.sid, share_locator: c.share_locator, delegation_expires: new Date(c.delegation_exp * 1000).toISOString() } : null;
  }
}
