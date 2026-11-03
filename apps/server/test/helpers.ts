import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ScryptParams } from "../src/password.js";

/** Cheap scrypt parameters so tests do not spend 32 MiB / ~80 ms per hash. */
export const FAST_SCRYPT: ScryptParams = { N: 1024, r: 8, p: 1, keyLen: 32 };

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));
}

export function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}
