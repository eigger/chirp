import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function writeTemp(file: string, content: string): string {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600); // the umask may have narrowed or (with flag wx) not applied the mode
  return tmp;
}

/**
 * Replace `file` atomically (temp file + rename, mode 0600), so a reader in
 * another process (server vs. CLI) never sees a truncated file.
 */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = writeTemp(file, content);
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Create `file` (mode 0600) only if it does not exist yet, atomically across
 * processes: the content is written to a temp file and hard-linked into place,
 * and link(2) fails with EEXIST when someone else won the race. Returns false
 * when the file already existed.
 */
export function createFileExclusive(file: string, content: string): boolean {
  const tmp = writeTemp(file, content);
  try {
    linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}
