// Records the corroboration demo: both attacks, both refusals, both recoveries, side by side.
//   node scripts/record-corroboration.mjs https://mymuse-production.up.railway.app https://travel26-production.up.railway.app recordings
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
await page.evaluate(([l, r]) => window.stage.load(l, r), [`${john}/corroboration.html`, merchant]);
const L = page.frameLocator("#lf");
const R = page.frameLocator("#rf");
const caption = (step, text, sub, side) => page.evaluate((a) => window.stage.caption(...a), [step, text, sub, side]);
const press = async (frame, label) => { const b = frame.getByRole("button", { name: label, exact: false }).first(); await b.waitFor({ state: "visible", timeout: 60_000 }); await b.hover(); await sleep(500); await b.click(); log(`pressed: ${label}`); };
const waitBadge = (re) => L.locator("#badge").filter({ hasText: re }).waitFor({ timeout: 90_000 });
const waitLog = (re) => L.locator("#log").filter({ hasText: re }).waitFor({ timeout: 90_000 });
const idle = () => L.locator("button:enabled").first().waitFor({ timeout: 60_000 });

await caption("Setup", "Travel26 holds John's locator. Before every send it asks five sources about it.", "Its own Poppy session record, the NANDA Index, the card, the Poppy identity's keys, and InkBox's card for the target mailbox.", "merchant");
await waitBadge(/AGREE|DIVERGENT|INSUFFICIENT/);
await sleep(3000);

await caption("Baseline", "All five agree. Travel26 sends.", "The card is signed by the same key John's agent used in the Poppy session, so the Index entry, the card and the identity line up.", "merchant");
await press(L, "Travel26: send promotion");
await waitLog(/delivered/);
await idle();
await sleep(4000);

await caption("Attack 1", "The card host is compromised: it swaps John's inbox for an attacker's.", "The signature was made over the original card, so it no longer matches.", "john");
await press(L, "Tamper");
await waitBadge(/DIVERGENT/);
await sleep(2500);
await caption("Attack 1", "Travel26 refuses to send.", "Finding: key. The card's signature does not verify against the identity Travel26 met.", "merchant");
await press(L, "Travel26: send promotion");
await waitLog(/held/);
await idle();
await sleep(4000);
await caption("Recover", "The host is fixed. Agreement returns, and so does delivery.", "", "john");
await press(L, "Restore");
await waitBadge(/AGREE/);
await press(L, "Travel26: send promotion");
await waitLog(/delivered/);
await idle();
await sleep(3500);

await caption("Attack 2", "John's entry in the NANDA Index is hijacked to point at an attacker's card.", "The attacker's card claims John's locator and client id, names the attacker's inbox, and is signed with the attacker's key.", "john");
await press(L, "Hijack");
await waitBadge(/DIVERGENT/);
await sleep(2500);
await caption("Attack 2", "Travel26 refuses again.", "Findings: key, the signer is not the identity it met; omission, InkBox has no card for the attacker's mailbox.", "merchant");
await press(L, "Travel26: send promotion");
await waitLog(/held/);
await idle();
await sleep(4000);
await caption("Recover", "The Index entry is restored. Agreement returns, delivery resumes.", "", "john");
await L.getByRole("button", { name: "Restore", exact: false }).nth(1).click();
log("pressed: Restore (index)");
await waitBadge(/AGREE/);
await press(L, "Travel26: send promotion");
await waitLog(/delivered/);
await idle();
await sleep(2500);
await caption("Done", "A merchant that pushes to a pointer corroborates the pointer.", "Poppy has no push channel; a NANDA locator gives one. Corroboration keeps it safe to use.", "merchant");
await sleep(6000);

const video = page.video();
await context.close();
await browser.close();
const dest = join(outDir, "reach-john-corroboration.webm");
renameSync(await video.path(), dest);
log(`saved ${dest} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
