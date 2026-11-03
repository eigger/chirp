import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiskIdentity } from "../src/diskIdentity.js";
import { Collector, type CollectorDeps } from "../src/scheduler.js";
import { SmartctlError, parseSmartctl, type DiscoveredDevice, type DiskReading } from "../src/smartctl.js";
import { StatusSnapshot } from "@chirp/shared";
import { fixture } from "./helpers.js";

const dev: DiscoveredDevice = { path: "/dev/sda" };
const read = (name: string): DiskReading => parseSmartctl(fixture(name), { devicePath: "/dev/sda" });

function make(
  responses: (() => DiskReading)[],
  extra: Partial<CollectorDeps> & { device?: DiscoveredDevice; rescanIntervalSec?: number } = {},
) {
  let i = 0;
  const { device = dev, rescanIntervalSec, ...overrides } = extra;
  const deps: CollectorDeps = {
    readSensors: () => ({
      cpu: { packageTemp: 47, maxTemp: 50, highTemp: 80, critTemp: 100, cores: [], source: "coretemp" },
      sensors: [],
    }),
    readCpuModel: () => "Fake CPU",
    discoverDevices: async () => [device],
    readDisk: async () => responses[Math.min(i++, responses.length - 1)](),
    now: () => new Date(),
    ...overrides,
  };
  return new Collector(deps, {
    rescanIntervalSec,
    instanceId: "8f0c2b7e-3a41-4d6e-9b1f-5c7d2e8a9f10",
    version: "0.1.0",
    displayName: "pve",
    sensorIntervalSec: 10,
    smartIntervalSec: 300,
  });
}

let c: Collector | undefined;
afterEach(() => c?.stop());

describe("Collector", () => {
  it("keeps the last values while the disk is in standby", async () => {
    c = make([() => read("sata-hdd-ok.json"), () => read("standby.json")]);
    await c.collectSmart();
    expect(c.getSnapshot().disks[0].standby).toBe(false);
    await c.collectSmart();
    const [d] = c.getSnapshot().disks;
    expect(d.standby).toBe(true);
    expect(d.temperature).toBe(34);
    expect(d.id).toBe("wwn_5000c500a1b2c3d4");
    expect(d.health.status).toBe("ok");
    expect(d.lastReadAt).not.toBeNull();
    // standby samples are not written to history
    expect(c.history.query("disk.wwn_5000c500a1b2c3d4.temperature")).toHaveLength(1);
  });

  it("read errors keep old data but mark the disk unknown", async () => {
    c = make([
      () => read("sata-hdd-ok.json"),
      () => {
        throw new SmartctlError("timeout");
      },
    ]);
    await c.collectSmart();
    await c.collectSmart();
    const [d] = c.getSnapshot().disks;
    expect(d.error).toBe("timeout");
    expect(d.health.status).toBe("unknown");
    expect(d.model).toBe("ST4000VN008-2DR166");
  });

  it("snapshot satisfies the shared schema and detail has raw", async () => {
    c = make([() => read("nvme-ok.json")]);
    c.collectSensors();
    await c.collectSmart();
    const snap = c.getSnapshot();
    expect(() => StatusSnapshot.parse(snap)).not.toThrow();
    expect(snap.cpu.model).toBe("Fake CPU");
    expect(c.getDiskDetail(snap.disks[0].id)?.raw).toBeTruthy();
    expect(c.history.query("cpu.packageTemp")).toHaveLength(1);
  });

  it("a disk that is asleep from the start gets its final ID without being woken", async () => {
    const root = mkdtempSync(join(tmpdir(), "chirp-sched-"));
    try {
      const byId = join(root, "by-id");
      mkdirSync(byId);
      const node = join(root, "sdb");
      writeFileSync(node, "");
      symlinkSync(node, join(byId, "ata-ST4000VN008-2DR166_ZDH1ABCD"));
      symlinkSync(node, join(byId, "wwn-0x5000c500a1b2c3d4"));
      const identity = new DiskIdentity({ byIdDir: byId, sysfsRoot: join(root, "sys"), cacheFile: join(root, "ids.json") });
      const path = join(byId, "ata-ST4000VN008-2DR166_ZDH1ABCD");
      const standby = () => parseSmartctl(fixture("standby.json"), { devicePath: path });
      const awake = () => parseSmartctl(fixture("sata-hdd-ok.json"), { devicePath: path });
      c = make([standby, awake, standby], { identity, device: { path } });

      await c.collectSmart();
      let [d] = c.getSnapshot().disks;
      expect(d.standby).toBe(true);
      expect(d.lastReadAt).toBeNull();
      expect(d.id).toBe("wwn_5000c500a1b2c3d4"); // not dev_<name>
      expect(() => StatusSnapshot.parse(c!.getSnapshot())).not.toThrow();

      await c.collectSmart(); // wakes up on its own: same ID, history under that ID
      await c.collectSmart();
      [d] = c.getSnapshot().disks;
      expect(d.id).toBe("wwn_5000c500a1b2c3d4");
      expect(c.history.query("disk.wwn_5000c500a1b2c3d4.temperature")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to a provisional dev_ ID only when nothing can be derived", async () => {
    c = make([
      () => {
        throw new SmartctlError("open_failed");
      },
      () => read("sata-hdd-ok.json"),
    ]);
    await c.collectSmart();
    expect(c.getSnapshot().disks[0]).toMatchObject({ id: "dev_sda", lastReadAt: null, error: "open_failed" });
    await c.collectSmart();
    expect(c.getSnapshot().disks[0].id).toBe("wwn_5000c500a1b2c3d4");
  });

  it("caches discovery: rescans only at start, after the rescan interval and on refresh()", async () => {
    let clock = 0;
    let scans = 0;
    c = make([() => read("sata-hdd-ok.json")], {
      discoverDevices: async () => {
        scans++;
        return [dev];
      },
      now: () => new Date(clock),
      rescanIntervalSec: 3600,
    });
    await c.collectSmart();
    clock += 300_000;
    await c.collectSmart();
    clock += 300_000;
    await c.collectSmart();
    expect(scans).toBe(1);
    clock += 3_600_000;
    await c.collectSmart();
    expect(scans).toBe(2);
    c.refresh();
    await c.collectSmart();
    expect(scans).toBe(3);
  });

  it("keeps the last device list when a rescan fails", async () => {
    let fail = false;
    c = make([() => read("sata-hdd-ok.json")], {
      discoverDevices: async () => {
        if (fail) throw new Error("scan failed");
        return [dev];
      },
    });
    await c.collectSmart();
    fail = true;
    c.refresh();
    await c.collectSmart();
    expect(c.getSnapshot().disks).toHaveLength(1);
  });
});
