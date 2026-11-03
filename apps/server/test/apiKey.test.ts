import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegacyApiKey, resolveApiKey, rotateApiKey } from "../src/apiKey.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chirp-key-"));
  file = join(dir, "api-key");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("legacy api key", () => {
  it("is no longer created automatically", () => {
    expect(resolveApiKey({ apiKey: null, apiKeyFile: file })).toBeNull();
    const legacy = LegacyApiKey.fromConfig({ apiKey: null, apiKeyFile: file });
    expect(legacy.active).toBe(false);
    expect(legacy.info()).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an existing key file keeps working (upgrade path)", () => {
    writeFileSync(file, "chp_existing_key_from_an_old_install\n", { mode: 0o600 });
    const legacy = LegacyApiKey.fromConfig({ apiKey: null, apiKeyFile: file });
    expect(legacy.verify("chp_existing_key_from_an_old_install")).toBe(true);
    expect(legacy.info()).toMatchObject({ source: "file", prefix: "chp_existin" + "g" });
    expect(legacy.info()?.lastUsedAt).not.toBeNull();
  });

  it("rotation writes 0600 atomically and is picked up immediately, even twice within the same millisecond", () => {
    const legacy = LegacyApiKey.fromConfig({ apiKey: null, apiKeyFile: file });
    const k1 = rotateApiKey({ apiKeyFile: file });
    expect(legacy.verify(k1)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["api-key"]);
    const k2 = rotateApiKey({ apiKeyFile: file });
    const k3 = rotateApiKey({ apiKeyFile: file });
    expect(legacy.verify(k3)).toBe(true);
    expect(legacy.verify(k2)).toBe(false);
    expect(legacy.verify(k1)).toBe(false);
    expect(readFileSync(file, "utf8").trim()).toBe(k3);
  });

  it("an empty file keeps the old key; deleting the file disables it", () => {
    const k1 = rotateApiKey({ apiKeyFile: file });
    const legacy = LegacyApiKey.fromConfig({ apiKey: null, apiKeyFile: file });
    writeFileSync(file, "");
    expect(legacy.verify(k1)).toBe(true);
    rmSync(file);
    expect(legacy.verify(k1)).toBe(false);
    expect(legacy.active).toBe(false);
    const k2 = rotateApiKey({ apiKeyFile: file });
    expect(legacy.verify(k2)).toBe(true);
  });

  it("CHIRP_API_KEY takes precedence and is never written to disk", () => {
    const resolved = resolveApiKey({ apiKey: "chp_env_key_value_123456789", apiKeyFile: file });
    expect(resolved).toEqual({ key: "chp_env_key_value_123456789", source: "env" });
    const legacy = LegacyApiKey.fromConfig({ apiKey: "chp_env_key_value_123456789", apiKeyFile: file });
    expect(legacy.verify("chp_env_key_value_123456789")).toBe(true);
    expect(legacy.info()?.source).toBe("env");
    expect(readdirSync(dir)).toEqual([]);
  });
});
