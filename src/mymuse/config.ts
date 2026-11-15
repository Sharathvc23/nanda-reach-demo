import { env, loadShared, stripSlash, type Overrides, type SharedConfig } from "../shared/env.js";
import type { Mailbox } from "../shared/inkbox.js";

export type Brain = "llm" | "scripted";

export interface MymuseConfig extends SharedConfig {
  owner: string;
  /** John's NANDA locator: urn:air:host39.org:personal:<his first InkBox address>. */
  locator: string;
  /** The agent's own mailbox (John on Muse). */
  muse: Mailbox & { name: string; harness: string };
  /** John's second agent's mailbox (John on Wajo). The key is only needed to show that inbox in the console. */
  wajo: Mailbox & { name: string; harness: string };
  /** The merchant the agent shops at when John does not name one. */
  travel26Url: string;
  brain: Brain;
  model: string;
  /** Whether John lets companies that support nandaindex.org/reach keep his locator. */
  shareLocator: boolean;
  /** John's NANDA Index account, used when he moves his card so his entry follows. */
  indexAccount: { email: string; password: string; orgId: string };
}

export function loadMymuseConfig(overrides: Overrides = {}): MymuseConfig {
  const museAddress = env("MYMUSE_ADDRESS", "john-muse@inkboxmail.test", overrides);
  const brainSetting = env("AGENT_BRAIN", "", overrides);
  const brain: Brain = brainSetting === "scripted" || brainSetting === "llm" ? brainSetting : process.env.ANTHROPIC_API_KEY ? "llm" : "scripted";
  const shared = loadShared(8096, overrides);
  const mode = shared.mode;
  return {
    ...shared,
    owner: env("OWNER_NAME", "John", overrides),
    locator: env("JOHN_LOCATOR", `urn:air:host39.org:personal:${museAddress}`, overrides),
    muse: { name: "John on Muse", harness: "Muse", address: museAddress, apiKey: env("MYMUSE_API_KEY", mode === "mock" ? "mock-key-muse" : "", overrides) },
    wajo: { name: "John on Wajo", harness: "Wajo", address: env("WAJO_ADDRESS", "john-wajo@inkboxmail.test", overrides), apiKey: env("WAJO_API_KEY", mode === "mock" ? "mock-key-wajo" : "", overrides) },
    travel26Url: stripSlash(env("TRAVEL26_URL", "http://localhost:8095", overrides)),
    brain,
    model: env("AGENT_MODEL", "claude-opus-5-5", overrides),
    shareLocator: env("SHARE_LOCATOR", "true", overrides) !== "false",
    indexAccount: { email: env("INDEX_EMAIL", "", overrides), password: env("INDEX_PASSWORD", "", overrides), orgId: env("INDEX_ORG_ID", "mymuse", overrides) },
  };
}
