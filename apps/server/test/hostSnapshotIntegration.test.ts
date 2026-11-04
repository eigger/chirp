import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { defaultDeps } from "../src/scheduler.js";
import type { HostSnapshot } from "@chirp/shared";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "chirp-snap-integ-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function getMockSnapshot(timestamp = Date.now()): HostSnapshot {
  return {
    version: 1,
    timestamp,
    host: {
      hostname: "test-pve-host",
      kernel: "6.8.4-2-pve",
      uptimeSeconds: 7200,
    },
    proc: {
      meminfo: "MemTotal: 32000000 kB\nMemAvailable: 24000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
      stat: "cpu  1000 200 300 4000 500 0 0 0 0 0\ncpu0 1000 200 300 4000 500 0 0 0 0 0\n",
      loadavg: "1.25 0.85 0.65 2/850 4567\n",
      cpuinfo: "model name : AMD EPYC 7002\n",
    },
    net: {
      interfaces: [
        {
          name: "vmbr0",
          kind: "bridge",
          operState: "up",
          up: true,
          ifindex: 3,
          speedMbps: 10000,
          rxBytes: 50000000,
          txBytes: 80000000,
          rxErrors: 0,
          txErrors: 0,
          rxDropped: 0,
          txDropped: 0,
        },
      ],
    },
    hwmon: {
      cpuModel: "AMD EPYC 7002",
      cpu: {
        packageTemp: 48.0,
        maxTemp: 52.0,
        highTemp: 85.0,
        critTemp: 95.0,
        cores: [{ label: "Core 0", temp: 44.0 }],
        source: "k10temp",
      },
      sensors: [{ chip: "k10temp", label: "Tctl", temp: 48.0 }],
      rapl: [
        {
          zone: "intel-rapl:0",
          label: "package-0",
          isPackage: true,
          energyUj: 5000000,
          maxEnergyRangeUj: 10000000,
        },
      ],
      power: [{ id: "p1", chip: "zenpower", label: "Package Power", watts: 120.5 }],
      fans: [{ id: "f1", chip: "nct6779", label: "Chassis Fan 1", rpm: 1500 }],
      voltages: [{ id: "v1", chip: "nct6779", label: "+3.3V", volts: 3.32 }],
    },
    smart: {
      collectedAt: timestamp,
      devices: [
        {
          devicePath: "/dev/sda",
          type: "sat",
          byIds: ["ata-Samsung_SSD_870_EVO_500GB_S5Y12345"],
          wwn: "0x5002538f12345678",
          smartctl: {
            device: { name: "/dev/sda", type: "sat" },
            model_name: "Samsung SSD 870 EVO 500GB",
            serial_number: "S5Y12345",
            user_capacity: { bytes: 500107862016 },
            temperature: { current: 33 },
            power_on_time: { hours: 2500 },
            smart_status: { passed: true },
          },
        },
      ],
    },
  };
}

