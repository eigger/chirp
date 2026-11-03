import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { Disk } from "@chirp/shared";
import { isSafeDevicePath, isSafeDeviceType, type Config, type TempWarn } from "./config.js";
import { computeHealth, DEFAULT_TEMP_WARN } from "./health.js";

type Json = Record<string, any>;

export interface DiskReading {
  disk: Disk;
  raw: unknown;
}

export interface ParseOptions {
  devicePath: string;
  now?: Date;
  tempWarn?: TempWarn;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function wwnHex(wwn: Json | undefined): string | null {
  if (!wwn || num(wwn.naa) === null || num(wwn.oui) === null || num(wwn.id) === null) return null;
  const hex =
    (wwn.naa as number).toString(16) +
    (wwn.oui as number).toString(16).padStart(6, "0") +
    (wwn.id as number).toString(16).padStart(9, "0");
  return hex === "0".repeat(16) ? null : hex;
}

export function diskId(json: Json, devicePath: string): string {
  const w = wwnHex(json.wwn);
  if (w) return `wwn_${w}`;
  const model = str(json.model_name);
  const serial = str(json.serial_number);
  if (model || serial) return slug(`${model ?? ""}_${serial ?? ""}`) || "disk";
  return `dev_${slug(basename(devicePath)) || "unknown"}`;
}

function ataAttr(table: Json[], id: number): Json | undefined {
  return table.find((a) => a.id === id);
}

function rawValue(attr: Json | undefined): number | null {
  return attr ? num(attr.raw?.value) : null;
}

/** Messages that mean "the disk is asleep and -n standby skipped it". */
function isStandby(json: Json): boolean {
  const exit = num(json.smartctl?.exit_status) ?? 0;
  if ((exit & 2) === 0) return false;
  const messages: Json[] = Array.isArray(json.smartctl?.messages) ? json.smartctl.messages : [];
  return messages.some((m) => /standby|sleep/i.test(String(m?.string ?? "")));
}

function baseDisk(devicePath: string, json: Json | null, now: Date): Disk {
  const j = json ?? {};
  const name = str(j.device?.name) ?? devicePath;
  return {
    id: json ? diskId(j, devicePath) : `dev_${slug(basename(devicePath)) || "unknown"}`,
    devicePath,
    name: basename(name),
    protocol: "ata",
    kind: "unknown",
    model: str(j.model_name),
    serial: str(j.serial_number),
    firmware: str(j.firmware_version),
    capacityBytes: num(j.user_capacity?.bytes),
    rotationRate: null,
    standby: false,
    temperature: null,
    powerOnHours: null,
    powerCycleCount: null,
    smartPassed: null,
    health: { status: "unknown", reasons: [{ code: "not_read" }] },
    ata: null,
    nvme: null,
    lastReadAt: now.toISOString(),
    error: null,
  };
}

/** A disk we could not read at all (no previous data to fall back to). */
export function unreadDisk(devicePath: string, error: Disk["error"], now = new Date()): Disk {
  const d = baseDisk(devicePath, null, now);
  d.lastReadAt = null;
  d.error = error;
  return d;
}

/**
 * Parse `smartctl -j -a -n standby` output. Throws on non-object input.
 * `standby: true` results carry no usable measurements.
 */
export function parseSmartctl(json: unknown, opts: ParseOptions): DiskReading {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("smartctl output is not an object");
  }
  const j = json as Json;
  const now = opts.now ?? new Date();
  const tempWarn = opts.tempWarn ?? DEFAULT_TEMP_WARN;
  const disk = baseDisk(opts.devicePath, j, now);

  if (isStandby(j)) {
    disk.standby = true;
    disk.lastReadAt = null;
    return { disk, raw: json };
  }

  const exit = num(j.smartctl?.exit_status) ?? 0;
  const protocolName = String(j.device?.protocol ?? "").toLowerCase();
  const hasNvme = typeof j.nvme_smart_health_information_log === "object" && j.nvme_smart_health_information_log;
  const table: Json[] = Array.isArray(j.ata_smart_attributes?.table) ? j.ata_smart_attributes.table : [];

  // Open failure: bit0 (usage) or bit1 (cannot open) with nothing identifying the device.
  if ((exit & 3) !== 0 && !disk.model && !hasNvme && table.length === 0) {
    const e = new Error("open_failed") as Error & { code?: string };
    e.code = "open_failed";
    throw e;
  }

  if (protocolName === "nvme" || hasNvme) disk.protocol = "nvme";
  else if (protocolName === "scsi") disk.protocol = "scsi";
  else disk.protocol = "ata";

  disk.smartPassed = typeof j.smart_status?.passed === "boolean" ? j.smart_status.passed : null;
  disk.powerOnHours = num(j.power_on_time?.hours);
  disk.powerCycleCount = num(j.power_cycle_count);
  disk.temperature = num(j.temperature?.current);

