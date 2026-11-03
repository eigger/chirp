import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { API_KEY_PREFIX } from "@chirp/shared";
import type { Config } from "./config.js";
import { writeFileAtomic } from "./secureFile.js";

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(plaintext: string): Buffer {
  return createHash("sha256").update(plaintext, "utf8").digest();
}

export function isApiKeyPlaintext(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX.length + 16;
}

/** What the key list shows of a key: `chp_` plus the next 8 characters. */
export function apiKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, API_KEY_PREFIX.length + 8);
}

function readKeyFile(file: string): string | null {
  if (!existsSync(file)) return null;
  const key = readFileSync(file, "utf8").trim();
  return key || null;
}

/**
 * Rotate the legacy key: write a brand-new key to the key file (atomic, 0600)
 * and return it. A running server picks it up on the next request.
 */
export function rotateApiKey(config: Pick<Config, "apiKeyFile">): string {
  const key = generateApiKey();
  writeFileAtomic(config.apiKeyFile, `${key}\n`);
  return key;
}

/**
 * The legacy key (CHIRP_API_KEY first, then the key file), or null.
 * Since admin accounts exist the server no longer creates this key on its own:
 * new installs have no legacy key and create keys in the dashboard.
 */
export function resolveApiKey(
  config: Pick<Config, "apiKey" | "apiKeyFile">,
): { key: string; source: "env" | "file" } | null {
  if (config.apiKey) return { key: config.apiKey, source: "env" };
  const existing = readKeyFile(config.apiKeyFile);
  return existing ? { key: existing, source: "file" } : null;
}

/**
 * The legacy single API key (CHIRP_API_KEY or `<dataDir>/api-key`), kept so
 * installs from before admin accounts keep working. Read-only from the API.
 * A file key is re-read whenever the file changes, so `cli.js key rotate`
 * needs no restart; deleting the file disables it immediately.
 */
export class LegacyApiKey {
  private hash: Buffer | null = null;
  private plainPrefix: string | null = null;
  private stamp = "";
  private createdAt: string | null = null;
  lastUsedAt: string | null = null;

  constructor(
    private readonly env: string | null,
    private readonly file: string | null,
  ) {
    if (env) this.set(env);
    else this.refresh(true);
  }

  static fromConfig(config: Pick<Config, "apiKey" | "apiKeyFile">): LegacyApiKey {
    return new LegacyApiKey(config.apiKey, config.apiKey ? null : config.apiKeyFile);
  }

  get source(): "env" | "file" {
    return this.env ? "env" : "file";
  }

  private set(key: string): void {
    this.hash = hashApiKey(key);
    this.plainPrefix = apiKeyPrefix(key);
  }

  /** inode + size + mtime: a rename-based rotation always changes the inode. */
  private statStamp(): { stamp: string; mtime: string | null } {
    if (!this.file) return { stamp: "", mtime: null };
    try {
      const s = statSync(this.file);
      return { stamp: `${s.ino}:${s.size}:${s.mtimeMs}`, mtime: s.mtime.toISOString() };
    } catch {
      return { stamp: "missing", mtime: null };
    }
  }

  private refresh(force = false): void {
    if (!this.file) return;
    const { stamp, mtime } = this.statStamp();
    if (!force && stamp === this.stamp) return;
    if (stamp === "missing") {
      // Deleting the file is how the legacy key is turned off.
      this.hash = null;
      this.plainPrefix = null;
      this.createdAt = null;
      this.stamp = stamp;
      return;
    }
    try {
      const key = readKeyFile(this.file);
      if (!key) return; // empty: keep the previous key and retry on the next request
      this.set(key);
      this.createdAt = mtime;
      this.stamp = stamp;
    } catch {
      /* unreadable: keep the previous key; retry on the next request */
    }
  }

  /** Whether a legacy key is currently configured. */
  get active(): boolean {
    this.refresh();
    return this.hash !== null;
  }

  info(): { prefix: string; source: "env" | "file"; createdAt: string | null; lastUsedAt: string | null } | null {
    this.refresh();
    if (!this.hash || !this.plainPrefix) return null;
    return { prefix: this.plainPrefix, source: this.source, createdAt: this.createdAt, lastUsedAt: this.lastUsedAt };
  }

  verify(candidate: string, now = new Date()): boolean {
    this.refresh();
    if (!this.hash) return false;
    const ok = timingSafeEqual(hashApiKey(candidate), this.hash);
    if (ok) this.lastUsedAt = now.toISOString();
    return ok;
  }
}
