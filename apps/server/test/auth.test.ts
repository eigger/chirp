import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiKeyRegenerateResponse,
  ApiKeyResponse,
  AuthUserResponse,
  BootstrapStatusResponse,
  ConflictResponse,
  ForbiddenResponse,
  InvalidCredentialsResponse,
  PasswordMismatchResponse,
  RateLimitedResponse,
  StatusSnapshot,
  UnauthorizedResponse,
  WeakPasswordResponse,
} from "@chirp/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminStore } from "../src/admin.js";
import { ApiKeyStore, rotateApiKey } from "../src/apiKey.js";
import { buildApp } from "../src/app.js";
import { adminFile, createAuth, type Auth } from "../src/auth.js";
import { bootstrapAuth } from "../src/bootstrap.js";
import { loadConfig, type Config } from "../src/config.js";
import { BusyError, dummyVerify, hashPassword, scryptGate, Semaphore, verifyPassword } from "../src/password.js";
import { clientKey, FREE_FAILURES } from "../src/rateLimit.js";
import { createFileExclusive } from "../src/secureFile.js";
import { SESSION_IDLE_MS, SESSION_MAX_MS } from "../src/session.js";
import { Collector } from "../src/scheduler.js";
import { FAST_SCRYPT } from "./helpers.js";

const USER = "admin";
const PASS = "correct horse battery";
const ENV_KEY = "chp_env_key_from_config_1234567890";
const CSRF = { "x-chirp-csrf": "1" };

let dir: string;
let clock: number;
let auth: Auth;
let app: FastifyInstance;
let config: Config;

function collector(): Collector {
  return new Collector(
    {
      readSensors: () => ({ cpu: { packageTemp: 40, maxTemp: 40, highTemp: null, critTemp: null, cores: [], source: null }, sensors: [] }),
      readCpuModel: () => null,
      discoverDevices: async () => [],
      readDisk: async () => {
        throw new Error("unused");
      },
      now: () => new Date(clock),
    },
    { instanceId: "8f0c2b7e-3a41-4d6e-9b1f-5c7d2e8a9f10", version: "0.1.0", displayName: "pve", sensorIntervalSec: 10, smartIntervalSec: 300 },
  );
}

async function start(env: Record<string, string> = {}, opts: { admin?: boolean } = { admin: true }) {
  config = { ...loadConfig({ CHIRP_DATA_DIR: dir, ...env }), webDir: join(dir, "no-web") };
  auth = createAuth(config, ApiKeyStore.fromConfig(config).store, { now: () => clock, scrypt: FAST_SCRYPT });
  if (opts.admin) await auth.admin.create(USER, PASS);
  app = await buildApp({ config, collector: collector(), auth, now: () => clock });
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers["set-cookie"] ?? "");
  const m = /chirp_session=([^;]*)/.exec(raw);
  if (!m || !m[1]) throw new Error(`no session cookie in ${raw}`);
  return `chirp_session=${m[1]}`;
}

async function login(username = USER, password = PASS, ip = "10.0.0.1") {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: CSRF,
    payload: { username, password },
    remoteAddress: ip,
  });
}

