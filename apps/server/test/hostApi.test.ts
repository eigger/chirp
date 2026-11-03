import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { HistoryResponse, NotFoundResponse, StatusSnapshot } from "@chirp/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ApiKeyStore, generateApiKey } from "../src/apiKey.js";
import { buildApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { HostSample } from "../src/hostMetrics.js";
import { Collector, type CollectorDeps } from "../src/scheduler.js";

const KEY = generateApiKey();
const auth = { authorization: `Bearer ${KEY}` };

function iface(id: string, rx: number | null, tx: number | null) {
  return {
    id,
    name: id,
    kind: "physical" as const,
    up: true,
    operState: "up",
    speedMbps: 1000,
    rxBytes: 1,
    txBytes: 1,
    rxBytesPerSec: rx,
    txBytesPerSec: tx,
    rxErrors: 0,
    txErrors: 0,
    rxDropped: 0,
    txDropped: 0,
  };
}

function sample(n: number, ifaces = ["eno1"]): HostSample {
  return {
    memory: {
      scope: "host",
      totalBytes: 100,
      availableBytes: 40,
      usedBytes: 60,
      usedPercent: 60 + n,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      swapUsedPercent: null,
    },
    load: { scope: "host", load1: 1 + n, load5: 1, load15: 1, cpuCount: 8, cpuUsagePercent: n === 0 ? null : 12.5 },
    network: { scope: "host", interfaces: ifaces.map((id) => iface(id, n === 0 ? null : 100 * n, 50)) },
    power: { packageWatts: n === 0 ? null : 20, packageSource: "rapl", sources: [{ id: "rapl_package_0", label: "package-0", watts: n === 0 ? null : 20 }] },
    fans: [{ id: "nct6798_cpu_fan", chip: "nct6798", label: "CPU Fan", rpm: 1200 }],
    voltages: [{ id: "nct6798_in0", chip: "nct6798", label: "in0", volts: 1.032 }],
  };
}

function collector(extra: Partial<CollectorDeps> = {}) {
  let t = 0;
  const deps: CollectorDeps = {
    readSensors: () => ({
      cpu: { packageTemp: 47, maxTemp: 50, highTemp: 80, critTemp: 100, cores: [], source: "coretemp" },
      sensors: [],
    }),
    readCpuModel: () => "Fake CPU",
    discoverDevices: async () => [],
    readDisk: async () => {
      throw new Error("unused");
    },
    now: () => new Date(1_700_000_000_000 + t++ * 60_000),
    ...extra,
  };
  return new Collector(deps, {
    instanceId: "8f0c2b7e-3a41-4d6e-9b1f-5c7d2e8a9f10",
    version: "0.1.0",
    displayName: "pve",
    sensorIntervalSec: 10,
    smartIntervalSec: 300,
  });
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function appFor(c: Collector) {
  const dataDir = mkdtempSync(join(tmpdir(), "chirp-host-api-"));
  const config = { ...loadConfig({}), webDir: "/nonexistent", dataDir };
  const app = await buildApp({ config, collector: c, auth: createAuth(config, new ApiKeyStore(KEY, null)) });
  close = async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return app;
}

describe("collector + host metrics", () => {
  it("snapshot carries the host sections and passes the shared schema", async () => {
    let n = 0;
    const c = collector({ sampleHost: () => sample(n++) });
    c.collectSensors();
    c.collectSensors();
    const snap = StatusSnapshot.parse(c.getSnapshot());
    expect(snap.memory?.usedPercent).toBe(61);
    expect(snap.load?.cpuUsagePercent).toBe(12.5);
    expect(snap.network?.interfaces[0].rxBytesPerSec).toBe(100);
    expect(snap.power?.packageWatts).toBe(20);
    expect(snap.fans).toHaveLength(1);
    expect(snap.voltages).toHaveLength(1);
  });

  it("without a host sampler the sections are absent (old-server shape)", () => {
    const c = collector();
    c.collectSensors();
    const snap = c.getSnapshot();
    expect("memory" in snap).toBe(false);
    expect(StatusSnapshot.parse(snap).network).toBeUndefined();
  });

  it("records history; null rates are skipped; vanished interfaces are forgotten", () => {
    let n = 0;
    let ifaces = ["eno1", "eno2"];
    const c = collector({ sampleHost: () => sample(n++, ifaces) });
    c.collectSensors(); // first sample: rates null
    expect(c.history.has("network.eno1.rx")).toBe(false);
    expect(c.history.query("memory.usedPercent", 86_400_000, 1_700_000_000_000 + 3_600_000)).toHaveLength(1);
    c.collectSensors();
    const now = 1_700_000_000_000 + 3_600_000;
    expect(c.history.query("network.eno1.rx", 86_400_000, now).map((p) => p[1])).toEqual([100]);
    expect(c.history.query("network.eno2.tx", 86_400_000, now).map((p) => p[1])).toEqual([50, 50]);
    expect(c.history.query("load.cpuUsagePercent", 86_400_000, now).map((p) => p[1])).toEqual([12.5]);
    expect(c.history.query("load.load1", 86_400_000, now).map((p) => p[1])).toEqual([1, 2]);
    expect(c.history.query("power.packageWatts", 86_400_000, now).map((p) => p[1])).toEqual([20]);
    ifaces = ["eno1"];
    c.collectSensors();
    expect(c.history.has("network.eno2.rx")).toBe(false);
    expect(c.hasInterface("eno2")).toBe(false);
    expect(c.hasInterface("eno1")).toBe(true);
  });

  it("a failing host sampler does not affect CPU readings and keeps the last host sample", () => {
    let fail = false;
    const c = collector({
      sampleHost: () => {
        if (fail) throw new Error("boom");
        return sample(1);
      },
    });
    c.collectSensors();
    fail = true;
    c.collectSensors();
    const snap = StatusSnapshot.parse(c.getSnapshot());
    expect(snap.cpu.packageTemp).toBe(47);
    expect(snap.memory?.usedPercent).toBe(61);
  });

  it("host rates use the monotonic clock, not the wall clock", () => {
    const seen: number[] = [];
    let mono = 1000;
    const c = collector({
      monotonicMs: () => mono,
      sampleHost: (t) => {
        seen.push(t);
        return sample(1);
      },
    });
    c.collectSensors();
    mono = 11_000;
    c.collectSensors();
    expect(seen).toEqual([1000, 11_000]);
  });

  it("a failing CPU sensor read does not stop host metrics", () => {
    const c = collector({
      readSensors: () => {
        throw new Error("hwmon gone");
      },
      sampleHost: () => sample(1),
    });
    c.collectSensors();
    expect(c.getSnapshot().memory?.usedPercent).toBe(61);
  });
});

describe("API: host metrics", () => {
  it("/status passes the schema and history knows the new metrics", async () => {
    let n = 0;
    const c = collector({ sampleHost: () => sample(n++) });
    c.collectSensors();
    c.collectSensors();
    const app = await appFor(c);
    const status = await app.inject({ url: "/api/v1/status", headers: auth });
    expect(StatusSnapshot.parse(status.json()).network?.scope).toBe("host");

    for (const metric of ["memory.usedPercent", "load.cpuUsagePercent", "load.load1", "power.packageWatts", "network.eno1.rx", "network.eno1.tx"]) {
      const res = await app.inject({ url: `/api/v1/history?metric=${metric}&range=24h`, headers: auth });
      expect(res.statusCode, metric).toBe(200);
      expect(HistoryResponse.parse(res.json()).metric).toBe(metric);
    }
    for (const metric of ["network.eno9.rx", "network.eno1.both", "memory.bogus"]) {
      const res = await app.inject({ url: `/api/v1/history?metric=${metric}`, headers: auth });
      expect(res.statusCode, metric).toBe(404);
      NotFoundResponse.parse(res.json());
    }
  });

  it("fixed metrics exist (empty) even without host data", async () => {
    const app = await appFor(collector());
    const res = await app.inject({ url: "/api/v1/history?metric=power.packageWatts", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ metric: "power.packageWatts", points: [] });
  });
});

describe("shared fixtures", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`../../../packages/shared/fixtures/${name}`, import.meta.url)), "utf8"));

  it.each(["status.sample.json", "status.container-scope.json", "status.null-sections.json", "status.legacy.json"])("%s passes the schema", (name) => {
    StatusSnapshot.parse(read(name));
  });
});

describe("config", () => {
  it("host roots and network filters", () => {
    const c = loadConfig({
      CHIRP_HOST_PROC: "/mnt/proc",
      CHIRP_HOST_SYS: "/mnt/sys",
      CHIRP_NET_INCLUDE: "wg*, tap100*",
      CHIRP_NET_EXCLUDE: "eno2",
    });
    expect(c.hostProc).toBe("/mnt/proc");
    expect(c.hostSys).toBe("/mnt/sys");
    expect(c.netInclude).toEqual(["wg*", "tap100*"]);
    expect(c.netExclude).toEqual(["eno2"]);
    const d = loadConfig({});
    expect(["/host/proc", "/proc"]).toContain(d.hostProc);
    expect(d.netInclude).toEqual([]);
  });
});
