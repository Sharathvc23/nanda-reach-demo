/** Minimal InkBox mail client: send from a mailbox, list a mailbox's inbound messages. */
export interface Mailbox {
  address: string;
  apiKey: string;
}

export interface InboundMessage {
  id: string;
  thread_id?: string;
  from_address: string;
  subject: string;
  snippet?: string;
  body_text?: string;
  created_at: string;
  is_read?: boolean;
}

export class InkboxClient {
  constructor(private readonly baseUrl: string, private readonly fetchFn: typeof fetch = fetch) {}

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async send(from: Mailbox, msg: { to: string; subject: string; body_text: string }, idempotencyKey: string): Promise<{ id: string | null; status: number }> {
    const res = await this.fetchFn(this.url(`/mail/mailboxes/${encodeURIComponent(from.address)}/messages`), {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": from.apiKey, "idempotency-key": idempotencyKey },
      body: JSON.stringify({ recipients: { to: [msg.to] }, subject: msg.subject, body_text: msg.body_text }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`InkBox send failed: ${res.status} ${JSON.stringify(body)?.slice(0, 200)}`);
    const id = body && typeof body === "object" && "id" in body ? String((body as { id: unknown }).id) : null;
    return { id, status: res.status };
  }

  async listInbound(box: Mailbox, limit = 20): Promise<InboundMessage[]> {
    const res = await this.fetchFn(this.url(`/mail/mailboxes/${encodeURIComponent(box.address)}/messages?direction=inbound&limit=${limit}`), {
      headers: { accept: "application/json", "x-api-key": box.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`InkBox list failed: ${res.status}`);
    const body = (await res.json()) as unknown;
    if (Array.isArray(body)) return body as InboundMessage[];
    const b = body as { items?: unknown[]; messages?: unknown[]; data?: unknown[] };
    return (b.items ?? b.messages ?? b.data ?? []) as InboundMessage[];
  }
}
