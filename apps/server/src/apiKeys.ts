import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ApiKeyInfo } from "@chirp/shared";
import { apiKeyPrefix, generateApiKey, hashApiKey, isApiKeyPlaintext } from "./apiKey.js";
import { writeFileAtomic } from "./secureFile.js";

/** "Last used" is written at most this often, so Home Assistant polling does not rewrite the file every 30 s. */
export const LAST_USED_INTERVAL_MS = 5 * 60_000;
/** Upper bound on dashboard keys (a key per integration is plenty). */
export const MAX_API_KEYS = 50;

interface StoredKey {
  id: string;
  name: string;
  prefix: string;
  /** sha256 of the plaintext key, hex. The plaintext is never stored. */
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface KeyFile {
  version: 1;
  keys: StoredKey[];
}

export class TooManyKeysError extends Error {}

function isStoredKey(v: unknown): v is StoredKey {
  const k = v as StoredKey;
  return (
    typeof k === "object" &&
    k !== null &&
    typeof k.id === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(k.id) &&
    typeof k.name === "string" &&
    typeof k.prefix === "string" &&
    typeof k.hash === "string" &&
    /^[0-9a-f]{64}$/.test(k.hash) &&
    typeof k.createdAt === "string" &&
    (k.lastUsedAt === null || typeof k.lastUsedAt === "string")
  );
}

/**
 * Dashboard-managed API keys in `<dataDir>/api-keys.json` (0600, atomic
 * writes). Only the server process writes this file; every mutation is
 * synchronous, so concurrent requests cannot interleave a read-modify-write.
 */
export class ApiKeyStore {
  private keys: StoredKey[] = [];
  private byHash = new Map<string, StoredKey>();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<KeyFile>;
    const keys = Array.isArray(parsed.keys) ? parsed.keys.filter(isStoredKey) : [];
    this.keys = keys;
    this.byHash = new Map(keys.map((k) => [k.hash, k]));
  }

  private save(): void {
    const body: KeyFile = { version: 1, keys: this.keys };
    writeFileAtomic(this.file, `${JSON.stringify(body, null, 2)}\n`);
  }

  private info(k: StoredKey): ApiKeyInfo {
    return {
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      source: "dashboard",
      revocable: true,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    };
  }

  list(): ApiKeyInfo[] {
    return this.keys.map((k) => this.info(k));
  }

  get size(): number {
    return this.keys.length;
  }

  /** Create a key. The plaintext is returned here and nowhere else. */
  create(name: string): { info: ApiKeyInfo; key: string } {
    if (this.keys.length >= MAX_API_KEYS) throw new TooManyKeysError();
    const key = generateApiKey();
    const stored: StoredKey = {
      id: randomBytes(8).toString("hex"),
      name,
      prefix: apiKeyPrefix(key),
      hash: hashApiKey(key).toString("hex"),
      createdAt: new Date(this.now()).toISOString(),
      lastUsedAt: null,
    };
    this.keys = [...this.keys, stored];
    try {
      this.save();
    } catch (err) {
      this.keys = this.keys.filter((k) => k !== stored);
      throw err;
    }
    this.byHash.set(stored.hash, stored);
    return { info: this.info(stored), key };
  }

  /** Remove a key; it stops working immediately. False when the id is unknown. */
  revoke(id: string): boolean {
    const target = this.keys.find((k) => k.id === id);
    if (!target) return false;
    const before = this.keys;
    this.keys = this.keys.filter((k) => k !== target);
    try {
      this.save();
    } catch (err) {
      this.keys = before;
      throw err;
    }
    this.byHash.delete(target.hash);
    return true;
  }

  /**
   * Look a presented key up by its sha256. Only the digest of a secret is used
   * as the map key, so lookup timing reveals nothing about the stored keys.
   */
  verify(candidate: string): boolean {
    if (!isApiKeyPlaintext(candidate)) return false;
    const k = this.byHash.get(hashApiKey(candidate).toString("hex"));
    if (!k) return false;
    const t = this.now();
    if (!k.lastUsedAt || t - Date.parse(k.lastUsedAt) >= LAST_USED_INTERVAL_MS) {
      k.lastUsedAt = new Date(t).toISOString();
      try {
        this.save();
      } catch {
        /* metadata only; retried on the next use */
      }
    }
    return true;
  }
}
