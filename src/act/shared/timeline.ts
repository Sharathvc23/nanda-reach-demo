/** A shared, ordered log of what each party did, for the demo report. */
export interface TimelineEntry {
  seq: number;
  at: string;
  actor: string;
  text: string;
  data?: Record<string, unknown>;
}

export class Timeline {
  readonly entries: TimelineEntry[] = [];
  add(actor: string, text: string, data?: Record<string, unknown>): void {
    this.entries.push({ seq: this.entries.length + 1, at: new Date().toISOString(), actor, text, ...(data ? { data } : {}) });
  }
}
