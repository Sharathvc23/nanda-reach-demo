import { env, loadShared, type Overrides, type SharedConfig } from "../shared/env.js";

export interface Travel26Config extends SharedConfig {
  /** Travel26's own InkBox mailbox, which it sends from. */
  address: string;
  apiKey: string;
  /** Where InkBox serves agent cards for mailboxes (https://inkbox.ai/a2a/<handle>/card). */
  inkboxA2aBase: string;
}

export function loadTravel26Config(overrides: Overrides = {}): Travel26Config {
  const shared = loadShared(8095, overrides);
  return {
    ...shared,
    address: env("TRAVEL26_ADDRESS", "travel26@inkboxmail.test", overrides),
    apiKey: env("TRAVEL26_API_KEY", "mock-key-travel26", overrides),
    inkboxA2aBase: env("INKBOX_A2A_BASE", shared.mode === "live" ? "https://inkbox.ai" : shared.inkboxBaseUrl, overrides),
  };
}
