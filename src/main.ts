import { loadConfig } from "./lib/config.js";
import { buildApp } from "./app.js";

// `--mock` runs against the in-process stand-ins (what the tests use); the default is live.
const config = loadConfig(process.argv.includes("--mock") ? { MODE: "mock" } : {});
const { app } = await buildApp(config);
await app.listen({ port: config.port, host: config.host });
app.log.info(
  { mode: config.mode, index: config.indexBaseUrl, inkbox: config.inkboxBaseUrl, card: `${config.publicBaseUrl}${config.john.cardPath}` },
  "nanda-reach-demo up",
);
