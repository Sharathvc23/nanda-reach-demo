import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A tiny JSON-file store. Each service keeps a handful of rows; a database would be ceremony.
 * Point DATA_DIR at a Railway volume to keep state across deploys, or leave it ephemeral.
 */
export class JsonStore<T extends object> {
  state: T;
  private readonly file: string;

  constructor(dataDir: string, fileName: string, private readonly fresh: () => T) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, fileName);
    this.state = existsSync(this.file)
      ? { ...fresh(), ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<T>) }
      : fresh();
  }

  save(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  reset(): void {
    this.state = this.fresh();
    this.save();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
