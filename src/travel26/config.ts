import { env, loadShared, type Overrides, type SharedConfig } from "../shared/env.js";

export interface Travel26Config extends SharedConfig {
  /** Travel26's own InkBox mailbox, which it sends from. */
  address: string;
  apiKey: string;
}

export function loadTravel26Config(overrides: Overrides = {}): Travel26Config {
  return {
    ...loadShared(8095, overrides),
    address: env("TRAVEL26_ADDRESS", "travel26@inkboxmail.test", overrides),
    apiKey: env("TRAVEL26_API_KEY", "mock-key-travel26", overrides),
  };
}
