/**
 * Hosts Personal Agents where their keys are, for the live site.
 *
 * Each agent has one identity: a `client_id` whose `jwks_uri` publishes one key. Each run of a
 * scenario gets its own instance of the agent (its own Sessions, sign-ins and owner grant) that
 * signs with that key, so runs never share state but the Company always sees the same Personal
 * Agent. The site drives an instance through a control channel (`POST /act/control/:agent/:method`)
 * that requires a bearer token; the channel exposes exactly the agent's own API (`AgentHandle`)
 * and nothing else, and the instance talks only to an owner under the configured prefix.
 *
 * The sign-in redirect comes back to the agent's `redirect_uri`, and the host hands it to the
 * instance that started that sign-in (by `state`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { NetworkError, PersonalAgent, type AgentIdentity } from "../agent/agent.js";
import type { Loopback } from "../shared/net.js";
import type { EcKey } from "../shared/poppy.js";
import { Timeline } from "../shared/timeline.js";
import { CONTROL_METHODS, toWire, type ControlLogEntry, type ControlMethod, type ControlRequest, type ControlResponse } from "./wire.js";

export interface HostedAgent {
  identity: AgentIdentity;
  key: EcKey;
}

export interface ExecutorHostOptions {
  agents: HostedAgent[];
  loopback: Loopback;
  /** Bearer token for the control channel. An empty token disables it. */
  controlToken: string;
  /** Owner base URLs an instance may talk to must start with this. */
  ownerPrefix: string;
  /** The Company origins an instance may be pointed at. The agent discovers each one itself. */
  companies: string[];
  /** Instances idle this long are dropped, ms. */
  idleMs?: number;
}

interface Instance {
  agent: PersonalAgent;
  timeline: Timeline;
  cursor: number;
  touched: number;
}

