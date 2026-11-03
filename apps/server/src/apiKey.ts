import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { API_KEY_PREFIX } from "@chirp/shared";
import type { Config } from "./config.js";

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(plaintext: string): Buffer {
  return createHash("sha256").update(plaintext, "utf8").digest();
}

export function isApiKeyPlaintext(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX.length + 16;
}

/**
 * Write atomically (temp file + rename) so a running server never observes a
 * truncated/half-written key file during `key rotate`.
 */
function writeKeyFile(file: string, key: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${key}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readKeyFile(file: string): string | null {
  if (!existsSync(file)) return null;
  const key = readFileSync(file, "utf8").trim();
  return key || null;
}

/** Rotate: write a brand-new key to the key file and return it. */
export function rotateApiKey(config: Pick<Config, "apiKeyFile">): string {
  const key = generateApiKey();
  writeKeyFile(config.apiKeyFile, key);
  return key;
}

/** Read the key (env first, then file). Creates the file when missing. */
export function resolveApiKey(config: Pick<Config, "apiKey" | "apiKeyFile">): {
  key: string;
  created: boolean;
  source: "env" | "file";
} {
  if (config.apiKey) return { key: config.apiKey, created: false, source: "env" };
  const existing = readKeyFile(config.apiKeyFile);
  if (existing) return { key: existing, created: false, source: "file" };
  const key = generateApiKey();
  writeKeyFile(config.apiKeyFile, key);
  return { key, created: true, source: "file" };
}

/**
 * Holds the SHA-256 of the current key. When the key comes from a file it is
 * reloaded whenever the file changes, so `cli.js key rotate` needs no restart.
 */
export class ApiKeyStore {
  private hash: Buffer;
  private stamp = "";

  constructor(
    key: string,
    private readonly file: string | null,
  ) {
    this.hash = hashApiKey(key);
    this.stamp = this.statStamp();
  }

  static fromConfig(config: Pick<Config, "apiKey" | "apiKeyFile">): {
    store: ApiKeyStore;
    created: boolean;
    key: string;
  } {
    const resolved = resolveApiKey(config);
    return {
      store: new ApiKeyStore(resolved.key, resolved.source === "file" ? config.apiKeyFile : null),
      created: resolved.created,
      key: resolved.key,
    };
  }

  /** inode + size + mtime: a rename-based rotation always changes the inode. */
  private statStamp(): string {
    if (!this.file) return "";
    try {
      const s = statSync(this.file);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "";
    }
  }

  private refresh(): void {
    if (!this.file) return;
    const stamp = this.statStamp();
    if (stamp === this.stamp) return;
    try {
      const key = readKeyFile(this.file);
      if (!key) return; // missing/empty: keep the previous key and retry on the next request
      this.hash = hashApiKey(key);
      this.stamp = stamp;
    } catch {
      /* keep the previous key; retry on the next request */
    }
  }

  verify(candidate: string): boolean {
    this.refresh();
    return timingSafeEqual(hashApiKey(candidate), this.hash);
  }
}
