import { loadMymuseConfig } from "./mymuse/config.js";
import { buildMymuse } from "./mymuse/app.js";

const config = loadMymuseConfig();
const { app } = await buildMymuse(config);
await app.listen({ port: config.port, host: config.host });
app.log.info({ mode: config.mode, brain: config.brain, index: config.indexBaseUrl, inkbox: config.inkboxBaseUrl, locator: config.locator, card: `${config.publicBaseUrl}/poppy.json` }, "mymuse up");