const sameToken = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class ExecutorHost {
  private readonly instances = new Map<string, Instance>();
  private readonly agents: Map<string, HostedAgent>;

  constructor(private readonly opts: ExecutorHostOptions) {
    this.agents = new Map(opts.agents.map((a) => [a.identity.id, a]));
  }

  /** The client metadata document an agent's `client_id` serves (spec 4.1). */
  clientMetadata(agentId: string) {
    const a = this.agent(agentId);
    return {
      client_id: `${a.identity.origin}/poppy/client.json`,
      client_name: a.identity.name,
      jwks_uri: `${a.identity.origin}/poppy/jwks.json`,
      redirect_uris: [`${a.identity.origin}/poppy/callback`],
      token_endpoint_auth_method: "private_key_jwt",
    };
  }

  jwks(agentId: string) {
    return { keys: [this.agent(agentId).key.publicJwk] };
  }

  /** The sign-in redirect: give it to the instance that is waiting for this `state`. */
  async callback(agentId: string, query: Record<string, string>): Promise<{ signed_in: true }> {
    this.agent(agentId);
    const state = String(query.state ?? "");
    for (const [key, inst] of this.instances) {
      if (key.startsWith(`${agentId}|`) && inst.agent.ownsSignInState(state)) {
        await inst.agent.handleCallback(query);
        inst.touched = Date.now();
        return { signed_in: true };
      }
    }
    throw new Error("no sign-in is waiting for this state");
  }

  /**
   * Register the routes. `metadataFor` lists the agents whose client metadata, jwks and callback
   * this host serves itself; leave out an agent whose application already serves them.
   */
  register(app: FastifyInstance, metadataFor: string[] = [...this.agents.keys()]): void {
    for (const id of metadataFor) {
      const base = new URL(this.agent(id).identity.origin).pathname.replace(/\/+$/, "");
      app.get(`${base}/poppy/client.json`, async (_req, reply) => reply.header("cache-control", "public, max-age=300").send(this.clientMetadata(id)));
      app.get(`${base}/poppy/jwks.json`, async (_req, reply) => reply.header("cache-control", "public, max-age=300").send(this.jwks(id)));
      app.get(`${base}/poppy/callback`, async (req, reply) => {
        try {
          return await this.callback(id, req.query as Record<string, string>);
        } catch (e) {
          return reply.code(400).send({ error: "sign_in_failed", error_description: (e as Error).message });
        }
      });
    }
    app.post("/act/control/:agent/:method", async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = String(req.headers.authorization ?? "");
      if (!this.opts.controlToken || !sameToken(auth, `Bearer ${this.opts.controlToken}`)) return reply.code(404).send({ error: "not_found" });
      const { agent, method } = req.params as { agent: string; method: string };
      const out = await this.control(agent, method, req.body);
      return reply.code(out.ok ? 200 : 422).send(out);
    });
  }

  private agent(id: string): HostedAgent {
    const a = this.agents.get(id);
    if (!a) throw new Error(`unknown agent ${id}`);
    return a;
  }

  private instance(agentId: string, run: string, owner: string): Instance {
    this.sweep();
    const key = `${agentId}|${run}`;
    let inst = this.instances.get(key);
    if (!inst) {
      const a = this.agent(agentId);
      const timeline = new Timeline();
      inst = { agent: PersonalAgent.withKey(a.identity, a.key, this.opts.loopback, owner, timeline), timeline, cursor: 0, touched: Date.now() };
      this.instances.set(key, inst);
    }
    inst.touched = Date.now();
    return inst;
  }

  private sweep(): void {
    const idle = this.opts.idleMs ?? 60 * 60 * 1000;
    for (const [key, inst] of this.instances) if (Date.now() - inst.touched > idle) this.instances.delete(key);
  }

  /**
   * The control channel carries arguments, never authority. A Company is named only by origin, which
   * must be on the allowlist, and the agent uses its own discovery of it, so a caller cannot point
   * the agent's Session or access token at another host. Request options are rebuilt from the four
   * plain fields, so a caller cannot sign over a foreign token or audience.
   */
  private async sanitize(agent: PersonalAgent, method: ControlMethod, args: unknown[]): Promise<unknown[]> {
    const company = async (v: unknown) => {
      const given = (typeof v === "object" && v !== null ? v : {}) as { origin?: unknown; continuity?: unknown; operations?: unknown };
      const origin = typeof v === "string" ? v : String(given.origin ?? "");
      if (!this.opts.companies.includes(origin)) throw new Error(`company ${origin || "(none)"} is not on this host's allowlist`);
      const own = agent.cachedCompany(origin) ?? (await agent.discover(origin));
      // A caller may narrow what the agent declares (a scenario drops the continuity extension to
      // see Poppy's extension_required), never redirect where it sends its Session or token.
      return { ...own, ...(given.continuity === null ? { continuity: null } : {}), ...(given.operations === false ? { operations: false } : {}) };
    };
    const text = (v: unknown, name: string) => {
      if (typeof v !== "string" || v.length > 512) throw new Error(`${name} must be a short string`);
      return v;
    };
    switch (method) {
      case "grantView":
      case "kill":
        return [];
      case "setGrant":
        return [text(args[0], "grant")];
      case "discover": {
        const doc = await company(args[0]);
        return [doc.origin];
      }
      case "report":
        return [text(args[0], "operation_id"), args[1]];
      case "request": {
        const o = (args[3] ?? {}) as Record<string, unknown>;
        const opts = { body: o.body, act: o.act ?? null, approval: o.approval ?? null, signedOut: o.signedOut === true };
        const path = text(args[2], "path");
        if (!/^\/(?!\/)/.test(path)) throw new Error("path must start with a single /");
        return [await company(args[0]), text(args[1], "method"), path, opts];
      }
      case "beginSignIn": {
        const scopes = Array.isArray(args[1]) && args[1].every((s) => typeof s === "string") ? args[1] : [];
        return [await company(args[0]), scopes, args[2] ?? null];
      }
      default:
        // hasAccessToken, pairwiseUserId, carryFence, occurrenceStatus, readReceipt, startBooking,
        // sendApproved, readBooking: the Company first, then plain data.
        return [await company(args[0]), ...args.slice(1)];
    }
  }

  async control(agentId: string, method: string, body: unknown): Promise<ControlResponse> {
    const req = (body ?? {}) as Partial<ControlRequest>;
    const fail = (name: string, message: string, log: ControlLogEntry[] = []): ControlResponse => ({ ok: false, error: { name, message }, log });
    if (!this.agents.has(agentId)) return fail("Error", `unknown agent ${agentId}`);
    if (!(CONTROL_METHODS as readonly string[]).includes(method)) return fail("Error", `unknown method ${method}`);
    if (typeof req.run !== "string" || !/^[a-z0-9]{6,40}$/.test(req.run)) return fail("Error", "run must be 6 to 40 lowercase letters or digits");
    if (typeof req.owner !== "string" || !req.owner.startsWith(this.opts.ownerPrefix)) return fail("Error", "owner is not under the allowed prefix");
    const inst = this.instance(agentId, req.run, req.owner);
    const args = Array.isArray(req.args) ? req.args : [];
    const drain = (): ControlLogEntry[] => {
      const out = inst.timeline.entries.slice(inst.cursor).map(({ at, actor, text, data }) => ({ at, actor, text, ...(data ? { data } : {}) }));
      inst.cursor = inst.timeline.entries.length;
      return out;
    };
    try {
      const clean = await this.sanitize(inst.agent, method as ControlMethod, args);
      const fn = (inst.agent as unknown as Record<ControlMethod, (...a: unknown[]) => Promise<unknown>>)[method as ControlMethod];
      const result = await fn.apply(inst.agent, clean);
      return { ok: true, result: toWire(result ?? null), log: drain() };
    } catch (e) {
      const err = e as Error & { status?: number; code?: string };
      return { ok: false, error: { name: e instanceof NetworkError ? "NetworkError" : err.name, message: err.message, ...(err.status ? { status: err.status } : {}), ...(err.code ? { code: err.code } : {}) }, log: drain() };
    }
  }
}
