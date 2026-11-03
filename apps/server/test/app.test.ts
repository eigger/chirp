import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BadRequestResponse,
  CooldownResponse,
  DiskDetail,
  ErrorResponse,
  HealthResponse,
  HistoryResponse,
  NotFoundResponse,
  StatusSnapshot,
  UnauthorizedResponse,
} from "@chirp/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore, generateApiKey } from "../src/apiKey.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Collector, type CollectorDeps } from "../src/scheduler.js";
import { parseSmartctl } from "../src/smartctl.js";
import { fixture } from "./helpers.js";

const KEY = generateApiKey();
const auth = { authorization: `Bearer ${KEY}` };
let app: FastifyInstance;
let collector: Collector;
let clock = 1_000_000;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "chirp-web-"));
  writeFileSync(join(tmp, "index.html"), "<html>dash</html>");
  const deps: CollectorDeps = {
    readSensors: () => ({
      cpu: { packageTemp: 47, maxTemp: 50, highTemp: 80, critTemp: 100, cores: [{ label: "Core 0", temp: 47 }], source: "coretemp" },
      sensors: [{ chip: "nvme", label: "Composite", temp: 40 }],
    }),
    readCpuModel: () => "Fake CPU",
    discoverDevices: async () => [{ path: "/dev/sda" }],
    readDisk: async () => parseSmartctl(fixture("sata-hdd-ok.json"), { devicePath: "/dev/sda" }),
    now: () => new Date(),
  };
  collector = new Collector(deps, {
    instanceId: "8f0c2b7e-3a41-4d6e-9b1f-5c7d2e8a9f10",
    version: "0.1.0",
    displayName: "pve",
    sensorIntervalSec: 10,
    smartIntervalSec: 300,
  });
  collector.collectSensors();
  await collector.collectSmart();
  clock = 1_000_000;
  app = await buildApp({
    config: { ...loadConfig({}), webDir: tmp },
    collector,
    keys: new ApiKeyStore(KEY, null),
    now: () => clock,
  });
});

afterEach(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("auth", () => {
  it("/health needs no auth", async () => {
    const res = await app.inject("/health");
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json()).status).toBe("ok");
  });

  it.each([
    ["no header", {}],
    ["wrong scheme", { authorization: `Basic ${KEY}` }],
    ["wrong key", { authorization: `Bearer ${generateApiKey()}` }],
    ["empty bearer", { authorization: "Bearer " }],
  ])("401 on %s", async (_n, headers) => {
    for (const [method, url] of [["GET", "/api/v1/status"], ["GET", "/api/v1/disks/x"], ["GET", "/api/v1/history?metric=cpu.packageTemp"], ["POST", "/api/v1/refresh"]] as const) {
      const res = await app.inject({ method, url, headers });
      expect(res.statusCode).toBe(401);
      expect(UnauthorizedResponse.parse(res.json())).toEqual({ error: "unauthorized" });
    }
  });
});

