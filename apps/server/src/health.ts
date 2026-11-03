import type { Disk } from "@chirp/shared";
import type { TempWarn } from "./config.js";

type DiskHealth = Disk["health"];
type HealthReason = DiskHealth["reasons"][number];

export const DEFAULT_TEMP_WARN: TempWarn = { hdd: 55, ssd: 70, nvme: 75 };

/**
 * NVMe SMART/Health log "Critical Warning" bits that mean failing:
 *  bit0 available spare below threshold, bit2 NVM subsystem reliability degraded,
 *  bit3 media placed in read-only mode, bit4 volatile memory backup device failed.
 * bit1 (temperature) is covered by temperature_high; bit5 (PMR read-only) is ignored.
 */
export const NVME_CRITICAL_FAILING_BITS = 0b11101;

/** percentage_used at or above this is a warning. */
export const WEAR_WARN_PERCENT = 90;

type HealthInput = Pick<Disk, "kind" | "temperature" | "smartPassed" | "ata" | "nvme" | "error">;

/**
 * The single place where disk health is decided.
 *  failing: SMART self-assessment failed, NVMe critical_warning bit0/2/3/4, spare below threshold
 *  warning: reallocated/pending/uncorrectable > 0, media errors > 0, wear >= 90 %, temperature >= limit
 *  unknown: the disk could not be read
 */
export function computeHealth(disk: HealthInput, tempWarn: TempWarn = DEFAULT_TEMP_WARN): DiskHealth {
  const hasData = disk.smartPassed !== null || disk.ata !== null || disk.nvme !== null;
  if (disk.error !== null || !hasData) {
    return { status: "unknown", reasons: [{ code: "not_read" }] };
  }

  const failing: HealthReason[] = [];
  const warning: HealthReason[] = [];

  if (disk.smartPassed === false) failing.push({ code: "smart_failed" });

  const nvme = disk.nvme;
  if (nvme) {
    const cw = nvme.criticalWarning;
    if (cw !== null && (cw & NVME_CRITICAL_FAILING_BITS) !== 0) failing.push({ code: "nvme_critical_warning", value: cw });
    if (
      nvme.availableSpare !== null &&
      nvme.availableSpareThreshold !== null &&
      nvme.availableSpare < nvme.availableSpareThreshold
    ) {
      failing.push({ code: "spare_below_threshold", value: nvme.availableSpare });
    }
    if (nvme.mediaErrors !== null && nvme.mediaErrors > 0) {
      warning.push({ code: "media_errors", value: nvme.mediaErrors });
    }
    if (nvme.percentageUsed !== null && nvme.percentageUsed >= WEAR_WARN_PERCENT) {
      warning.push({ code: "wear_high", value: nvme.percentageUsed });
    }
  }

  const ata = disk.ata;
  if (ata) {
    if (ata.reallocatedSectors !== null && ata.reallocatedSectors > 0) {
      warning.push({ code: "reallocated_sectors", value: ata.reallocatedSectors });
    }
    if (ata.pendingSectors !== null && ata.pendingSectors > 0) {
      warning.push({ code: "pending_sectors", value: ata.pendingSectors });
    }
    if (ata.offlineUncorrectable !== null && ata.offlineUncorrectable > 0) {
      warning.push({ code: "offline_uncorrectable", value: ata.offlineUncorrectable });
    }
    if (ata.wearLevelPercentUsed !== null && ata.wearLevelPercentUsed >= WEAR_WARN_PERCENT) {
      warning.push({ code: "wear_high", value: ata.wearLevelPercentUsed });
    }
  }

  if (disk.temperature !== null) {
    const limit =
      disk.kind === "hdd" ? tempWarn.hdd : disk.kind === "nvme" ? tempWarn.nvme : tempWarn.ssd;
    if (disk.temperature >= limit) warning.push({ code: "temperature_high", value: disk.temperature });
  }

  const reasons = [...failing, ...warning];
  const status = failing.length ? "failing" : warning.length ? "warning" : "ok";
  return { status, reasons };
}
