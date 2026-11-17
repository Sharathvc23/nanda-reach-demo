/**
 * A small RFC 9651 (Structured Field Values) parser for the two Poppy headers this demo reads:
 * `Poppy-Extensions` (a List of Strings with a `v` parameter, spec 3.4) and `Poppy-Approval` (a
 * Dictionary of Strings and an Integer, Operations §6). It follows the parsing algorithms of
 * RFC 9651 §4.2 for the item types it supports (String, Integer, Token, Boolean) and fails the
 * whole field on anything else, as §4.2 requires. Inner lists, decimals, byte sequences, dates
 * and display strings are not supported and fail parsing.
 */
export type BareItem = string | number | boolean | { token: string };
export interface Item {
  value: BareItem;
  params: Map<string, BareItem>;
}

export class SfParseError extends Error {}

class Parser {
  i = 0;
  constructor(readonly s: string) {}
  peek(): string {
    return this.s[this.i] ?? "";
  }
  eof(): boolean {
    return this.i >= this.s.length;
  }
  skipSp(): void {
    while (this.peek() === " ") this.i++;
  }
  skipOws(): void {
    while (this.peek() === " " || this.peek() === "\t") this.i++;
  }
  fail(msg: string): never {
    throw new SfParseError(`${msg} at ${this.i}`);
  }

  key(): string {
    const c = this.peek();
    if (!/[a-z*]/.test(c)) this.fail("key must start with lcalpha or *");
    let out = "";
    while (/[a-z0-9_\-.*]/.test(this.peek()) && !this.eof()) out += this.s[this.i++];
    return out;
  }

  bareItem(): BareItem {
    const c = this.peek();
    if (c === '"') return this.string();
    if (c === "-" || /[0-9]/.test(c)) return this.integer();
    if (c === "?") return this.boolean();
    if (/[A-Za-z*]/.test(c)) return { token: this.token() };
    return this.fail("unsupported bare item");
  }

  string(): string {
    this.i++; // opening quote
    let out = "";
    for (;;) {
      if (this.eof()) this.fail("unterminated string");
      const c = this.s[this.i++];
      if (c === "\\") {
        const n = this.s[this.i++];
        if (n !== '"' && n !== "\\") this.fail("bad escape");
        out += n;
      } else if (c === '"') return out;
      else {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) this.fail("string has a non-printable character");
        out += c;
      }
    }
  }

  integer(): number {
    let sign = 1;
    if (this.peek() === "-") {
      sign = -1;
      this.i++;
    }
    let digits = "";
    while (/[0-9]/.test(this.peek()) && !this.eof()) digits += this.s[this.i++];
    if (!digits) this.fail("integer has no digits");
    if (this.peek() === ".") this.fail("decimals are not supported");
    if (digits.length > 15) this.fail("integer too long");
    return sign * Number(digits);
  }

  boolean(): boolean {
    this.i++;
    const c = this.s[this.i++];
    if (c === "1") return true;
    if (c === "0") return false;
    return this.fail("bad boolean");
  }

  token(): string {
    let out = "";
    while (/[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/.test(this.peek()) && !this.eof()) out += this.s[this.i++];
    return out;
  }

  params(): Map<string, BareItem> {
    const out = new Map<string, BareItem>();
    while (this.peek() === ";") {
      this.i++;
      this.skipSp();
      const k = this.key();
      let v: BareItem = true;
      if (this.peek() === "=") {
        this.i++;
        v = this.bareItem();
      }
      out.set(k, v);
    }
    return out;
  }

  item(): Item {
    const value = this.bareItem();
    return { value, params: this.params() };
  }
}

/** RFC 9651 §4.2.1: parse a List of Items. */
export function parseList(input: string): Item[] {
  const p = new Parser(input.trim());
  const out: Item[] = [];
  while (!p.eof()) {
    if (p.peek() === "(") p.fail("inner lists are not supported");
    out.push(p.item());
    p.skipOws();
    if (p.eof()) return out;
    if (p.peek() !== ",") p.fail("expected ,");
    p.i++;
    p.skipOws();
    if (p.eof()) p.fail("trailing comma");
  }
  return out;
}

/** RFC 9651 §4.2.2: parse a Dictionary. Later duplicates overwrite earlier ones. */
export function parseDictionary(input: string): Map<string, Item> {
  const p = new Parser(input.trim());
  const out = new Map<string, Item>();
  while (!p.eof()) {
    const k = p.key();
    let item: Item;
    if (p.peek() === "=") {
      p.i++;
      if (p.peek() === "(") p.fail("inner lists are not supported");
      item = p.item();
    } else item = { value: true, params: p.params() };
    out.set(k, item);
    p.skipOws();
    if (p.eof()) return out;
    if (p.peek() !== ",") p.fail("expected ,");
    p.i++;
    p.skipOws();
    if (p.eof()) p.fail("trailing comma");
  }
  return out;
}

/** Serialize a String as RFC 9651 §4.1.6 does. */
export function sfString(s: string): string {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new SfParseError("strings must be printable ASCII");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * `Poppy-Extensions` (spec 3.4): each member a String naming the extension, with the version as a
 * String in `v`. A field that fails to parse declares no extensions.
 */
export function parseExtensions(value: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!value) return out;
  try {
    for (const item of parseList(value)) {
      const v = item.params.get("v");
      if (typeof item.value === "string" && typeof v === "string") out.set(item.value, v);
    }
  } catch {
    return new Map();
  }
  return out;
}

export function serializeExtensions(exts: Record<string, string>): string {
  return Object.entries(exts)
    .map(([name, v]) => `${sfString(name)};v=${sfString(v)}`)
    .join(", ");
}