describe("Host snapshot integration in CollectorDeps", () => {
  it("supplies memory, load, network, power, sensors and smart from snapshot", async () => {
    await withTempDir(async (dir) => {
      const snapPath = join(dir, "host.json");
      const now = Date.now();
      writeFileSync(snapPath, JSON.stringify(getMockSnapshot(now)));

      const config = loadConfig({
        CHIRP_HOST_SNAPSHOT: snapPath,
        CHIRP_DATA_DIR: dir,
        CHIRP_SNAPSHOT_MAX_AGE_SEC: "999999999",
      });

      const deps = defaultDeps(config);

      // Sensors & CPU
      const sensors = deps.readSensors();
      expect(sensors.cpu.packageTemp).toBe(48.0);
      expect(sensors.cpu.source).toBe("k10temp");
      expect(deps.readCpuModel()).toBe("AMD EPYC 7002");

      // Host metrics
      const sample = deps.sampleHost!(1000);
      expect(sample.memory?.scope).toBe("host");
      expect(sample.memory?.totalBytes).toBe(32000000 * 1024);
      expect(sample.load?.scope).toBe("host");
      expect(sample.load?.load1).toBe(1.25);
      expect(sample.network?.scope).toBe("host");
      expect(sample.network?.interfaces[0].name).toBe("vmbr0");
      expect(sample.fans[0].rpm).toBe(1500);
      expect(sample.voltages[0].volts).toBe(3.32);

      // SMART discovery & read
      const discovered = await deps.discoverDevices();
      expect(discovered).toEqual([{ path: "/dev/sda", type: "sat" }]);

      const diskReading = await deps.readDisk(discovered[0]);
      expect(diskReading.disk.name).toBe("sda");
      expect(diskReading.disk.model).toBe("Samsung SSD 870 EVO 500GB");
      expect(diskReading.disk.temperature).toBe(33);
      expect(diskReading.disk.smartPassed).toBe(true);
      expect(diskReading.disk.lastReadAt).toBe(new Date(now).toISOString());
    });
  });

  it("throws SmartctlError when smartctl output in snapshot is empty or invalid", async () => {
    await withTempDir(async (dir) => {
      const snapPath = join(dir, "host-err.json");
      const now = Date.now();
      const errSnapshot = {
        ...getMockSnapshot(now),
        smart: {
          collectedAt: now,
          devices: [
            {
              devicePath: "/dev/sda",
              type: "sat",
              byIds: [],
              wwn: null,
              smartctl: {}, // empty output from failed collector run
            },
          ],
        },
      };
      writeFileSync(snapPath, JSON.stringify(errSnapshot));

      const config = loadConfig({
        CHIRP_HOST_SNAPSHOT: snapPath,
        CHIRP_DATA_DIR: dir,
        CHIRP_SNAPSHOT_MAX_AGE_SEC: "999999999",
      });

      const deps = defaultDeps(config);
      await expect(deps.readDisk({ path: "/dev/sda" })).rejects.toThrow("open_failed");
    });
  });

  it("respects CHIRP_DEVICES and CHIRP_DEVICE_TYPES even when snapshot has different devices", async () => {
    await withTempDir(async (dir) => {
      const snapPath = join(dir, "host.json");
      writeFileSync(snapPath, JSON.stringify(getMockSnapshot(Date.now())));

      const config = loadConfig({
        CHIRP_HOST_SNAPSHOT: snapPath,
        CHIRP_DATA_DIR: dir,
        CHIRP_DEVICES: "/dev/sdb,/dev/sda",
        CHIRP_DEVICE_TYPES: "/dev/sdb=megaraid,0",
      });

      const deps = defaultDeps(config);
      const devices = await deps.discoverDevices();
      expect(devices).toEqual([
        { path: "/dev/sdb", type: "megaraid,0" },
        { path: "/dev/sda", type: undefined },
      ]);
    });
  });

  it("computes network rate using snapshot timestamps and reuses sample when timestamp is unchanged", async () => {
    await withTempDir(async (dir) => {
      const snapPath = join(dir, "host.json");
      const t0 = Date.now();
      const baseSnap = getMockSnapshot(t0);
      writeFileSync(snapPath, JSON.stringify(baseSnap));

      const config = loadConfig({
        CHIRP_HOST_SNAPSHOT: snapPath,
        CHIRP_DATA_DIR: dir,
        CHIRP_SNAPSHOT_MAX_AGE_SEC: "999999999",
      });

      const deps = defaultDeps(config);

      // Sample 1 at snapshot timestamp t0
      const sample1 = deps.sampleHost!(1000);
      expect(sample1.network?.interfaces[0].rxBytesPerSec).toBeNull(); // First sample: no rate yet

      // Sample 2 while snapshot has NOT updated (same timestamp) -> returns previous sample, no rate drop to 0
      const sample2 = deps.sampleHost!(12000); // 11s later in server clock
      expect(sample2).toBe(sample1);

      // New snapshot arrives: 10s later in host timestamp (t0 + 10,000), rxBytes increased by 100,000
      const updatedSnapshot = {
        ...baseSnap,
        timestamp: t0 + 10000,
        net: {
          interfaces: [
            {
              ...baseSnap.net!.interfaces[0],
              rxBytes: 50100000, // +100,000 bytes over 10s = 10,000 B/s
            },
          ],
        },
      };
      writeFileSync(snapPath, JSON.stringify(updatedSnapshot));

      // Sample 3 on server: dt is based on snapshot timestamps (10s)
      const sample3 = deps.sampleHost!(14000);
      expect(sample3.network?.interfaces[0].rxBytesPerSec).toBe(10000);
    });
  });

  it("calculates RAPL power using snapshot timestamps and handles transitions between direct and snapshot modes", async () => {
    await withTempDir(async (dir) => {
      const snapPath = join(dir, "host.json");
      const t0 = 1700000000000;
      const baseSnap = getMockSnapshot(t0);
      writeFileSync(snapPath, JSON.stringify(baseSnap));

      const config = loadConfig({
        CHIRP_HOST_SNAPSHOT: snapPath,
        CHIRP_DATA_DIR: dir,
        CHIRP_SNAPSHOT_MAX_AGE_SEC: "999999999",
      });

      const deps = defaultDeps(config);

      // Sample 1: initial reading (no delta yet)
      const s1 = deps.sampleHost!(1000);
      expect(s1.power?.packageWatts).toBeNull();

      // Sample 2: 10 seconds later in snapshot epoch time (t0 + 10_000ms), energy +200,000,000 uJ = 200 J / 10s = 20 W
      const snap2 = {
        ...baseSnap,
        timestamp: t0 + 10000,
        hwmon: {
          ...baseSnap.hwmon!,
          rapl: [
            {
              zone: "intel-rapl:0",
              label: "package-0",
              isPackage: true,
              energyUj: 5000000 + 200000000,
              maxEnergyRangeUj: 1000000000,
            },
          ],
        },
      };
      writeFileSync(snapPath, JSON.stringify(snap2));

      // Server calls sampleHost at performance.now() = 11000
      const s2 = deps.sampleHost!(11000);
      expect(s2.power?.packageWatts).toBe(20);

      // When snapshot file is removed (fallback to direct read), clocks must not be mixed
      rmSync(snapPath);
      const s3 = deps.sampleHost!(15000);
      // Since mode transitioned from snapshot to direct, previous delta state was reset
      expect(s3.power).toBeNull();
    });
  });
});
