// Records the full run with both sites side by side and a caption for each step, with holds at every delivery.
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

const HOLD = 6500; // after every delivery, long enough to read the inbox
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
const press = async (frame, label, nth = 0) => { const b = frame.getByRole("button", { name: label, exact: false }).nth(nth); await b.waitFor({ state: "visible", timeout: 60_000 }); await b.scrollIntoViewIfNeeded(); await b.hover(); await sleep(700); await b.click(); log(`pressed: ${label}`); };
const waitText = (frame, selector, re, timeout = 120_000) => frame.locator(selector).filter({ hasText: re }).first().waitFor({ state: "visible", timeout });
const idle = (frame) => frame.locator("button:enabled").first().waitFor({ timeout: 60_000 });
const openDemoControls = async () => { const d = L.locator("details.demo"); if (!(await d.evaluate((el) => el.open))) await d.locator("summary").click(); };

await waitText(L, "#p-locator", /urn:air/);
await waitText(R, "#known", /.+/);
await sleep(2000);

// Clean slate, quietly.
await openDemoControls();
await press(L, "Start over");
await waitText(L, "#p-version", /^v1$/);
await idle(L);
await L.locator("details.demo summary").click();
await sleep(1500);

await caption("Act 1", "John asks his agent for flights.", "The agent reads Travel26's poppy.json, opens a Poppy session, searches the MCP API, and identifies John by his NANDA locator only.", "john");
await press(L, "1 · Shop at Travel26");
await L.locator(".turn.assistant").first().waitFor({ timeout: 90_000 });
await waitText(R, "#known", /locator held/);
await sleep(2500);
await caption("Act 1", "Travel26 now holds one thing about John: his locator.", "No card, no inbox address, no endpoint. It is the pointer it can resolve later.", "merchant");
await sleep(5000);

await caption("Act 2", "Later, Travel26 sends a promotion.", "It resolves the locator in the NANDA Index, reads John's card, version 1, and follows the rule: everything to Muse.", "merchant");
await press(R, "Send promotion");
await waitText(R, "#log", /delivered/);
await waitText(L, ".agent:has(.dot.muse)", /Lisbon/);
await sleep(1500);
await caption("Act 2", "Delivered to John's Muse inbox.", "The highlighted inbox on the left just received it. The trace on the right lists every hop: Index, card, rule, InkBox.", "john");
await sleep(HOLD);

await caption("Act 3", "John changes his mind: travel should go to his Wajo agent.", "He tells his agent. The agent edits its own card: adds Wajo, adds the rule. One request, one new card version. Nobody tells Travel26.", "john");
await press(L, "3 · Route travel via Wajo");
await waitText(L, "#p-target", /Wajo/);
await idle(L);
await sleep(2000);
await caption("Act 3", "Card v2. Travel26 still holds the same locator, and its view already shows the change.", "Its row now reads: travel reaches John on Wajo.", "merchant");
await waitText(R, "#known", /Wajo/);
await sleep(5000);

await caption("Act 2 again", "Travel26 sends again, to the same locator.", "Fresh Index lookup, fresh read of the card, now version 2. The travel rule points at Wajo.", "merchant");
await press(R, "Send another (Kyoto)");
await waitText(R, "#log", /delivered\s*wajo/i);
await sleep(1500);
await caption("Act 2 again", "Delivered to Wajo. Muse got nothing.", "On the right, previous and latest send side by side; the lines that changed are highlighted: card version, rule, inbox.", "merchant");
await sleep(HOLD);

await caption("Act 4", "John says no to promotions.", "A rule on his card: promotion goes nowhere. Travel26 reads it before sending and holds.", "john");
await press(L, "No promotions");
await waitText(L, "#p-target", /declined/);
await idle(L);
await sleep(1500);
await press(R, "Send promotion");
await waitText(R, "#log", /declined by card/);
await sleep(1500);
await caption("Act 4", "Held. Not an error: the person's choice, read from the card.", "The merchant's row says: travel reaches nobody, the card declines promotion.", "merchant");
await sleep(HOLD);
await press(L, "Allow promotions");
await idle(L);

await caption("Act 5", "John moves his card to a new URL and updates his Index entry.", "A merchant that saved the card URL at first contact is about to find out what that costs.", "john");
await openDemoControls();
await press(L, "Move card to a new URL");
await waitText(L, "#p-index", /card moved/);
await idle(L);
await sleep(1500);
await press(R, "Send promotion");
await waitText(R, "#log", /Saved-URL merchant: .*410/);
await waitText(R, "#log", /delivered\s*wajo/i);
await sleep(1500);
await caption("Act 5", "The saved URL answers 410 Gone. The locator still delivers.", "Same send: the saved-URL merchant lost John; Travel26 followed the Index to the new card and reached Wajo.", "merchant");
await sleep(HOLD);
await press(L, "Move card back");
await idle(L);
await L.locator("details.demo summary").click();

await caption("Done", "One locator, held by the merchant. John's card decided everything else.", "Where each message landed, whether it was sent at all, and where the card lives.", "john");
await sleep(6000);

const video = page.video();
await context.close();
await browser.close();
const dest = join(outDir, "reach-john-demo-stage.webm");
renameSync(await video.path(), dest);
log(`saved ${dest} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