describe("auth scheme", () => {
  it("accepts the Bearer scheme case-insensitively", async () => {
    for (const scheme of ["bearer", "BEARER", "Bearer"]) {
      const res = await app.inject({ url: "/api/v1/status", headers: { authorization: `${scheme} ${KEY}` } });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("api", () => {
  it("status satisfies the shared schema", async () => {
    const res = await app.inject({ url: "/api/v1/status", headers: auth });
    expect(res.statusCode).toBe(200);
    const snap = StatusSnapshot.parse(res.json());
    expect(snap.disks).toHaveLength(1);
    expect(snap.cpu.packageTemp).toBe(47);
  });

  it("disk detail includes raw; unknown id is 404", async () => {
    const res = await app.inject({ url: "/api/v1/disks/wwn_5000c500a1b2c3d4", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(DiskDetail.parse(res.json()).raw).toBeTruthy();
    const missing = await app.inject({ url: "/api/v1/disks/nope", headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(NotFoundResponse.parse(missing.json())).toEqual({ error: "not_found" });
  });

  it("history for cpu and disk; bad input", async () => {
    const cpu = await app.inject({ url: "/api/v1/history?metric=cpu.packageTemp&range=24h", headers: auth });
    expect(cpu.statusCode).toBe(200);
    expect(HistoryResponse.parse(cpu.json()).points.length).toBeGreaterThan(0);
    const disk = await app.inject({ url: "/api/v1/history?metric=disk.wwn_5000c500a1b2c3d4.temperature", headers: auth });
    expect(disk.statusCode).toBe(200);
    const bad = await app.inject({ url: "/api/v1/history", headers: auth });
    expect(bad.statusCode).toBe(400);
    expect(BadRequestResponse.parse(bad.json())).toEqual({ error: "bad_request" });
    expect((await app.inject({ url: "/api/v1/history?metric=cpu.packageTemp&range=2d", headers: auth })).statusCode).toBe(400);
    const unknown = await app.inject({ url: "/api/v1/history?metric=bogus", headers: auth });
    expect(unknown.statusCode).toBe(404);
    expect(NotFoundResponse.parse(unknown.json())).toEqual({ error: "not_found" });
  });

  it("every error body matches the shared ErrorResponse schema", async () => {
    // unparsable JSON body -> Fastify's own 400, mapped to {"error":"bad_request"}
    const badJson = await app.inject({
      method: "POST",
      url: "/api/v1/refresh",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(badJson.statusCode).toBe(400);
    expect(BadRequestResponse.parse(badJson.json())).toEqual({ error: "bad_request" });
    const unknownRoute = await app.inject({ url: "/api/v1/unknown", headers: auth });
    expect(unknownRoute.statusCode).toBe(404);
    expect(ErrorResponse.parse(unknownRoute.json()).error).toBe("not_found");
  });

  it("refresh: 202, then 429 within the cooldown, then 202 again", async () => {
    const post = () => app.inject({ method: "POST", url: "/api/v1/refresh", headers: auth });
    const first = await post();
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ queued: true });
    clock += 10_000;
    const second = await post();
    expect(second.statusCode).toBe(429);
    expect(CooldownResponse.parse(second.json()).retryAfter).toBe(20);
    clock += 20_000;
    expect((await post()).statusCode).toBe(202);
  });
});

describe("static dashboard", () => {
  it("serves index at / and SPA fallback without auth; API paths stay JSON 404", async () => {
    expect((await app.inject("/")).body).toContain("dash");
    expect((await app.inject("/some/route")).body).toContain("dash");
    expect((await app.inject("/assets/missing.js")).statusCode).toBe(404);
    expect((await app.inject("/api/v1/unknown")).statusCode).toBe(404);
    expect((await app.inject("/../../etc/passwd")).body).not.toContain("root:");
  });

  it("rejects malformed percent-encoding and encoded traversal without a 500", async () => {
    const bad = await app.inject("/%E0%A4%A");
    expect(bad.statusCode).toBe(400);
    for (const url of ["/..%2f..%2f..%2fetc%2fpasswd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/..%2f..%2f..%2fetc%2fpasswd", "/a%00b"]) {
      const res = await app.inject(url);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toContain("root:");
    }
  });

  it("is skipped when the web dir does not exist", async () => {
    const bare = await buildApp({
      config: { ...loadConfig({}), webDir: join(tmp, "missing") },
      collector,
      keys: new ApiKeyStore(KEY, null),
    });
    const root = await bare.inject("/");
    expect(root.statusCode).toBe(404);
    // still the JSON error contract, not Fastify's default 404 body
    expect(NotFoundResponse.parse(root.json())).toEqual({ error: "not_found" });
    expect(NotFoundResponse.parse((await bare.inject("/api/v1/nope")).json())).toEqual({ error: "not_found" });
    await bare.close();
  });
});
