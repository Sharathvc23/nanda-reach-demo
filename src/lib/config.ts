/**
 * Runtime configuration. Everything comes from the environment. The default, MODE=live, talks
 * to the real NANDA Index (api.nandaindex.org) and the real InkBox (inkbox.ai). MODE=mock
 * exists for the automated tests only: it points both base URLs at in-process stand-ins.
 */
export type Mode = "mock" | "live";

export interface AgentInbox {
  /** Short id used in the card's routing rules: "muse" or "wajo". */
  id: "muse" | "wajo";
  name: string;
  harness: string;
  address: string;
  /** InkBox API key for reading this inbox in the console. Empty in mock mode is fine. */
  apiKey: string;
}

export interface Config {
  mode: Mode;
  port: number;
  host: string;
  /** Public origin of this service, used in poppy.json and the card URL. */
  publicBaseUrl: string;
  indexBaseUrl: string;
  inkboxBaseUrl: string;
  adminToken: string;
  dataDir: string;
  john: {
    locator: string;
    cardPath: string;
    muse: AgentInbox;
    wajo: AgentInbox;
  };
  travel26: {
    address: string;
    apiKey: string;
  };
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): Config {
  const get = (name: string, fallback: string) => overrides[name] ?? env(name, fallback);
  const mode: Mode = get("MODE", "live") === "mock" ? "mock" : "live";
  const port = Number(get("PORT", "8095"));
  const publicBaseUrl = get("PUBLIC_BASE_URL", `http://localhost:${port}`).replace(/\/+$/, "");
  const johnEmail = get("JOHN_EMAIL", "john@example.test");
  return {
    mode,
    port,
    host: get("HOST", "0.0.0.0"),
    publicBaseUrl,
    indexBaseUrl:
      mode === "live"
        ? get("INDEX_BASE_URL", "https://api.nandaindex.org").replace(/\/+$/, "")
        : get("INDEX_BASE_URL", `${publicBaseUrl}/mock/index`).replace(/\/+$/, ""),
    inkboxBaseUrl:
      mode === "live"
        ? get("INKBOX_BASE_URL", "https://inkbox.ai/api/v1").replace(/\/+$/, "")
        : get("INKBOX_BASE_URL", `${publicBaseUrl}/mock/inkbox`).replace(/\/+$/, ""),
    adminToken: get("ADMIN_TOKEN", ""),
    dataDir: get("DATA_DIR", "./data"),
    john: {
      locator: get("JOHN_LOCATOR", `urn:air:host39.org:personal:${johnEmail}`),
      cardPath: "/cards/john",
      muse: {
        id: "muse",
        name: "John on Muse",
        harness: "Muse",
        address: get("JOHN_MUSE_ADDRESS", "john-muse@inkboxmail.test"),
        apiKey: get("JOHN_MUSE_API_KEY", "mock-key-muse"),
      },
      wajo: {
        id: "wajo",
        name: "John on Wajo",
        harness: "Wajo",
        address: get("JOHN_WAJO_ADDRESS", "john-wajo@inkboxmail.test"),
        apiKey: get("JOHN_WAJO_API_KEY", "mock-key-wajo"),
      },
    },
    travel26: {
      address: get("TRAVEL26_ADDRESS", "travel26@inkboxmail.test"),
      apiKey: get("TRAVEL26_API_KEY", "mock-key-travel26"),
    },
  };
}
