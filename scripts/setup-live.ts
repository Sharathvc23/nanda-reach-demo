/**
 * One-time setup for the live demo: three InkBox mailboxes (John on Muse, John on Wajo,
 * Travel26) and John's entry in the NANDA Index pointing at the card this service hosts.
 *
 * Every step is its own command and the script keeps its progress in data/live-setup.json, so a
 * step can be repeated safely. Secrets are written to that file and to .env.live only; the
 * script never prints an API key, password or token.
 *
 *   tsx scripts/setup-live.ts signup muse --human-email you@example.com
 *   tsx scripts/setup-live.ts verify muse --code 123456
 *   tsx scripts/setup-live.ts signup wajo --human-email you@example.com --handle johnwajo
 *   ...
 *   tsx scripts/setup-live.ts index-register --card-url https://<railway host>/cards/john
 *   tsx scripts/setup-live.ts status
 *   tsx scripts/setup-live.ts env --public-base-url https://<railway host>
 *
 * The flow follows https://my.nandaindex.org/inkbox/SKILL.md: InkBox signup and a six-digit code
 * to the human; the NANDA account and registration are both verified through emails that land in
 * the agent's own InkBox mailbox, which this script reads.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const INK = process.env.INKBOX_BASE_URL?.replace(/\/+$/, "") ?? "https://inkbox.ai/api/v1";
const NANDA = process.env.INDEX_BASE_URL?.replace(/\/+$/, "") ?? "https://api.nandaindex.org";
const STATE_FILE = "data/live-setup.json";

type BoxName = "muse" | "wajo" | "travel26";
interface Box {
  human_email: string;
  agent_handle: string;
  email_address: string;
  api_key: string;
  claim_status: string;
}
interface SetupState {
  boxes: Partial<Record<BoxName, Box>>;
  index?: {
    account_email: string;
    password: string;
    token?: string;
    account_verified?: boolean;
    org_id?: string;
    identifier?: string;
    card_url?: string;
    registered?: boolean;
    entry_verified?: boolean;
    active?: boolean;
  };
}

function loadState(): SetupState {
  if (!existsSync(STATE_FILE)) return { boxes: {} };
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SetupState;
}
function saveState(s: SetupState): void {
  mkdirSync("data", { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}
function boxName(): BoxName {
  const b = process.argv[3] as BoxName;
  if (!["muse", "wajo", "travel26"].includes(b)) throw new Error("box must be muse, wajo or travel26");
  return b;
}

async function http(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body: parsed };
}

const redact = (b: any): any => {
  if (!b || typeof b !== "object") return b;
  const out: any = Array.isArray(b) ? [] : {};
  for (const [k, v] of Object.entries(b)) out[k] = /key|token|password|secret/i.test(k) ? "[redacted]" : redact(v);
  return out;
};
const show = (label: string, r: { status: number; body: any }) => console.log(label, r.status, JSON.stringify(redact(r.body)).slice(0, 600));

const DISPLAY: Record<BoxName, { display_name: string; harness: string }> = {
  muse: { display_name: "John (Muse)", harness: "Muse" },
  wajo: { display_name: "John (Wajo)", harness: "Wajo" },
  travel26: { display_name: "Travel26", harness: "Travel26 poppy" },
};

async function signup(): Promise<void> {
  const s = loadState();
  const name = boxName();
  const human = need("human-email");
  const handle = arg("handle") ?? human.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const r = await http("POST", `${INK}/agent-signup/`, {
    human_email: human,
    agent_handle: handle,
    display_name: arg("display-name") ?? DISPLAY[name].display_name,
    harness: DISPLAY[name].harness,
    note_to_human: "This mailbox is for the NANDA reach demo. Please pass the six-digit code to the operator.",
  });
  show(`signup ${name}:`, r);
  if (r.status !== 201 && r.status !== 200) throw new Error(`signup failed with ${r.status}`);
  s.boxes[name] = {
    human_email: human,
    agent_handle: r.body.agent_handle ?? handle,
    email_address: r.body.email_address,
    api_key: r.body.api_key,
    claim_status: r.body.claim_status ?? "agent_unclaimed",
  };
  saveState(s);
  console.log(`\n${name}: mailbox ${r.body.email_address}. A six-digit code was sent to ${human}.`);
}

async function verify(): Promise<void> {
  const s = loadState();
  const name = boxName();
  const box = s.boxes[name];
  if (!box) throw new Error(`no signup recorded for ${name}`);
  const r = await http("POST", `${INK}/agent-signup/verify`, { verification_code: need("code") }, { "x-api-key": box.api_key });
  show(`verify ${name}:`, r);
  if (r.status === 200) {
    box.claim_status = r.body.claim_status ?? "agent_claimed";
    saveState(s);
    console.log(`\n${name}: claimed. Address ${box.email_address}`);
  } else if (r.status === 410) {
    console.log("Code expired. Run: resend", name);
  } else throw new Error(`verify failed with ${r.status}`);
}

async function resend(): Promise<void> {
  const s = loadState();
  const name = boxName();
  const box = s.boxes[name];
  if (!box) throw new Error(`no signup recorded for ${name}`);
  show(`resend ${name}:`, await http("POST", `${INK}/agent-signup/resend-verification`, {}, { "x-api-key": box.api_key }));
}

interface Msg {
  id: string;
  subject?: string;
  from_address?: string;
  body_text?: string;
  snippet?: string;
  created_at?: string;
}
async function inbox(box: Box, limit = 50): Promise<Msg[]> {
  const r = await http("GET", `${INK}/mail/mailboxes/${encodeURIComponent(box.email_address)}/messages?direction=inbound&limit=${limit}`, undefined, { "x-api-key": box.api_key });
  if (r.status !== 200) throw new Error(`inbox read failed ${r.status}`);
  const items = Array.isArray(r.body) ? r.body : r.body.items ?? r.body.messages ?? r.body.data ?? [];
  return items as Msg[];
}
async function readFull(box: Box, id: string): Promise<Msg> {
  const r = await http("GET", `${INK}/mail/mailboxes/${encodeURIComponent(box.email_address)}/messages/${encodeURIComponent(id)}`, undefined, { "x-api-key": box.api_key });
  return (r.body ?? {}) as Msg;
}

/** Wait for a NANDA email whose subject matches, and pull the hex token out of it. */
async function waitForToken(box: Box, subjectRe: RegExp, after: number): Promise<string> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const items = await inbox(box);
    for (const m of items) {
      if (!subjectRe.test(m.subject ?? "")) continue;
      if (m.created_at && Date.parse(m.created_at) < after - 60_000) continue;
      const full = m.body_text ? m : await readFull(box, m.id);
      const text = `${full.body_text ?? ""} ${full.snippet ?? ""}`;
      const match = text.match(/token=([0-9a-fA-F]{16,})/) ?? text.match(/\b([0-9a-fA-F]{32,})\b/);
      if (match) return match[1];
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`no email matching ${subjectRe} arrived within 5 minutes`);
}

