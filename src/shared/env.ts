export type Mode = "mock" | "live";
export type Overrides = Partial<Record<string, string>>;

/** Read a setting: explicit override first, then the environment, then the fallback. */
export function env(name: string, fallback: string, overrides: Overrides = {}): string {
  const o = overrides[name];
  if (o !== undefined && o !== "") return o;
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const stripSlash = (s: string): string => s.replace(/\/+$/, "");

/** A NANDA locator, the only thing a merchant should ever keep about a person. */
export const LOCATOR = /^urn:air:[A-Za-z0-9][A-Za-z0-9.:_@/-]{0,299}$/;

export interface SharedConfig {
  mode: Mode;
  port: number;
  host: string;
  /** Public origin of the service, used in the documents it serves. Mutable so tests can set it after listen. */
  publicBaseUrl: string;
  indexBaseUrl: string;
  inkboxBaseUrl: string;
  adminToken: string;
  dataDir: string;
}

/**
 * Settings common to both services. MODE=live (the default) points at the real NANDA Index
 * and the real InkBox. MODE=mock points at the in-process stand-ins at MOCK_BASE_URL, which
 * only the tests and the local all-in-one dev runner use.
 */
export function loadShared(defaultPort: number, overrides: Overrides = {}): SharedConfig {
  const mode: Mode = env("MODE", "live", overrides) === "mock" ? "mock" : "live";
  const port = Number(env("PORT", String(defaultPort), overrides));
  const mockBase = stripSlash(env("MOCK_BASE_URL", "http://localhost:8097", overrides));
  return {
    mode,
    port,
    host: env("HOST", "0.0.0.0", overrides),
    publicBaseUrl: stripSlash(env("PUBLIC_BASE_URL", `http://localhost:${port}`, overrides)),
    indexBaseUrl: stripSlash(env("INDEX_BASE_URL", mode === "live" ? "https://api.nandaindex.org" : `${mockBase}/index`, overrides)),
    inkboxBaseUrl: stripSlash(env("INKBOX_BASE_URL", mode === "live" ? "https://inkbox.ai/api/v1" : `${mockBase}/inkbox`, overrides)),
    adminToken: env("ADMIN_TOKEN", "", overrides),
    dataDir: env("DATA_DIR", "./data", overrides),
  };
}
