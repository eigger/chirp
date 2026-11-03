import type { Disk } from "@chirp/shared";
import { describe, expect, it } from "vitest";
import { computeHealth } from "../src/health.js";

const ata = (over: Partial<NonNullable<Disk["ata"]>> = {}) => ({
  reallocatedSectors: 0,
  pendingSectors: 0,
  offlineUncorrectable: 0,
  udmaCrcErrors: 0,
  wearLevelPercentUsed: null,
  ...over,
});
const nvme = (over: Partial<NonNullable<Disk["nvme"]>> = {}) => ({
  percentageUsed: 0,
  availableSpare: 100,
  availableSpareThreshold: 10,
  criticalWarning: 0,
  mediaErrors: 0,
  unsafeShutdowns: 0,
  dataUnitsWritten: 0,
  bytesWritten: 0,
  ...over,
});
const hdd = (over: Partial<Parameters<typeof computeHealth>[0]> = {}) => ({
  kind: "hdd" as const,
  temperature: 30,
  smartPassed: true,
  ata: ata(),
  nvme: null,
  error: null,
  ...over,
});
const nv = (over: Partial<Parameters<typeof computeHealth>[0]> = {}) => ({
  kind: "nvme" as const,
  temperature: 30,
  smartPassed: true,
  ata: null,
  nvme: nvme(),
  error: null,
  ...over,
});

describe("computeHealth boundaries", () => {
  it("ok baseline", () => {
    expect(computeHealth(hdd())).toEqual({ status: "ok", reasons: [] });
  });

  it("HDD temperature: 54 ok, 55 warning", () => {
    expect(computeHealth(hdd({ temperature: 54 })).status).toBe("ok");
    expect(computeHealth(hdd({ temperature: 55 })).reasons).toEqual([{ code: "temperature_high", value: 55 }]);
  });

  it("SSD 70 / NVMe 75 thresholds", () => {
    expect(computeHealth(hdd({ kind: "ssd", temperature: 69 })).status).toBe("ok");
    expect(computeHealth(hdd({ kind: "ssd", temperature: 70 })).status).toBe("warning");
    expect(computeHealth(nv({ temperature: 74 })).status).toBe("ok");
    expect(computeHealth(nv({ temperature: 75 })).status).toBe("warning");
  });

  it("custom thresholds", () => {
    expect(computeHealth(hdd({ temperature: 50 }), { hdd: 50, ssd: 70, nvme: 75 }).status).toBe("warning");
  });

  it("reallocated 0 ok / 1 warning", () => {
    expect(computeHealth(hdd({ ata: ata({ reallocatedSectors: 0 }) })).status).toBe("ok");
    expect(computeHealth(hdd({ ata: ata({ reallocatedSectors: 1 }) })).status).toBe("warning");
    expect(computeHealth(hdd({ ata: ata({ pendingSectors: 1 }) })).reasons[0].code).toBe("pending_sectors");
    expect(computeHealth(hdd({ ata: ata({ offlineUncorrectable: 1 }) })).reasons[0].code).toBe("offline_uncorrectable");
  });

  it("NVMe percentage_used: 89 ok, 90 warning", () => {
    expect(computeHealth(nv({ nvme: nvme({ percentageUsed: 89 }) })).status).toBe("ok");
    expect(computeHealth(nv({ nvme: nvme({ percentageUsed: 90 }) })).reasons).toEqual([{ code: "wear_high", value: 90 }]);
  });

  it("NVMe media_errors > 0 warning", () => {
    expect(computeHealth(nv({ nvme: nvme({ mediaErrors: 1 }) })).status).toBe("warning");
  });

  it("NVMe critical_warning bits: 0,2,3 fail; 1 and 4 do not", () => {
    for (const cw of [1, 4, 8]) {
      expect(computeHealth(nv({ nvme: nvme({ criticalWarning: cw }) })).status).toBe("failing");
    }
    for (const cw of [2, 16]) {
      expect(computeHealth(nv({ nvme: nvme({ criticalWarning: cw }) })).status).toBe("ok");
    }
  });

  it("available_spare below threshold fails, equal does not", () => {
    expect(computeHealth(nv({ nvme: nvme({ availableSpare: 10 }) })).status).toBe("ok");
    expect(computeHealth(nv({ nvme: nvme({ availableSpare: 9 }) })).reasons).toEqual([
      { code: "spare_below_threshold", value: 9 },
    ]);
  });

  it("failing outranks warning, reasons keep both", () => {
    const h = computeHealth(hdd({ smartPassed: false, temperature: 60 }));
    expect(h.status).toBe("failing");
    expect(h.reasons.map((r) => r.code)).toEqual(["smart_failed", "temperature_high"]);
  });

  it("unknown when not read", () => {
    expect(computeHealth(hdd({ error: "timeout" }))).toEqual({ status: "unknown", reasons: [{ code: "not_read" }] });
    expect(computeHealth(hdd({ smartPassed: null, ata: null })).status).toBe("unknown");
  });
});
