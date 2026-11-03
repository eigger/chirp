import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Persisted UUIDv4 (source of Home Assistant unique IDs). */
export function loadInstanceId(dataDir: string, warn: (msg: string) => void = () => {}): string {
  const file = join(dataDir, "instance-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (UUID_RE.test(existing)) return existing;
  } catch {
    /* create below */
  }
  const id = randomUUID();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, `${id}\n`, { mode: 0o644 });
  } catch (err) {
    warn(`could not persist instance id to ${file}: ${(err as Error).message}`);
  }
  return id;
}
