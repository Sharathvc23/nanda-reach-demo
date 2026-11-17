/**
 * mymuse as a continuity executor for act.stellarminds.ai, when ACT_EXECUTOR=1. Off by default:
 * nothing here runs and no route is added unless it is enabled.
 *
 * - John on Muse is this host's Poppy client: the same client_id, client metadata and key. Its
 *   sign-in redirect (/poppy/callback) goes to whichever run started that sign-in.
 * - John on Wajo is a second Poppy client at /wajo, with its own key kept in the store.
 * - John's card names each agent's Poppy client and the continuity extension, so his continuity
 *   service (at act.stellarminds.ai) can pick a successor from the card it finds in the NANDA Index.
 * - act.stellarminds.ai drives each run's instances over the control channel, with its token.
 *
 * The protocol code is vendored from act-poppy-demo (src/act, see its README).
 */
import type { FastifyInstance } from "fastify";
import { ExecutorHost } from "../act/executor/host.js";
import { Loopback } from "../act/shared/net.js";
import { generateEs256Key, keyFromPrivateJwk } from "../act/shared/poppy.js";
import type { JsonStore } from "../shared/store.js";
import type { MymuseConfig } from "./config.js";
import type { MymuseState } from "./card.js";
import type { PoppyClient } from "./poppy-client.js";

export const CONTINUITY_TAG = "stellarminds.ai/act-continuity;v=1";

export interface ActExecutorConfig {
  controlToken: string;
  /** act.stellarminds.ai's run prefix, e.g. https://act.stellarminds.ai/runs/ */
  ownerPrefix: string;
  /** Companies the agents may be pointed at: the ACT edition of Travel26. */
  companies: string[];
}

/** The Poppy client_id of each of John's agents, when mymuse hosts them as executors. */
export function executorClientIds(publicBaseUrl: string): Record<string, string> {
  return { muse: `${publicBaseUrl}/poppy/client.json`, wajo: `${publicBaseUrl}/wajo/poppy/client.json` };
}

export async function registerActExecutor(app: FastifyInstance, opts: { config: MymuseConfig; act: ActExecutorConfig; store: JsonStore<MymuseState>; poppy: PoppyClient }): Promise<ExecutorHost> {
  const { config, act, store, poppy } = opts;
  if (!store.state.keys.wajo) {
    store.state.keys.wajo = (await generateEs256Key()).privateJwk;
    store.save();
  }
  const host = new ExecutorHost({
    agents: [
      { identity: { id: "muse", name: config.muse.name, harness: config.muse.harness, origin: config.publicBaseUrl }, key: await poppy.rootKey() },
      { identity: { id: "wajo", name: config.wajo.name, harness: config.wajo.harness, origin: `${config.publicBaseUrl}/wajo` }, key: await keyFromPrivateJwk(store.state.keys.wajo) },
    ],
    loopback: new Loopback({ live: true }),
    controlToken: act.controlToken,
    ownerPrefix: act.ownerPrefix,
    companies: act.companies,
  });
  // Muse's client metadata, key set and callback are mymuse's own routes; Wajo's are the host's.
  host.register(app, ["wajo"]);
  return host;
}