async function indexRegister(): Promise<void> {
  const s = loadState();
  const muse = s.boxes.muse;
  if (!muse) throw new Error("sign up and verify the muse mailbox first");
  if (muse.claim_status !== "agent_claimed") console.warn("warning: muse mailbox is not claimed yet; NANDA mail may not be delivered");
  const cardUrl = arg("card-url") ?? s.index?.card_url;
  if (!cardUrl) throw new Error("--card-url is required the first time");
  s.index ??= { account_email: muse.email_address, password: randomBytes(18).toString("base64url") };
  s.index.card_url = cardUrl;
  saveState(s);

  // 1. Account.
  const started = Date.now();
  let token = s.index.token;
  if (!token) {
    const reg = await http("POST", `${NANDA}/auth/register`, { email: s.index.account_email, password: s.index.password, display_name: "John" });
    show("auth/register:", reg);
    if (reg.status === 201 || reg.status === 200) token = reg.body.token;
    else {
      const login = await http("POST", `${NANDA}/auth/login`, { email: s.index.account_email, password: s.index.password });
      show("auth/login:", login);
      if (login.status !== 200) throw new Error("could not register or log in to the NANDA Index");
      token = login.body.token;
    }
    s.index.token = token;
    saveState(s);
  }
  const auth = { authorization: `Bearer ${token}` };

  // 2. Account verification, through the agent's own mailbox.
  let me = await http("GET", `${NANDA}/api/v1/me`, undefined, auth);
  show("me:", me);
  if (me.status === 401) {
    const login = await http("POST", `${NANDA}/auth/login`, { email: s.index.account_email, password: s.index.password });
    if (login.status !== 200) throw new Error("token expired and login failed");
    token = login.body.token;
    s.index.token = token;
    saveState(s);
    auth.authorization = `Bearer ${token}`;
    me = await http("GET", `${NANDA}/api/v1/me`, undefined, auth);
  }
  if (!me.body?.email_verified) {
    console.log("waiting for the account verification email in", muse.email_address);
    const t = await waitForToken(muse, /verify your nanda index account/i, started);
    show("\nauth/verify-account:", await http("POST", `${NANDA}/auth/verify-account`, { token: t }));
  }
  s.index.account_verified = true;
  saveState(s);

  // 3. The entry, pointing at the card this service hosts.
  const identifier = `urn:air:host39.org:personal:${muse.email_address}`;
  const orgId = `inkbox-${muse.agent_handle}`;
  s.index.identifier = identifier;
  s.index.org_id = orgId;
  if (!s.index.registered) {
    const body = {
      org_id: orgId,
      display_name: "John",
      hosting_path: "personal",
      contact_email: muse.email_address,
      registry_url: cardUrl,
      identifier,
      media_type: "application/a2a-agent-card+json",
      description: "John's personal agents (NANDA reach demo). The card lists his inboxes and routing rules.",
    };
    const reg = await http("POST", `${NANDA}/api/v1/orgs`, body, auth);
    show("orgs:", reg);
    if (reg.status === 409) {
      console.log("entry exists; updating registry_url");
      show("orgs PUT:", await http("PUT", `${NANDA}/api/v1/orgs/${encodeURIComponent(orgId)}`, { registry_url: cardUrl }, auth));
    } else if (reg.status !== 201 && reg.status !== 200) throw new Error(`registration failed with ${reg.status}`);
    s.index.registered = true;
    saveState(s);
  } else if (arg("card-url")) {
    show("orgs PUT:", await http("PUT", `${NANDA}/api/v1/orgs/${encodeURIComponent(orgId)}`, { registry_url: cardUrl }, auth));
  }

  // 4. Entry verification, again through the mailbox, then wait for active.
  const resolve = async () => http("GET", `${NANDA}/api/v1/resolve?locator=${encodeURIComponent(identifier)}`);
  let r = await resolve();
  const status = () => r.body?.entry?.extensions?.["org.projectnanda"]?.status;
  if (r.status !== 200 || status() !== "active") {
    if (!s.index.entry_verified) {
      console.log("waiting for the registration verification email in", muse.email_address);
      const t = await waitForToken(muse, /verify your nanda index registration/i, started);
      show("\nverify-email:", await http("POST", `${NANDA}/api/v1/verify-email`, { token: t }));
      s.index.entry_verified = true;
      saveState(s);
    }
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      r = await resolve();
      if (r.status === 200 && status() === "active") break;
      process.stdout.write(".");
      await new Promise((res) => setTimeout(res, 30_000));
    }
  }
  show("\nresolve:", r);
  s.index.active = r.status === 200 && status() === "active";
  saveState(s);
  console.log(s.index.active ? `\nJohn is live in the NANDA Index as ${identifier}, card ${cardUrl}` : "\nEntry is not active yet; run index-register again later.");
}

