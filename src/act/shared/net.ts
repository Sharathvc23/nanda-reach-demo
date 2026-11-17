/**
 * The demo's network. Every party names itself and the others by an HTTPS URL, as Poppy requires of
 * every URL it exchanges (spec section 3).
 *
 * In the local demo and the tests, every party runs in one process under the reserved `.test` TLD
 * (RFC 6761). This resolver maps each `https://<name>.test` base to a server on 127.0.0.1 and
 * passes the request through unchanged. It stands in for DNS plus a TLS-terminating proxy, and it
 * is the one place a loopback address is reached, which Poppy allows only when configured on
 * purpose (spec section 3).
 *
 * On the live site (`live: true`), John's side routes its own public base to the local server
 * that hosts it, and every other HTTPS URL, Travel26's included, goes out over the real network.
 *
 * A route is a URL prefix: an origin (`https://muse.test`), or an origin and a path
 * (`https://act.stellarminds.ai/runs/r1/muse`). The longest matching prefix wins, and the
 * request keeps its full path.
 */
import { lookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Addresses a live fetch must never reach: loopback, private, link-local, shared, reserved and
 * multicast ranges, and IPv6 forms that embed an IPv4 address (6to4, NAT64, IPv4-compatible).
 * `BlockList` parses each address, so IPv4-mapped IPv6 in any spelling is checked against the IPv4
 * rules.
 */
const NON_PUBLIC = (() => {
  const b = new BlockList();
  for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) b.addSubnet(net, prefix, "ipv4");
  for (const [net, prefix] of [["::", 96], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) b.addSubnet(net, prefix, "ipv6");
  return b;
})();

export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return NON_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The DNS lookup every live connection makes. It refuses a host with any non-public address at
 * connect time, so the address that was checked is the one that is dialled: a name that resolves
 * differently between a check and the connection (DNS rebinding) gains nothing.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as { address: string; family: number }[];
    if (list.length === 0 || list.some((a) => isNonPublicAddress(a.address))) {
      return callback(Object.assign(new Error(`fetch refused: ${hostname} is not a public address`), { code: "ENOTPUBLIC" }), "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

/** A live fetch: public addresses only, no redirects followed. */
async function publicFetch(url: string, init: RequestInit | undefined): Promise<Response> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  // An IP literal is not looked up, so check it here.
  if (isIP(host) && isNonPublicAddress(host)) throw new TypeError(`fetch refused: ${host} is not a public address`);
  try {
    return (await undiciFetch(url, { ...(init as object), redirect: "manual", dispatcher: publicOnly })) as unknown as Response;
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "ENOTPUBLIC") throw new TypeError(cause.message);
    throw e;
  }
}

export interface NetOptions {
  /** Route any HTTPS base, not only `*.test`, and send unrouted HTTPS requests out. */
  live?: boolean;
}

export class Loopback {
  private readonly routes = new Map<string, string>();
  /** Requests that the resolver refused because no route was configured. */
  readonly refused: string[] = [];

  constructor(private readonly opts: NetOptions = {}) {}

  route(publicBase: string, localOrigin: string): void {
    this.routes.set(Loopback.prefix(publicBase, this.opts.live === true), localOrigin.replace(/\/+$/, ""));
  }

  unroute(publicBase: string): void {
    this.routes.delete(Loopback.prefix(publicBase, this.opts.live === true));
  }

  private static prefix(base: string, live: boolean): string {
    const u = new URL(base);
    if (u.protocol !== "https:") throw new Error(`${base}: party URLs are https`);
    if (!live && !u.hostname.endsWith(".test")) throw new Error(`${base}: demo origins are https://*.test`);
    if (u.search || u.hash) throw new Error(`${base}: a route is an origin and an optional path`);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  }

  private match(u: URL): string | undefined {
    const target = `${u.origin}${u.pathname}`;
    let best: string | undefined;
    for (const prefix of this.routes.keys()) {
      const hit = target === prefix || target.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`) || prefix === u.origin;
      if (hit && (!best || prefix.length > best.length)) best = prefix;
    }
    return best;
  }

  /**
   * A `fetch` that reaches configured routes, and on the live site any other HTTPS URL. It never
   * follows redirects (Poppy forbids following them for client metadata, spec 4.1).
   */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    const prefix = u.protocol === "https:" ? this.match(u) : undefined;
    if (prefix) return fetch(`${this.routes.get(prefix)}${u.pathname}${u.search}`, { ...init, redirect: "manual" });
    if (this.opts.live && u.protocol === "https:") return publicFetch(url, init);
    this.refused.push(url);
    throw new TypeError(`fetch failed: no route to ${u.origin}`);
  };
}