  if (disk.protocol === "nvme") {
    disk.kind = "nvme";
    const log: Json = j.nvme_smart_health_information_log ?? {};
    const units = num(log.data_units_written);
    disk.nvme = {
      percentageUsed: num(log.percentage_used),
      availableSpare: num(log.available_spare),
      availableSpareThreshold: num(log.available_spare_threshold),
      criticalWarning: num(log.critical_warning),
      mediaErrors: num(log.media_errors),
      unsafeShutdowns: num(log.unsafe_shutdowns),
      dataUnitsWritten: units,
      bytesWritten: units === null ? null : units * 512000,
    };
    disk.temperature ??= num(log.temperature);
    disk.powerOnHours ??= num(log.power_on_hours);
    disk.powerCycleCount ??= num(log.power_cycles);
    disk.capacityBytes ??= num(j.nvme_total_capacity);
  } else if (disk.protocol === "ata") {
    const rr = num(j.rotation_rate);
    disk.rotationRate = rr;
    disk.kind = rr === null ? "unknown" : rr > 0 ? "hdd" : "ssd";
    // Normalised "life left" attributes -> percent used (best effort, SSDs only).
    let wear: number | null = null;
    if (disk.kind !== "hdd") {
      for (const id of [177, 231, 233]) {
        const v = num(ataAttr(table, id)?.value);
        if (v !== null && v >= 0 && v <= 100) {
          wear = 100 - v;
          break;
        }
      }
    }
    disk.ata = {
      reallocatedSectors: rawValue(ataAttr(table, 5)),
      pendingSectors: rawValue(ataAttr(table, 197)),
      offlineUncorrectable: rawValue(ataAttr(table, 198)),
      udmaCrcErrors: rawValue(ataAttr(table, 199)),
      wearLevelPercentUsed: wear,
    };
    if (disk.temperature === null) {
      const t = rawValue(ataAttr(table, 194)) ?? rawValue(ataAttr(table, 190));
      disk.temperature = t === null ? null : t & 0xff;
    }
  } else {
    disk.kind = "unknown";
  }

  disk.health = computeHealth(disk, tempWarn);
  return { disk, raw: json };
}

export class SmartctlError extends Error {
  constructor(readonly code: NonNullable<Disk["error"]>) {
    super(code);
  }
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stdout: string; timedOut: boolean; spawnFailed: boolean }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
      const timedOut = !!e && e.killed === true;
      const spawnFailed = !!e && (e.code === "ENOENT" || e.code === "EACCES");
      resolve({ stdout: stdout ?? "", timedOut, spawnFailed });
    });
  });
}

export async function readDisk(
  config: Pick<Config, "smartctl" | "tempWarn" | "deviceTypes">,
  devicePath: string,
  type?: string,
  timeoutMs = 20_000,
): Promise<DiskReading> {
  const t = type ?? config.deviceTypes[devicePath];
  // Defence in depth: never hand smartctl something it could parse as an option.
  if (!isSafeDevicePath(devicePath) || (t !== undefined && !isSafeDeviceType(t))) {
    throw new SmartctlError("open_failed");
  }
  const args = ["-j", "-a", "-n", "standby", ...(t ? ["-d", t] : []), devicePath];
  // smartctl exits non-zero (a bit mask) for many benign reasons, so only stdout matters.
  const { stdout, timedOut, spawnFailed } = await run(config.smartctl, args, timeoutMs);
  if (timedOut) throw new SmartctlError("timeout");
  if (spawnFailed) throw new SmartctlError("open_failed");
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new SmartctlError("parse_error");
  }
  try {
    return parseSmartctl(json, { devicePath, tempWarn: config.tempWarn });
  } catch (err) {
    if ((err as { code?: string }).code === "open_failed") throw new SmartctlError("open_failed");
    throw new SmartctlError("parse_error");
  }
}

export interface DiscoveredDevice {
  path: string;
  type?: string;
}

export async function discoverDevices(
  config: Pick<Config, "smartctl" | "devices" | "deviceTypes">,
): Promise<DiscoveredDevice[]> {
  if (config.devices.length) {
    return config.devices.map((path) => ({ path, type: config.deviceTypes[path] }));
  }
  const { stdout } = await run(config.smartctl, ["--scan-open", "-j"], 20_000);
  try {
    const json = JSON.parse(stdout) as Json;
    const devices: Json[] = Array.isArray(json.devices) ? json.devices : [];
    return devices
      .filter((d) => typeof d.name === "string" && isSafeDevicePath(d.name))
      .map((d) => ({
        path: d.name as string,
        type:
          config.deviceTypes[d.name] ??
          (typeof d.type === "string" && isSafeDeviceType(d.type) ? d.type : undefined),
      }));
  } catch {
    return [];
  }
}
