import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createFileExclusive } from "./secureFile.js";

// Crockford base32 (no I, L, O, U): easy to read from a log and type into a form.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 16 symbols (80 bits), shown as XXXX-XXXX-XXXX-XXXX. */
export function generateSetupCode(): string {
  const bytes = randomBytes(16);
  let s = "";
  for (const b of bytes) s += ALPHABET[b & 31];
  return s.match(/.{4}/g)!.join("-");
}

/** Accept lower case, spaces and missing/extra dashes; map the look-alikes Crockford allows. */
export function normalizeSetupCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/**
 * The one-time setup code in `<dataDir>/setup-code` (0600). It exists only
 * while there is no admin account: the server creates it at start (and logs
 * it), `cli.js admin setup-code` prints it, the setup form must present it, and
 * it is deleted as soon as an admin exists. It lives in a file so the server
 * and the CLI always agree on the current code.
 */
export class SetupCode {
  constructor(private readonly file: string) {}

  read(): string | null {
    try {
      const v = readFileSync(this.file, "utf8").trim();
      return v || null;
    } catch {
      return null;
    }
  }

  /** The current code, creating one when there is none. */
  ensure(): string {
    const existing = this.read();
    if (existing) return existing;
    const code = generateSetupCode();
    if (createFileExclusive(this.file, `${code}\n`)) return code;
    return this.read() ?? code; // another process created it first
  }

  matches(candidate: string): boolean {
    const current = this.read();
    if (!current) return false;
    const a = createHash("sha256").update(normalizeSetupCode(candidate)).digest();
    const b = createHash("sha256").update(normalizeSetupCode(current)).digest();
    return timingSafeEqual(a, b);
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}
