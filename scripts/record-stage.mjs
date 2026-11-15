// Records the full run with both sites side by side and a caption for each step.
//   node scripts/record-stage.mjs https://mymuse-production.up.railway.app https://travel26-production.up.railway.app recordings
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const john = (process.argv[2] ?? "https://mymuse-production.up.railway.app").replace(/\/+$/, "");
const merchant = (process.argv[3] ?? "https://travel26-production.up.railway.app").replace(/\/+$/, "");
const outDir = process.argv[4] ?? "recordings";
const envFile = existsSync(".env.live") ? Object.fromEntries(readFileSync(".env.live", "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; })) : {};
const token = process.env.ADMIN_TOKEN || envFile.ADMIN_TOKEN || "";
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1600, H = 900;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: outDir, size: { width: W, height: H } } });
await context.addInitScript((t) => { try { localStorage.setItem("adminToken", t); } catch {} }, token);
const page = await context.newPage();
const log = (m) => console.log(new Date().toISOString().slice(11, 19), m);

await page.goto(pathToFileURL(resolve("scripts/stage.html")).href);
await page.evaluate(([l, r]) => window.stage.load(l, r), [john, merchant]);
const L = page.frameLocator("#lf");
const R = page.frameLocator("#rf");
const caption = (step, text, sub, side) => page.evaluate((a) => window.stage.caption(...a), [step, text, sub, side]);

const press = async (frame, label) => {
  const btn = frame.getByRole("button", { name: label, exact: false }).first();
  await btn.waitFor({ state: "visible", timeout: 60_000 });
  await btn.scrollIntoViewIfNeeded();
  await btn.hover();
  await sleep(600);
  await btn.click();
  log(`pressed: ${label}`);
};
const waitText = (frame, selector, re, timeout = 90_000) => frame.locator(selector).filter({ hasText: re }).first().waitFor({ state: "visible", timeout });
const idle = (frame) => frame.locator("button:enabled").first().waitFor({ timeout: 60_000 });

await waitText(L, "#p-locator", /urn:air/);
await waitText(R, "#known", /.+/);
await sleep(2500);

// Reset quietly.
await press(L, "Start over");
await waitText(L, "#p-version", /^v1$/);
await idle(L);
await sleep(1500);

await caption("Act 1", "John asks his agent for flights.", "The agent reads Travel26's poppy.json, opens a Poppy session, and searches the MCP API. It identifies John by his NANDA locator only.", "john");
await press(L, "1 · Shop at Travel26");
await L.locator(".turn.assistant").first().waitFor({ timeout: 90_000 });
await waitText(R, "#known", /reachable via NANDA/);
await sleep(1200);
await caption("Act 1", "Travel26 now holds one thing about John: his locator.", "No card, no inbox address, no endpoint. Just the pointer it can resolve later.", "merchant");
await sleep(3500);

await caption("Act 2", "Later, Travel26 sends a promotion.", "It resolves the locator in the NANDA Index, reads John's card, version 1, and follows the rule: everything to Muse.", "merchant");
await press(R, "Send promotion to everyone");
await waitText(R, "#log", /delivered to\s*muse/);
await waitText(L, ".agent:has(.dot.muse)", /Lisbon/, 120_000);
await sleep(1200);
await caption("Act 2", "Delivered to John's Muse inbox.", "The trace on the right shows every hop: Index, card, rule, InkBox.", "john");
await sleep(4000);

await caption("Act 3", "John changes his mind: travel should go to his Wajo agent.", "He tells his agent. The agent edits its own card: adds Wajo, adds the rule. Nobody tells Travel26.", "john");
await press(L, "3 · Route travel via Wajo");
await waitText(L, "#p-target", /Wajo/);
await idle(L);
await sleep(1000);
await caption("Act 3", "The card is updated. Travel26 still holds the same locator.", "Nothing on the merchant's side changed.", "merchant");
await sleep(3500);

await caption("Act 2 again", "Travel26 sends again, to the same locator.", "Fresh Index lookup, fresh read of the card, now version 3. The travel rule points at Wajo.", "merchant");
await press(R, "Send another (Kyoto)");
await waitText(R, "#log", /delivered to\s*wajo/);
await waitText(L, ".agent:has(.dot.wajo)", /Kyoto/, 120_000);
await sleep(1200);
await caption("Done", "Delivered to Wajo. Muse got nothing.", "One locator, held by the merchant. John's card decided where each message landed.", "john");
await sleep(6000);

const video = page.video();
await context.close();
await browser.close();
const dest = join(outDir, "reach-john-demo-stage.webm");
renameSync(await video.path(), dest);
log(`saved ${dest} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
