import { Disk } from "@chirp/shared";
import { describe, expect, it } from "vitest";
import { parseSmartctl, slug } from "../src/smartctl.js";
import { fixture, fixtureText } from "./helpers.js";

const parse = (name: string, devicePath = "/dev/sda") => parseSmartctl(fixture(name), { devicePath });

describe("parseSmartctl", () => {
  it("SATA HDD healthy", () => {
    const { disk } = parse("sata-hdd-ok.json");
    expect(() => Disk.parse(disk)).not.toThrow();
    expect(disk.id).toBe("wwn_5000c500a1b2c3d4");
    expect(disk.kind).toBe("hdd");
    expect(disk.protocol).toBe("ata");
    expect(disk.rotationRate).toBe(5980);
    expect(disk.temperature).toBe(34);
    expect(disk.powerOnHours).toBe(23456);
    expect(disk.capacityBytes).toBe(4000787030016);
    expect(disk.ata).toEqual({
      reallocatedSectors: 0,
      pendingSectors: 0,
      offlineUncorrectable: 0,
      udmaCrcErrors: 2,
      wearLevelPercentUsed: null,
      bytesWritten: null,
      bytesRead: null,
    });
    expect(disk.temperatureStats).toBeNull();
    expect(disk.health).toEqual({ status: "ok", reasons: [] });
    expect(disk.name).toBe("sda");
  });

  it("SSD: no wwn -> model+serial slug, wear from attribute 177", () => {
    const { disk } = parse("sata-ssd-ok.json", "/dev/sdb");
    expect(() => Disk.parse(disk)).not.toThrow();
    expect(disk.id).toBe("samsung_ssd_870_evo_1tb_fakessd0002");
    expect(disk.kind).toBe("ssd");
    expect(disk.ata?.wearLevelPercentUsed).toBe(3);
    expect(disk.temperature).toBe(30); // from attribute 190 raw
    expect(disk.health.status).toBe("ok");
  });

  it("SSD with Device Statistics + SCT Status: endurance, bytes, temperature stats", () => {
    const { disk } = parse("sata-ssd-devstat.json");
    expect(() => Disk.parse(disk)).not.toThrow();
    // Attribute 177 says 100 (0 % used); Device Statistics wins.
    expect(disk.ata?.wearLevelPercentUsed).toBe(4);
    expect(disk.ata?.bytesWritten).toBe(2919094965 * 512);
    expect(disk.ata?.bytesRead).toBe(3274298506 * 512);
    expect(disk.temperature).toBe(70);
    expect(disk.temperatureStats).toEqual({
      powerCycleMin: 70,
      powerCycleMax: 70,
      lifetimeMin: 23,
      lifetimeMax: 75,
      operatingMax: 100,
    });
  });

  it("temperature stats: SCT fallback, -128 dropped, NVMe warning threshold", () => {
    const ata = parseSmartctl(
      {
        ...fixture("sata-ssd-devstat.json"),
        temperature: { current: 40 },
        ata_sct_status: { temperature: { current: 40, lifetime_max: 61, lifetime_min: -128 } },
        ata_device_statistics: { pages: [{ number: 7, table: [{ offset: 8, flags: { valid: false } }] }] },
      },
      { devicePath: "/dev/sda" },
    ).disk;
    expect(ata.temperatureStats).toEqual({
      powerCycleMin: null,
      powerCycleMax: null,
      lifetimeMin: null,
      lifetimeMax: 61,
      operatingMax: null,
    });
    expect(ata.ata?.wearLevelPercentUsed).toBe(0); // invalid devstat entry -> attribute 177
    expect(ata.ata?.bytesWritten).toBeNull();

    const nvme = parseSmartctl(
      { ...fixture("nvme-ok.json"), nvme_composite_temperature_threshold: { warning: 84, critical: 85 } },
      { devicePath: "/dev/nvme0" },
    ).disk;
    expect(nvme.temperatureStats?.operatingMax).toBe(84);
  });

  it("NVMe healthy", () => {
    const { disk } = parse("nvme-ok.json", "/dev/nvme0");
    expect(() => Disk.parse(disk)).not.toThrow();
    expect(disk.protocol).toBe("nvme");
    expect(disk.kind).toBe("nvme");
    expect(disk.nvme?.bytesWritten).toBe(1234567 * 512000);
    expect(disk.nvme?.percentageUsed).toBe(3);
    expect(disk.temperature).toBe(41);
    expect(disk.health.status).toBe("ok");
  });

  it("NVMe critical_warning -> failing", () => {
    const { disk } = parse("nvme-critical.json", "/dev/nvme1");
    expect(disk.health.status).toBe("failing");
    const codes = disk.health.reasons.map((r) => r.code);
    expect(codes).toContain("smart_failed");
    expect(codes).toContain("nvme_critical_warning");
    expect(codes).toContain("media_errors");
  });

  it("reallocated sectors > 0 -> warning with value", () => {
    const { disk } = parse("sata-reallocated.json", "/dev/sdc");
    expect(disk.health.status).toBe("warning");
    expect(disk.health.reasons).toEqual([{ code: "reallocated_sectors", value: 8 }]);
  });

  it("smart_status.passed=false -> failing", () => {
    const { disk } = parse("sata-failing.json", "/dev/sdd");
    expect(disk.smartPassed).toBe(false);
    expect(disk.health.status).toBe("failing");
    expect(disk.health.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(["smart_failed", "reallocated_sectors", "pending_sectors", "offline_uncorrectable"]),
    );
  });

  it("standby is detected and carries no measurements", () => {
    const { disk } = parse("standby.json");
    expect(disk.standby).toBe(true);
    expect(disk.temperature).toBeNull();
    expect(disk.lastReadAt).toBeNull();
    expect(() => Disk.parse(disk)).not.toThrow();
  });

  it("open failure throws open_failed", () => {
    expect(() => parse("open-failed.json")).toThrowError("open_failed");
  });

  it("broken output is not valid JSON; non-objects are rejected", () => {
    expect(() => JSON.parse(fixtureText("broken.json"))).toThrow();
    expect(() => parseSmartctl(null, { devicePath: "/dev/sda" })).toThrow();
    expect(() => parseSmartctl([1], { devicePath: "/dev/sda" })).toThrow();
  });

  it("slug keeps [a-z0-9_] only", () => {
    expect(slug("WD Red / 4TB-X")).toBe("wd_red_4tb_x");
  });
});