async function session(): Promise<string> {
  const res = await login();
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

async function getKey(cookie: string): Promise<string> {
  const res = await app.inject({ url: "/api/v1/admin/api-key", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return ApiKeyResponse.parse(res.json()).key;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chirp-auth-"));
  clock = Date.parse("2026-01-01T00:00:00Z");
});
afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("password hashing", () => {
  it("scrypt hash verifies, rejects wrong passwords, and stores no plaintext", async () => {
    const h = await hashPassword("s3cret password", FAST_SCRYPT);
    expect(h).toMatchObject({ algo: "scrypt", N: 1024, r: 8, p: 1, keyLen: 32 });
    expect(JSON.stringify(h)).not.toContain("s3cret");
    expect(await verifyPassword("s3cret password", h)).toBe(true);
    expect(await verifyPassword("s3cret passworD", h)).toBe(false);
    const h2 = await hashPassword("s3cret password", FAST_SCRYPT);
    expect(h2.salt).not.toBe(h.salt);
    expect(await dummyVerify("x", FAST_SCRYPT)).toBe(false);
  });

  it("refuses absurd parameters from a tampered file instead of running them", async () => {
    const h = await hashPassword("s3cret password", FAST_SCRYPT);
    for (const bad of [{ N: 1 << 18 }, { N: 1000 }, { r: 17 }, { p: 5 }, { keyLen: 8 }]) {
      expect(await verifyPassword("s3cret password", { ...h, ...bad }), JSON.stringify(bad)).toBe(false);
    }
  });

  it("rate-limit identity: IPv4 as is, IPv4-mapped IPv6 as IPv4, IPv6 by /64", () => {
    expect(clientKey("192.0.2.1")).toBe("192.0.2.1");
    expect(clientKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(clientKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:0db8:0001:0002:ffff:eeee:dddd:cccc")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
  });

  it("admin.json is 0600 and holds only the hash", async () => {
    await start();
    const file = adminFile(dir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(PASS);
    expect(JSON.parse(text)).toMatchObject({ username: USER, password: { algo: "scrypt" } });
  });

  it("exclusive create: only one of two creators wins", () => {
    const f = join(dir, "x.json");
    expect(createFileExclusive(f, "a")).toBe(true);
    expect(createFileExclusive(f, "b")).toBe(false);
    expect(readFileSync(f, "utf8")).toBe("a");
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe("login / session", () => {
  beforeEach(() => start());

  it("login sets an HttpOnly SameSite=Strict cookie and /auth/me answers", async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(AuthUserResponse.parse(res.json())).toEqual({ username: USER });
    const raw = String(res.headers["set-cookie"]);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Strict/);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/Secure/); // plain HTTP, auto mode
    const me = await app.inject({ url: "/api/v1/auth/me", headers: { cookie: cookieOf(res) } });
    expect(me.statusCode).toBe(200);
    expect(AuthUserResponse.parse(me.json()).username).toBe(USER);
    expect(me.headers["cache-control"]).toBe("no-store");
  });

  it("wrong password, unknown user and malformed bodies", async () => {
    const wrong = await login(USER, "nope nope nope");
    const unknown = await login("root", PASS, "10.0.0.2");
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    // Same body for both: the response does not reveal whether the user exists.
    expect(UnauthorizedResponse.parse(wrong.json())).toEqual(unknown.json());
    expect(wrong.headers["set-cookie"]).toBeUndefined();
    const bad = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: CSRF, payload: { username: 1 } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ url: "/api/v1/auth/me" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie: "chirp_session=forged" } })).statusCode).toBe(401);
  });

  it("login without the CSRF header is refused", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: USER, password: PASS } });
    expect(res.statusCode).toBe(403);
    expect(ForbiddenResponse.parse(res.json())).toEqual({ error: "forbidden" });
  });

  it("backs off exponentially after repeated failures, without becoming a password oracle", async () => {
    for (let i = 0; i < FREE_FAILURES; i++) expect((await login(USER, "wrong password!")).statusCode).toBe(401);
    // Even the right password is not evaluated while backing off.
    const limited = await login();
    expect(limited.statusCode).toBe(429);
    expect(RateLimitedResponse.parse(limited.json()).retryAfter).toBe(1);
    expect(limited.headers["retry-after"]).toBe("1");
    clock += 1000;
    expect((await login(USER, "wrong password!")).statusCode).toBe(401);
    const second = await login();
    expect(RateLimitedResponse.parse(second.json()).retryAfter).toBe(2);
    clock += 2000;
    expect((await login()).statusCode).toBe(200); // success resets
    expect((await login(USER, "wrong password!")).statusCode).toBe(401);
  });

  it("a sustained attack on the username costs the real admin at most the 5 s username cap", async () => {
    // A distributed attacker: a fresh address for every wrong guess, one guess per second, for an hour.
    let rejectedGuesses = 0;
    let evaluatedGuesses = 0;
    for (let i = 0; i < 3600; i++) {
      const res = await login(USER, "wrong password!", `10.${(i >> 8) & 255}.${i & 255}.1`);
      if (res.statusCode === 429) rejectedGuesses++;
      else evaluatedGuesses++;
      clock += 1000;
    }
    // Guessing this username is bounded to about one evaluated password per 5 s, from all sources together.
    expect(evaluatedGuesses).toBeLessThanOrEqual(3600 / 5 + FREE_FAILURES + 1);
    expect(rejectedGuesses).toBeGreaterThan(2500);
    // The admin, from a clean address, is told to wait at most 5 s and then gets in.
    const first = await login(USER, PASS, "192.168.1.10");
    if (first.statusCode === 429) {
      const wait = RateLimitedResponse.parse(first.json()).retryAfter;
      expect(wait).toBeLessThanOrEqual(5);
      clock += wait * 1000;
      expect((await login(USER, PASS, "192.168.1.10")).statusCode).toBe(200);
    } else {
      expect(first.statusCode).toBe(200);
    }
  });

  it("a single source keeps backing off up to 15 minutes", async () => {
    let last = 0;
    for (let failures = 0; failures < 16; ) {
      // A different username every time: only the address key accumulates.
      const res = await login(`user${failures}`, "wrong password!", "10.7.7.7");
      if (res.statusCode === 429) {
        last = RateLimitedResponse.parse(res.json()).retryAfter;
        clock += last * 1000; // wait exactly as told
      } else {
        failures++;
      }
    }
    const res = await login("someone-else", "wrong password!", "10.7.7.7");
    expect(res.statusCode).toBe(429);
    expect(RateLimitedResponse.parse(res.json()).retryAfter).toBe(15 * 60); // 2^11 s, capped at 15 min
    expect(last).toBeGreaterThan(5);
  });

  it("IPv6 clients are grouped by /64: rotating the interface ID does not reset the backoff", async () => {
    for (let i = 0; i < FREE_FAILURES; i++) await login("x", "wrong password!", `2001:db8:1:2::${(i + 1).toString(16)}`);
    const sameBlock = await login("y", "wrong password!", "2001:db8:1:2:dead:beef:0:9");
    expect(sameBlock.statusCode).toBe(429);
    expect((await login("z", "wrong password!", "2001:db8:1:3::1")).statusCode).toBe(401); // another /64
  });

  it("a successful login ends the session of the cookie it came with", async () => {
    const old = await session();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { ...CSRF, cookie: old },
      payload: { username: USER, password: PASS },
    });
    expect(res.statusCode).toBe(200);
    const fresh = cookieOf(res);
    expect(fresh).not.toBe(old);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie: old } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie: fresh } })).statusCode).toBe(200);
  });

  it("parallel guesses are throttled too", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => login(USER, "wrong password!")));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401).length).toBe(FREE_FAILURES);
    expect(codes.filter((c) => c === 429).length).toBe(20 - FREE_FAILURES);
  });

  it("sessions expire after 12 h idle (sliding) and after 7 days in any case", async () => {
    const cookie = await session();
    const me = () => app.inject({ url: "/api/v1/auth/me", headers: { cookie } });
    for (let t = 0; t < SESSION_MAX_MS - SESSION_IDLE_MS; t += SESSION_IDLE_MS - 60_000) {
      clock += SESSION_IDLE_MS - 60_000;
      if (clock - Date.parse("2026-01-01T00:00:00Z") >= SESSION_MAX_MS) break;
      expect((await me()).statusCode).toBe(200);
    }
    clock = Date.parse("2026-01-01T00:00:00Z") + SESSION_MAX_MS + 1;
    expect((await me()).statusCode).toBe(401);

    const idle = await session();
    clock += SESSION_IDLE_MS + 1;
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie: idle } })).statusCode).toBe(401);
  });

  it("logout ends the session and clears the cookie", async () => {
    const cookie = await session();
    const out = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, ...CSRF } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
    const noCsrf = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("changing the password ends every session and keeps the caller signed in", async () => {
    const mine = await session();
    const other = await session();
    const change = (payload: object, cookie = mine) =>
      app.inject({ method: "POST", url: "/api/v1/auth/password", headers: { cookie, ...CSRF }, payload });

    const mismatch = await change({ currentPassword: PASS, newPassword: "a brand new password", newPasswordConfirm: "a brand new passw0rd" });
    expect(mismatch.statusCode).toBe(400);
    expect(PasswordMismatchResponse.parse(mismatch.json())).toEqual({ error: "password_mismatch" });
    const wrong = await change({ currentPassword: "not it at all", newPassword: "a brand new password", newPasswordConfirm: "a brand new password" });
    expect(wrong.statusCode).toBe(400);
    expect(InvalidCredentialsResponse.parse(wrong.json())).toEqual({ error: "invalid_credentials" });
    const weak = await change({ currentPassword: PASS, newPassword: "short", newPasswordConfirm: "short" });
    expect(weak.statusCode).toBe(400);
    expect(WeakPasswordResponse.parse(weak.json())).toEqual({ error: "weak_password" });

    const ok = await change({ currentPassword: PASS, newPassword: "a brand new password", newPasswordConfirm: "a brand new password" });
    expect(ok.statusCode).toBe(204);
    const fresh = cookieOf(ok);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie: mine } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie: other } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie: fresh } })).statusCode).toBe(200);
    expect((await login(USER, PASS, "10.0.0.5")).statusCode).toBe(401);
    expect((await login(USER, "a brand new password", "10.0.0.6")).statusCode).toBe(200);
  });

  it("a password reset from the CLI (another process) also ends sessions", async () => {
    const cookie = await session();
    clock += 5; // a distinct passwordChangedAt
    await new AdminStore(adminFile(dir), FAST_SCRYPT, () => clock).setPassword("reset from the cli");
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await login(USER, "reset from the cli")).statusCode).toBe(200);
  });
});