async function status(): Promise<void> {
  const s = loadState();
  for (const name of ["muse", "wajo", "travel26"] as BoxName[]) {
    const b = s.boxes[name];
    console.log(name.padEnd(9), b ? `${b.email_address}  ${b.claim_status}` : "(not signed up)");
  }
  if (s.index?.identifier) {
    const r = await http("GET", `${NANDA}/api/v1/resolve?locator=${encodeURIComponent(s.index.identifier)}`);
    console.log("index    ", s.index.identifier, "->", r.status, r.body?.entry?.extensions?.["org.projectnanda"]?.status ?? "?", r.body?.entry?.registry_url ?? "");
  } else console.log("index     (not registered)");
}

/** Write .env.live for the service: addresses, keys and John's locator. Never printed. */
function env(): void {
  const s = loadState();
  const { muse, wajo, travel26 } = s.boxes;
  if (!muse || !wajo || !travel26) throw new Error("all three mailboxes must be signed up first");
  const lines = [
    "MODE=live",
    `PUBLIC_BASE_URL=${need("public-base-url")}`,
    `JOHN_LOCATOR=${s.index?.identifier ?? `urn:air:host39.org:personal:${muse.email_address}`}`,
    `JOHN_MUSE_ADDRESS=${muse.email_address}`,
    `JOHN_MUSE_API_KEY=${muse.api_key}`,
    `JOHN_WAJO_ADDRESS=${wajo.email_address}`,
    `JOHN_WAJO_API_KEY=${wajo.api_key}`,
    `TRAVEL26_ADDRESS=${travel26.email_address}`,
    `TRAVEL26_API_KEY=${travel26.api_key}`,
    `ADMIN_TOKEN=${arg("admin-token") ?? randomBytes(12).toString("base64url")}`,
  ];
  writeFileSync(".env.live", lines.join("\n") + "\n");
  console.log(".env.live written (10 variables). Addresses:", muse.email_address, wajo.email_address, travel26.email_address);
}

const commands: Record<string, () => Promise<void> | void> = { signup, verify, resend, "index-register": indexRegister, status, env };
const cmd = process.argv[2];
if (!cmd || !commands[cmd]) {
  console.log("commands: signup <box> --human-email <e> [--handle <h>] | verify <box> --code <6 digits> | resend <box> | index-register --card-url <url> | status | env --public-base-url <url>");
  process.exit(1);
}
Promise.resolve(commands[cmd]()).catch((e) => {
  console.error(String((e as Error).message ?? e));
  process.exit(1);
});
