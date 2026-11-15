// Records the full run on the live demo page as a video. Usage:
//   node scripts/record-demo.mjs https://mymuse-production.up.railway.app recordings
// Reads ADMIN_TOKEN from .env.live (or the environment) for the page's buttons.
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const base = (process.argv[2] ?? "https://mymuse-production.up.railway.app").replace(/\/+$/, "");
const outDir = process.argv[3] ?? "recordings";
const envFile = existsSync(".env.live") ? Object.fromEntries(readFileSync(".env.live", "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })) : {};
const token = process.env.ADMIN_TOKEN || envFile.ADMIN_TOKEN || "";
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: outDir, size: { width: 1440, height: 900 } }, deviceScaleFactor: 1 });
await context.addInitScript((t) => { try { localStorage.setItem("adminToken", t); } catch {} }, token);
const page = await context.newPage();

const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);
const idle = async () => { await page.waitForFunction(() => ![...document.querySelectorAll("button")].some((b) => b.disabled), null, { timeout: 90_000 }); };
const press = async (label) => {
  const btn = page.getByRole("button", { name: label, exact: false }).first();
  await btn.scrollIntoViewIfNeeded();
  await btn.hover();
  await sleep(900);
  await btn.click();
  log(`pressed: ${label}`);
};
const waitText = async (selector, re, timeout = 90_000) => {
  await page.waitForFunction(([sel, src]) => new RegExp(src, "i").test(document.querySelector(sel)?.textContent ?? ""), [selector, re.source], { timeout });
};
const agentPanel = (id) => `.agent:has(.dot.${id})`;

log(`open ${base}`);
await page.goto(base, { waitUntil: "networkidle" });
await waitText("#p-locator", /urn:air/);
await sleep(2500);

// Clean slate.
await press("Start over");
await idle();
await waitText("#p-version", /^v1$/);
await sleep(2500);

// Act 1: John's agent shops at Travel26.
await press("1 · Shop at Travel26");
await page.waitForSelector(".turn.assistant", { timeout: 90_000 });
await waitText("#known", /reachable via NANDA/);
await idle();
await sleep(4000);

// Act 2: Travel26 sends. Card v1, so it lands in Muse.
await press("Send promotion");
await waitText("#log", /delivered to\s*muse/);
await waitText(agentPanel("muse"), /Lisbon/, 120_000);
await idle();
await sleep(5000);

// Act 3: John reroutes travel to Wajo. Travel26 is not told.
await press("3 · Route travel via Wajo");
await waitText("#p-target", /Wajo/);
await idle();
await sleep(4000);

// Act 2 again: same locator, new card, lands in Wajo. Muse unchanged.
await press("Send another (Kyoto)");
await waitText("#log", /delivered to\s*wajo/);
await waitText(agentPanel("wajo"), /Kyoto/, 120_000);
await idle();
await sleep(7000);

const video = page.video();
await context.close();
await browser.close();
const src = await video.path();
const dest = join(outDir, "reach-john-demo.webm");
renameSync(src, dest);
const bytes = statSync(dest).size;
log(`saved ${dest} (${(bytes / 1e6).toFixed(1)} MB)`);
for (const f of readdirSync(outDir)) if (f !== "reach-john-demo.webm" && f.endsWith(".webm")) { try { /* leftover raw files */ } catch {} }
