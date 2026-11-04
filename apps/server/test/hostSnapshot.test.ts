import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostSnapshotReader } from "../src/hostSnapshot.js";
import type { HostSnapshot } from "@chirp/shared";

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "chirp-snap-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sampleSnapshot: HostSnapshot = {
  version: 1,
  timestamp: 1000000,
  host: {
    hostname: "pve-test",
    kernel: "6.8.0-pve",
    uptimeSeconds: 3600,
  },
  proc: {
    meminfo: "MemTotal: 16000000 kB\nMemFree: 8000000 kB\n",
    stat: "cpu  100 200 300 400 500 0 0 0 0 0\n",
    loadavg: "0.50 0.40 0.30 1/500 1234\n",
    cpuinfo: "model name : AMD Ryzen\n",
  },
  net: {
    interfaces: [
      {
        name: "eno1",
        kind: "physical",
        operState: "up",
        up: true,
        ifindex: 2,
        speedMbps: 1000,
        rxBytes: 10000,
        txBytes: 20000,
        rxErrors: 0,
        txErrors: 0,
        rxDropped: 0,
        txDropped: 0,
      },
    ],
  },
  hwmon: {
    cpuModel: "AMD Ryzen",
    cpu: {
      packageTemp: 45.5,
      maxTemp: 50.0,
      highTemp: 80.0,
      critTemp: 90.0,
      cores: [{ label: "Core 0", temp: 42.0 }],
      source: "k10temp",
    },
    sensors: [{ chip: "nvme", label: "Composite", temp: 38.0 }],
    rapl: [
      {
        zone: "intel-rapl:0",
        label: "package-0",
        isPackage: true,
        energyUj: 1234567,
        maxEnergyRangeUj: 10000000,
      },
    ],
    power: [{ id: "p1", chip: "zenpower", label: "CPU Power", watts: 65.2 }],
    fans: [{ id: "f1", chip: "nct6779", label: "CPU Fan", rpm: 1200 }],
    voltages: [{ id: "v1", chip: "nct6779", label: "+12V", volts: 12.1 }],
  },
  smart: {
    collectedAt: 1000000,
    devices: [
      {
        devicePath: "/dev/sda",
        type: "sat",
        byIds: ["ata-Crucial_CT500MX500SSD1_12345"],
        wwn: "0x500a0751e1234567",
        smartctl: { smart_status: { passed: true } },
      },
    ],
  },
};

describe("HostSnapshotReader", () => {
  it("returns null when path is not set or file does not exist", () => {
    const reader1 = new HostSnapshotReader({ path: null });
    expect(reader1.read()).toEqual({ snapshot: null, stale: false, error: null });

    const reader2 = new HostSnapshotReader({ path: "/path/that/does/not/exist.json" });
    expect(reader2.read()).toEqual({ snapshot: null, stale: false, error: null });
  });

  it("rejects files exceeding maxBytes", () => {
    withTempDir((dir) => {
      const p = join(dir, "oversize.json");
      writeFileSync(p, "x".repeat(100));

      const warn = vi.fn();
      const reader = new HostSnapshotReader({ path: p, maxBytes: 50, warn });
      const res = reader.read();

      expect(res.snapshot).toBeNull();
      expect(res.error).toMatch(/exceeds maximum size/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeds maximum size"));
    });
  });

  it("rejects malformed json or invalid schema", () => {
    withTempDir((dir) => {
      const p = join(dir, "invalid.json");
      writeFileSync(p, "{ bad json }");

      const warn = vi.fn();
      const reader = new HostSnapshotReader({ path: p, warn });
      let res = reader.read();
      expect(res.snapshot).toBeNull();
      expect(res.error).toBeTruthy();

      writeFileSync(p, JSON.stringify({ version: 2 })); // wrong version
      res = reader.read();
      expect(res.snapshot).toBeNull();
      expect(res.error).toMatch(/schema validation failed/);
    });
  });

  it("loads a valid snapshot and converts sections cleanly", () => {
    withTempDir((dir) => {
      const p = join(dir, "host.json");
      writeFileSync(p, JSON.stringify(sampleSnapshot));

      const reader = new HostSnapshotReader({ path: p, now: () => 1000000 });
      const res = reader.read();

      expect(res.error).toBeNull();
      expect(res.stale).toBe(false);
      expect(res.snapshot?.version).toBe(1);
      expect(res.snapshot?.host?.hostname).toBe("pve-test");

      // Verify converters
      const rawIfaces = HostSnapshotReader.toRawInterfaces(res.snapshot?.net?.interfaces);
      expect(rawIfaces).toHaveLength(1);
      expect(rawIfaces[0].name).toBe("eno1");
      expect(rawIfaces[0].up).toBe(true);

      const sensorReadout = HostSnapshotReader.toSensorReadout(res.snapshot?.hwmon);
      expect(sensorReadout?.cpu.packageTemp).toBe(45.5);
      expect(sensorReadout?.sensors[0].chip).toBe("nvme");

      const extras = HostSnapshotReader.toHwmonExtras(res.snapshot?.hwmon);
      expect(extras.power[0].watts).toBe(65.2);
      expect(extras.fans[0].rpm).toBe(1200);
      expect(extras.voltages[0].volts).toBe(12.1);

      const rapl = HostSnapshotReader.toRaplZones(res.snapshot?.hwmon);
      expect(rapl[0].label).toBe("package-0");

      const smartMap = HostSnapshotReader.toSmartDeviceMap(res.snapshot?.smart?.devices);
      expect(smartMap.get("/dev/sda")?.wwn).toBe("0x500a0751e1234567");
    });
  });

  it("detects staleness when snapshot timestamp is older than maxAgeSec", () => {
    withTempDir((dir) => {
      const p = join(dir, "host.json");
      writeFileSync(p, JSON.stringify(sampleSnapshot));

      const warn = vi.fn();
      const nowMs = 1000000 + 70 * 1000; // 70s later (default limit is 60s)
      const reader = new HostSnapshotReader({
        path: p,
        maxAgeSec: 60,
        now: () => nowMs,
        warn,
      });

      const res = reader.read();
      expect(res.stale).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("stale (70s old > 60s limit)"));

      // Fresh snapshot arrives
      const freshSnapshot = { ...sampleSnapshot, timestamp: nowMs };
      writeFileSync(p, JSON.stringify(freshSnapshot));

      const res2 = reader.read();
      expect(res2.stale).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no longer stale"));
    });
  });
});
