import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** One merchant-side record: everything Travel26 keeps about an agent that contacted it. */
export interface KnownAgent {
  locator: string;
  first_seen: string;
  last_seen: string;
  context: string;
  contacts: number;
}

export interface PromoDelivery {
  id: string;
  at: string;
  locator: string;
  subject: string;
  card_version: string | null;
  delivered_to: { agent: string; address: string } | null;
  error: string | null;
  trace: string[];
}

export interface MockMessage {
  id: string;
  thread_id: string;
  from_address: string;
  to: string[];
  subject: string;
  body_text: string;
  snippet: string;
  created_at: string;
  is_read: boolean;
  direction: "inbound" | "outbound";
}

export interface MockIndexEntry {
  identifier: string;
  displayName: string;
  registry_url: string;
  status: "active" | "pending";
}

export interface State {
  card_version: 1 | 2;
  card_updated_at: string;
  known_agents: KnownAgent[];
  promo_log: PromoDelivery[];
  mock_messages: Record<string, MockMessage[]>;
  mock_index: Record<string, MockIndexEntry>;
}

function fresh(): State {
  return {
    card_version: 1,
    card_updated_at: new Date().toISOString(),
    known_agents: [],
    promo_log: [],
    mock_messages: {},
    mock_index: {},
  };
}

/**
 * A tiny JSON-file store. The demo has a handful of rows; a database would be ceremony.
 * Set DATA_DIR to a Railway volume to keep state across deploys, or leave it ephemeral.
 */
export class Store {
  readonly state: State;
  private readonly file: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "state.json");
    this.state = existsSync(this.file)
      ? { ...fresh(), ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<State>) }
      : fresh();
  }

  save(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  reset(keepIndex = true): void {
    const index = this.state.mock_index;
    Object.assign(this.state, fresh());
    if (keepIndex) this.state.mock_index = index;
    this.save();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
