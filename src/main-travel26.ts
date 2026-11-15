import { loadTravel26Config } from "./travel26/config.js";
import { buildTravel26 } from "./travel26/app.js";

const config = loadTravel26Config();
const { app } = await buildTravel26(config);
await app.listen({ port: config.port, host: config.host });
app.log.info({ mode: config.mode, index: config.indexBaseUrl, inkbox: config.inkboxBaseUrl, card: `${config.publicBaseUrl}/.well-known/agent-card.json` }, "travel26 up");