describe("cookie Secure flag", () => {
  it("is set behind an HTTPS proxy (auto + trust proxy) and when forced", async () => {
    await start({ CHIRP_TRUST_PROXY: "true" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { ...CSRF, "x-forwarded-proto": "https" },
      payload: { username: USER, password: PASS },
    });
    expect(String(res.headers["set-cookie"])).toMatch(/; Secure/);
    await app.close();
    await start({ CHIRP_COOKIE_SECURE: "true" }, { admin: false });
    expect(String((await login()).headers["set-cookie"])).toMatch(/; Secure/);
  });
});

describe("API key (dashboard)", () => {
  beforeEach(() => start());

  it("is created on first start (0600), shown to the admin, and works as a Bearer key", async () => {
    const file = join(dir, "api-key");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const cookie = await session();
    const res = await app.inject({ url: "/api/v1/admin/api-key", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = ApiKeyResponse.parse(res.json());
    expect(body.source).toBe("file");
    expect(body.key).toBe(readFileSync(file, "utf8").trim());
    const status = await app.inject({ url: "/api/v1/status", headers: { authorization: `Bearer ${body.key}` } });
    expect(status.statusCode).toBe(200);
    StatusSnapshot.parse(status.json());
  });

  it("regenerate: the old key is 401 at once, the new key works and is persisted", async () => {
    const cookie = await session();
    const old = await getKey(cookie);
    const noCsrf = await app.inject({ method: "POST", url: "/api/v1/admin/api-key/regenerate", headers: { cookie } });
    expect(noCsrf.statusCode).toBe(403);
    expect(await getKey(cookie)).toBe(old);
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/api-key/regenerate", headers: { cookie, ...CSRF } });
    expect(res.statusCode).toBe(200);
    const fresh = ApiKeyRegenerateResponse.parse(res.json()).key;
    expect(fresh).not.toBe(old);
    const before = await app.inject({ url: "/api/v1/status", headers: { authorization: `Bearer ${old}` } });
    expect(before.statusCode).toBe(401);
    expect(before.headers["www-authenticate"]).toBe("Bearer");
    expect((await app.inject({ url: "/api/v1/status", headers: { authorization: `Bearer ${fresh}` } })).statusCode).toBe(200);
    expect(readFileSync(join(dir, "api-key"), "utf8").trim()).toBe(fresh);
    expect(statSync(join(dir, "api-key")).mode & 0o777).toBe(0o600);
    expect(await getKey(cookie)).toBe(fresh);
  });

  it("a `cli.js key rotate` in another process is picked up by the dashboard too", async () => {
    const cookie = await session();
    const rotated = rotateApiKey({ apiKeyFile: join(dir, "api-key") });
    expect(await getKey(cookie)).toBe(rotated);
  });

  it("the API key can never read or regenerate itself, or reach the account (403); no credentials is 401", async () => {
    const cookie = await session();
    const key = await getKey(cookie);
    const h = { authorization: `Bearer ${key}`, ...CSRF };
    for (const [method, url, payload] of [
      ["GET", "/api/v1/admin/api-key", undefined],
      ["POST", "/api/v1/admin/api-key/regenerate", undefined],
      ["GET", "/api/v1/auth/me", undefined],
      ["POST", "/api/v1/auth/password", { currentPassword: PASS, newPassword: "0123456789ab", newPasswordConfirm: "0123456789ab" }],
    ] as const) {
      const res = await app.inject({ method, url, headers: h, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(ForbiddenResponse.parse(res.json())).toEqual({ error: "forbidden" });
    }
    expect(await getKey(cookie)).toBe(key); // not regenerated
    expect((await app.inject({ url: "/api/v1/admin/api-key" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/admin/api-key/regenerate", headers: CSRF })).statusCode).toBe(401);
  });
});

describe("API key from CHIRP_API_KEY", () => {
  beforeEach(() => start({ CHIRP_API_KEY: ENV_KEY }));

  it("is shown read-only, cannot be regenerated, keeps working, and is never written to disk", async () => {
    const cookie = await session();
    const res = await app.inject({ url: "/api/v1/admin/api-key", headers: { cookie } });
    expect(ApiKeyResponse.parse(res.json())).toEqual({ key: ENV_KEY, source: "env" });
    const regen = await app.inject({ method: "POST", url: "/api/v1/admin/api-key/regenerate", headers: { cookie, ...CSRF } });
    expect(regen.statusCode).toBe(409);
    expect(ConflictResponse.parse(regen.json())).toEqual({ error: "conflict" });
    expect((await app.inject({ url: "/api/v1/status", headers: { authorization: `Bearer ${ENV_KEY}` } })).statusCode).toBe(200);
    expect(existsSync(join(dir, "api-key"))).toBe(false);
  });
});

describe("upgrade from a pre-account install", () => {
  it("an existing api-key file keeps working for Home Assistant and shows up in Settings", async () => {
    const legacy = rotateApiKey({ apiKeyFile: join(dir, "api-key") });
    await start({}, { admin: false });
    expect((await app.inject({ url: "/api/v1/status", headers: { authorization: `Bearer ${legacy}` } })).statusCode).toBe(200);
    expect(BootstrapStatusResponse.parse((await app.inject("/api/v1/bootstrap/status")).json())).toEqual({ needsBootstrap: true });
    await auth.admin.create(USER, PASS);
    expect(await getKey(await session())).toBe(legacy);
  });
});

describe("CSRF on cookie-authenticated data routes", () => {
  beforeEach(() => start());

  it("POST /refresh with the cookie needs the header; with a Bearer key it does not", async () => {
    const cookie = await session();
    expect((await app.inject({ url: "/api/v1/status", headers: { cookie } })).statusCode).toBe(200);
    const noHeader = await app.inject({ method: "POST", url: "/api/v1/refresh", headers: { cookie } });
    expect(noHeader.statusCode).toBe(403);
    const wrong = await app.inject({ method: "POST", url: "/api/v1/refresh", headers: { cookie, "x-chirp-csrf": "yes" } });
    expect(wrong.statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/refresh", headers: { cookie, ...CSRF } })).statusCode).toBe(202);
    const key = await getKey(cookie);
    clock += 60_000;
    expect((await app.inject({ method: "POST", url: "/api/v1/refresh", headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(202);
  });

  it("a wrong Bearer key is 401 even next to a valid cookie", async () => {
    const cookie = await session();
    const res = await app.inject({ url: "/api/v1/status", headers: { cookie, authorization: "Bearer chp_wrongwrongwrongwrongwrong" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("first-run registration (bootstrap)", () => {
  beforeEach(() => start({}, { admin: false }));

  const bootstrap = (payload: object, headers: Record<string, string> = CSRF) =>
    app.inject({ method: "POST", url: "/api/v1/bootstrap/admin", headers, payload });
  const good = { username: USER, password: PASS, passwordConfirm: PASS };

  it("the first visitor creates the admin and is signed in; afterwards it is 409", async () => {
    expect(BootstrapStatusResponse.parse((await app.inject("/api/v1/bootstrap/status")).json())).toEqual({ needsBootstrap: true });
    expect((await login()).statusCode).toBe(401);
    const res = await bootstrap(good);
    expect(res.statusCode).toBe(201);
    expect(AuthUserResponse.parse(res.json())).toEqual({ username: USER });
    expect((await app.inject({ url: "/api/v1/auth/me", headers: { cookie: cookieOf(res) } })).statusCode).toBe(200);
    expect(BootstrapStatusResponse.parse((await app.inject("/api/v1/bootstrap/status")).json())).toEqual({ needsBootstrap: false });
    const again = await bootstrap({ username: "mallory", password: "another password", passwordConfirm: "another password" });
    expect(again.statusCode).toBe(409);
    expect(ConflictResponse.parse(again.json())).toEqual({ error: "conflict" });
    expect(auth.admin.username()).toBe(USER);
    expect((await login()).statusCode).toBe(200);
  });

  it("rejects a mismatched confirmation, a weak password, a bad username and a missing CSRF header", async () => {
    const mismatch = await bootstrap({ ...good, passwordConfirm: "correct horse batterY" });
    expect(mismatch.statusCode).toBe(400);
    expect(PasswordMismatchResponse.parse(mismatch.json())).toEqual({ error: "password_mismatch" });
    const weak = await bootstrap({ username: USER, password: "short", passwordConfirm: "short" });
    expect(WeakPasswordResponse.parse(weak.json())).toEqual({ error: "weak_password" });
    expect((await bootstrap({ ...good, username: "bad user" })).json()).toEqual({ error: "bad_request" });
    expect((await bootstrap({ username: USER, password: PASS })).json()).toEqual({ error: "bad_request" });
    expect((await bootstrap(good, {})).statusCode).toBe(403);
    expect(auth.admin.exists()).toBe(false);
  });

  it("concurrent registrations: exactly one wins", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => bootstrap({ username: `user${i}`, password: PASS, passwordConfirm: PASS })),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(7);
    const winner = results.find((r) => r.statusCode === 201)!;
    expect(auth.admin.username()).toBe(AuthUserResponse.parse(winner.json()).username);
  });

  it("an admin created by another process (CLI/second server) closes the window at once", async () => {
    await new AdminStore(adminFile(dir), FAST_SCRYPT).create("other", PASS);
    expect(BootstrapStatusResponse.parse((await app.inject("/api/v1/bootstrap/status")).json())).toEqual({ needsBootstrap: false });
    expect((await bootstrap(good)).statusCode).toBe(409);
  });
});

describe("start-up notices", () => {
  it("CHIRP_ADMIN_USER/PASSWORD seed the admin once and never log the password", async () => {
    await start({ CHIRP_ADMIN_USER: "ops", CHIRP_ADMIN_PASSWORD: "seeded password!" }, { admin: false });
    const notices = await bootstrapAuth(config, auth);
    expect(auth.admin.username()).toBe("ops");
    expect(JSON.stringify(notices)).not.toContain("seeded password!");
    expect(notices.some((n) => n.level === "warn")).toBe(false);
    expect((await login("ops", "seeded password!")).statusCode).toBe(200);
    // A later start with a different password does not overwrite the account.
    const again = await bootstrapAuth({ adminUser: "ops", adminPassword: "different password" }, auth);
    expect(again.some((n) => /already exists/.test(n.msg))).toBe(true);
    expect((await login("ops", "different password", "10.0.0.9")).statusCode).toBe(401);
  });

  it("warns about the open registration window until an admin exists", async () => {
    await start({}, { admin: false });
    expect((await bootstrapAuth(config, auth)).find((n) => n.level === "warn")?.msg).toMatch(/create it/);
    await auth.admin.create(USER, PASS);
    expect((await bootstrapAuth(config, auth)).some((n) => n.level === "warn")).toBe(false);
  });
});

describe("client address behind proxies", () => {
  const spoofLogins = async (xff: (i: number) => string, remote: string) => {
    const codes: number[] = [];
    for (let i = 0; i < FREE_FAILURES + 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        headers: { ...CSRF, "x-forwarded-for": xff(i) },
        payload: { username: `u${i}`, password: "wrong password!" },
        remoteAddress: remote,
      });
      codes.push(res.statusCode);
    }
    return codes;
  };

  it("without CHIRP_TRUST_PROXY a forged X-Forwarded-For is ignored (backoff still applies)", async () => {
    await start();
    const codes = await spoofLogins((i) => `203.0.113.${i}`, "198.51.100.7");
    expect(codes.slice(FREE_FAILURES)).toEqual([429, 429, 429]);
  });

  it("a hop count trusts only the proxy's own entry, not what the client prepended", async () => {
    await start({ CHIRP_TRUST_PROXY: "1" });
    // The client forges a new leftmost address each time; the proxy appends the real one.
    const codes = await spoofLogins((i) => `203.0.113.${i}, 192.0.2.50`, "10.0.0.2");
    expect(codes.slice(FREE_FAILURES)).toEqual([429, 429, 429]);
  });

  it("a proxy address list behaves the same", async () => {
    await start({ CHIRP_TRUST_PROXY: "10.0.0.0/8" });
    const codes = await spoofLogins((i) => `203.0.113.${i}, 192.0.2.50`, "10.0.0.2");
    expect(codes.slice(FREE_FAILURES)).toEqual([429, 429, 429]);
  });

  it("CHIRP_TRUST_PROXY=true believes the leftmost entry (documented as unsafe unless the proxy overwrites it)", async () => {
    await start({ CHIRP_TRUST_PROXY: "true" });
    const codes = await spoofLogins((i) => `203.0.113.${i}, 192.0.2.50`, "10.0.0.2");
    expect(codes.every((c) => c === 401)).toBe(true);
  });
});

describe("scrypt concurrency gate", () => {
  it("runs at most `max` jobs, queues `queueMax`, rejects the rest immediately", async () => {
    const gate = new Semaphore(2, 3);
    const release: (() => void)[] = [];
    const jobs = Array.from({ length: 10 }, () =>
      gate.run(() => new Promise<void>((resolve) => release.push(resolve))).then(
        () => "ok",
        (e) => (e instanceof BusyError ? "busy" : "other"),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(release).toHaveLength(2);
    while (release.length) {
      release.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r === "ok")).toHaveLength(5);
    expect(results.filter((r) => r === "busy")).toHaveLength(5);
    expect(gate.peak).toBe(2);
  });

  it("an unauthenticated login flood is shed with 429 and never runs more than 2 hashes at once", async () => {
    await start();
    scryptGate.peak = 0;
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => login(`flood${i}`, "wrong password!", `10.66.${i}.1`)),
    );
    const codes = results.map((r) => r.statusCode);
    expect(scryptGate.peak).toBeLessThanOrEqual(2);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    for (const r of results.filter((x) => x.statusCode === 429)) {
      expect(RateLimitedResponse.parse(r.json()).retryAfter).toBe(1);
    }
    expect(codes.every((c) => c === 401 || c === 429)).toBe(true);
  });

  it("admin.json with out-of-range scrypt parameters is refused, not executed", async () => {
    await start();
    const file = adminFile(dir);
    for (const bad of [{ N: 1 << 18 }, { r: 32 }, { p: 8 }]) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...data, password: { ...data.password, ...bad } }));
      clock += 10_000;
      expect((await login(USER, PASS, `10.5.${bad.N ? 1 : bad.r ? 2 : 3}.1`)).statusCode).toBe(401);
      writeFileSync(file, JSON.stringify(data));
    }
    expect((await login(USER, PASS, "10.5.9.1")).statusCode).toBe(200);
  });
});
