import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore, resolveApiKey, rotateApiKey } from "../src/apiKey.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chirp-key-"));
  file = join(dir, "api-key");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("api key file", () => {
  it("is created with mode 0600 and leaves no temp files behind", () => {
    const { key, created } = resolveApiKey({ apiKey: null, apiKeyFile: file });
    expect(created).toBe(true);
    expect(key.startsWith("chp_")).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["api-key"]);
  });

  it("rotation is picked up immediately, even twice within the same millisecond", () => {
    const { store, key } = ApiKeyStore.fromConfig({ apiKey: null, apiKeyFile: file });
    expect(store.verify(key)).toBe(true);
    const k2 = rotateApiKey({ apiKeyFile: file });
    expect(store.verify(k2)).toBe(true);
    expect(store.verify(key)).toBe(false);
    const k3 = rotateApiKey({ apiKeyFile: file });
    const k4 = rotateApiKey({ apiKeyFile: file });
    expect(store.verify(k4)).toBe(true);
    expect(store.verify(k3)).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(k4);
  });

  it("an empty/missing file keeps the old key and a later valid write is still loaded", () => {
    const { store, key } = ApiKeyStore.fromConfig({ apiKey: null, apiKeyFile: file });
    writeFileSync(file, "");
    expect(store.verify(key)).toBe(true);
    rmSync(file);
    expect(store.verify(key)).toBe(true);
    const k2 = rotateApiKey({ apiKeyFile: file });
    expect(store.verify(k2)).toBe(true);
  });

  it("CHIRP_API_KEY takes precedence and is never written to disk", () => {
    const { store, key, created } = ApiKeyStore.fromConfig({ apiKey: "chp_env_key_value_123456789", apiKeyFile: file });
    expect(created).toBe(false);
    expect(key).toBe("chp_env_key_value_123456789");
    expect(store.verify(key)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});
