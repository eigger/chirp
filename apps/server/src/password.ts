import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@chirp/shared";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

/** OWASP-style interactive parameters: 32 MiB of memory, ~50-100 ms per hash. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 32768, r: 8, p: 1, keyLen: 32 };

/** Parameters read back from admin.json are bounded so a crafted file cannot exhaust memory/CPU. */
const MAX_N = 1 << 20;

export interface PasswordHash extends ScryptParams {
  algo: "scrypt";
  salt: string; // base64
  hash: string; // base64
}

function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const opts: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r * params.p + 1024 * 1024,
  };
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFC"), salt, params.keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export function validParams(p: Partial<ScryptParams>): p is ScryptParams {
  return (
    Number.isInteger(p.N) &&
    (p.N as number) >= 2 &&
    (p.N as number) <= MAX_N &&
    ((p.N as number) & ((p.N as number) - 1)) === 0 &&
    Number.isInteger(p.r) &&
    (p.r as number) >= 1 &&
    (p.r as number) <= 32 &&
    Number.isInteger(p.p) &&
    (p.p as number) >= 1 &&
    (p.p as number) <= 16 &&
    Number.isInteger(p.keyLen) &&
    (p.keyLen as number) >= 16 &&
    (p.keyLen as number) <= 128
  );
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, params);
  return { algo: "scrypt", ...params, salt: salt.toString("base64"), hash: hash.toString("base64") };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (stored.algo !== "scrypt" || !validParams(stored)) return false;
  const expected = Buffer.from(stored.hash, "base64");
  if (expected.length !== stored.keyLen) return false;
  const actual = await scrypt(password, Buffer.from(stored.salt, "base64"), stored);
  return timingSafeEqual(actual, expected);
}

/**
 * Burn the same work as a real verification when there is nothing to verify
 * against (unknown user, no admin yet), so response time does not reveal it.
 */
export async function dummyVerify(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<false> {
  await scrypt(password, Buffer.alloc(16), params);
  return false;
}

/** null when acceptable, else why not. */
export function passwordProblem(password: string): "too_short" | "too_long" | null {
  const len = [...password].length;
  if (len < MIN_PASSWORD_LENGTH) return "too_short";
  if (len > MAX_PASSWORD_LENGTH) return "too_long";
  return null;
}

/** A random password for generated accounts (20 characters, ~120 bits). */
export function generatePassword(): string {
  return randomBytes(15).toString("base64url");
}
