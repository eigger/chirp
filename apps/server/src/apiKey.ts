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

function readKeyFile(file: string): string | null {
  if (!existsSync(file)) return null;
  const key = readFileSync(file, "utf8").trim();
  return key || null;
}

/** Rotate: write a brand-new key to the key file (atomic, 0600) and return it. */
export function rotateApiKey(config: Pick<Config, "apiKeyFile">): string {
  const key = generateApiKey();
  writeFileAtomic(config.apiKeyFile, `${key}\n`);
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
  const key = rotateApiKey(config);
  return { key, created: true, source: "file" };
}

/** The key comes from CHIRP_API_KEY: it cannot be regenerated from the dashboard. */
export class EnvKeyError extends Error {
  constructor() {
    super("The API key is set by CHIRP_API_KEY and cannot be regenerated here");
  }
}

/**
 * The server's single API key (what Home Assistant uses): CHIRP_API_KEY, or
 * `<dataDir>/api-key` (0600, created on the first start). When it comes from
 * the file it is reloaded whenever the file changes, so `cli.js key rotate`
 * and a dashboard regeneration take effect on the very next request.
 */
export class ApiKeyStore {
  private key: string;
  private hash: Buffer;
  private stamp = "";

  constructor(
    key: string,
    private readonly file: string | null,
  ) {
    this.key = key;
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

  get source(): "env" | "file" {
    return this.file ? "file" : "env";
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
      this.key = key;
      this.hash = hashApiKey(key);
      this.stamp = stamp;
    } catch {
      /* keep the previous key; retry on the next request */
    }
  }

  /** The current key in plain text (for the signed-in admin only). */
  current(): { key: string; source: "env" | "file" } {
    this.refresh();
    return { key: this.key, source: this.source };
  }

  /** Replace the file key; the old key stops working immediately. */
  regenerate(): string {
    if (!this.file) throw new EnvKeyError();
    rotateApiKey({ apiKeyFile: this.file });
    this.refresh();
    return this.key;
  }

  verify(candidate: string): boolean {
    this.refresh();
    return timingSafeEqual(hashApiKey(candidate), this.hash);
  }
}
