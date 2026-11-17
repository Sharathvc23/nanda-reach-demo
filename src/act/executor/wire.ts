/**
 * The executor control channel's wire format: JSON, with the one non-JSON value the agent API
 * returns (a `Headers` object inside a `Response`) carried as its entries.
 */
export function toWire(value: unknown): unknown {
  if (value instanceof Headers) return { __headers: [...value.entries()] };
  if (Array.isArray(value)) return value.map(toWire);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toWire(v)]));
  return value;
}

export function fromWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromWire);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.__headers) && Object.keys(o).length === 1) return new Headers(o.__headers as [string, string][]);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fromWire(v)]));
  }
  return value;
}

/** The agent methods the control channel exposes: exactly `AgentHandle`'s. */
export const CONTROL_METHODS = [
  "setGrant",
  "hasAccessToken",
  "pairwiseUserId",
  "discover",
  "beginSignIn",
  "request",
  "grantView",
  "carryFence",
  "occurrenceStatus",
  "readReceipt",
  "startBooking",
  "sendApproved",
  "report",
  "readBooking",
  "kill",
] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

export interface ControlRequest {
  /** The run this call belongs to; each run has its own instance of the agent. */
  run: string;
  /** The owner (continuity service) base URL this run's instance talks to. */
  owner: string;
  args: unknown[];
}

export interface ControlLogEntry {
  at: string;
  actor: string;
  text: string;
  data?: Record<string, unknown>;
}

export type ControlResponse =
  | { ok: true; result: unknown; log: ControlLogEntry[] }
  | { ok: false; error: { name: string; message: string; status?: number; code?: string }; log: ControlLogEntry[] };
