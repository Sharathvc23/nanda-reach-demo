/**
 * Local all-in-one runner: the mock Index and InkBox on 8097, Travel26 on 8095, mymuse on 8096.
 * `npm run dev` (always mock; the live services are deployed, not run from here). The agent's
 * brain is the LLM when a model API key is set, scripted otherwise; AGENT_BRAIN overrides.
 */
import { buildMock } from "./mock/app.js";
import { loadTravel26Config } from "./travel26/config.js";
import { buildTravel26 } from "./travel26/app.js";
import { loadMymuseConfig } from "./mymuse/config.js";
import { buildMymuse } from "./mymuse/app.js";

const mockBase = "http://localhost:8097";
const mock = await buildMock();
await mock.app.listen({ port: 8097, host: "127.0.0.1" });

const t26 = loadTravel26Config({ MODE: "mock", PORT: "8095", MOCK_BASE_URL: mockBase, DATA_DIR: "./data/travel26", PUBLIC_BASE_URL: "http://localhost:8095" });
const travel26 = await buildTravel26(t26);
await travel26.app.listen({ port: t26.port, host: "127.0.0.1" });

const mm = loadMymuseConfig({ MODE: "mock", PORT: "8096", MOCK_BASE_URL: mockBase, DATA_DIR: "./data/mymuse", PUBLIC_BASE_URL: "http://localhost:8096", TRAVEL26_URL: "http://localhost:8095" });
const mymuse = await buildMymuse(mm);
await mymuse.app.listen({ port: mm.port, host: "127.0.0.1" });
mock.seed(mm.locator, `${mm.publicBaseUrl}/.well-known/agent-card.json`);

console.log(`mock index+inkbox  ${mockBase}\ntravel26           ${t26.publicBaseUrl}\nmymuse (${mm.brain})     ${mm.publicBaseUrl}`);
