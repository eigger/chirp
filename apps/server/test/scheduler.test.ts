import { afterEach, describe, expect, it } from "vitest";
import { Collector, type CollectorDeps } from "../src/scheduler.js";
import { SmartctlError, parseSmartctl, type DiscoveredDevice, type DiskReading } from "../src/smartctl.js";
import { StatusSnapshot } from "@chirp/shared";
import { fixture } from "./helpers.js";

const dev: DiscoveredDevice = { path: "/dev/sda" };
const read = (name: string): DiskReading => parseSmartctl(fixture(name), { devicePath: "/dev/sda" });

function make(responses: (() => DiskReading)[]) {
  let i = 0;
  const deps: CollectorDeps = {
    readSensors: () => ({
      cpu: { packageTemp: 47, maxTemp: 50, highTemp: 80, critTemp: 100, cores: [], source: "coretemp" },
      sensors: [],
    }),
    readCpuModel: () => "Fake CPU",
    discoverDevices: async () => [dev],
    readDisk: async () => responses[Math.min(i++, responses.length - 1)](),
    now: () => new Date(),
  };
  return new Collector(deps, {
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
});
