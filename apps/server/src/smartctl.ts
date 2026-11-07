import { execFile } from "node:child_process";
import { basename } from "node:path";
import type { Disk } from "@chirp/shared";
import { isSafeDevicePath, isSafeDeviceType, type Config, type TempWarn } from "./config.js";
import { provisionalId, slug } from "./diskIdentity.js";
import { computeHealth, DEFAULT_TEMP_WARN } from "./health.js";

export { slug };

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
  return provisionalId(devicePath);
}

function ataAttr(table: Json[], id: number): Json | undefined {
  return table.find((a) => a.id === id);
}

function rawValue(attr: Json | undefined): number | null {
  return attr ? num(attr.raw?.value) : null;
}

/** A plausible disk temperature in °C; drops smartctl's -128 "unknown" and other garbage. */
function tempValue(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > -60 && n < 150 ? n : null;
}

/** `ata_device_statistics` entry value for page/offset, only when smartctl marked it valid. */
function devstat(json: Json, page: number, offset: number): number | null {
  const pages: Json[] = Array.isArray(json.ata_device_statistics?.pages) ? json.ata_device_statistics.pages : [];
  const entries: unknown = pages.find((p) => p?.number === page)?.table;
  const entry = Array.isArray(entries) ? (entries as Json[]).find((e) => e?.offset === offset) : undefined;
  if (!entry || entry.flags?.valid === false) return null;
  return num(entry.value);
}

/**
 * Temperatures the disk records about itself. smartctl merges SCT Status
 * (`-l scttempsts`), Device Statistics page 5 and the NVMe warning threshold
 * into the top-level `temperature` object; `ata_sct_status` is a fallback.
 */
function temperatureStats(json: Json): Disk["temperatureStats"] {
  const top: Json = json.temperature ?? {};
  const sct: Json = json.ata_sct_status?.temperature ?? {};
  const pick = (key: string) => tempValue(top[key]) ?? tempValue(sct[key]);
  const stats = {
    powerCycleMin: pick("power_cycle_min"),
    powerCycleMax: pick("power_cycle_max"),
    lifetimeMin: pick("lifetime_min"),
    lifetimeMax: pick("lifetime_max"),
    operatingMax: pick("op_limit_max") ?? tempValue(json.nvme_composite_temperature_threshold?.warning),
  };
  return Object.values(stats).some((v) => v !== null) ? stats : null;
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
    id: json ? diskId(j, devicePath) : provisionalId(devicePath),
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
    temperatureStats: null,
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
 * Parse `smartctl -j -a -l devstat -l scttempsts -n standby` output. Throws on non-object input.
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
  disk.temperatureStats = temperatureStats(j);

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
    // Device Statistics "Percentage Used Endurance Indicator" first (page 7, offset 0x08),
    // else a normalised "life left" attribute -> percent used (best effort, SSDs only).
    let wear: number | null = null;
    // Not smartctl's `endurance_used`: without devstat it is guessed from drivedb attribute names.
    if (disk.kind !== "hdd") wear = devstat(j, 7, 0x08);
    if (disk.kind !== "hdd" && wear === null) {
      for (const id of [177, 231, 233]) {
        const v = num(ataAttr(table, id)?.value);
        if (v !== null && v >= 0 && v <= 100) {
          wear = 100 - v;
          break;
        }
      }
    }
    // Device Statistics page 1: Logical Sectors Written (0x18) / Read (0x28).
    const sectorSize = num(j.logical_block_size) ?? 512;
    const written = devstat(j, 1, 0x18);
    const read = devstat(j, 1, 0x28);
    disk.ata = {
      reallocatedSectors: rawValue(ataAttr(table, 5)),
      pendingSectors: rawValue(ataAttr(table, 197)),
      offlineUncorrectable: rawValue(ataAttr(table, 198)),
      udmaCrcErrors: rawValue(ataAttr(table, 199)),
      wearLevelPercentUsed: wear,
      bytesWritten: written === null ? null : written * sectorSize,
      bytesRead: read === null ? null : read * sectorSize,
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
  constructor(
    readonly code: NonNullable<Disk["error"]>,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** execFile's error code when stdout/stderr exceed maxBuffer (the child is killed too). */
const MAX_BUFFER_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
export const SMARTCTL_MAX_BUFFER = 16 * 1024 * 1024;

export interface RunResult {
  stdout: string;
  /** Killed because it ran past the timeout. */
  timedOut: boolean;
  /** Killed because its output exceeded maxBuffer (not a timeout). */
  overflow: boolean;
  spawnFailed: boolean;
}

/** Classify an execFile callback error. Exported for tests. */
export function classifyExecError(err: unknown): Omit<RunResult, "stdout"> {
  const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
  const overflow = !!e && e.code === MAX_BUFFER_CODE;
  return {
    overflow,
    // execFile sets killed=true for both timeout and maxBuffer kills; only the former is a timeout.
    timedOut: !!e && !overflow && e.killed === true,
    spawnFailed: !!e && (e.code === "ENOENT" || e.code === "EACCES"),
  };
}

function run(bin: string, args: string[], timeoutMs: number, maxBuffer = SMARTCTL_MAX_BUFFER): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer, encoding: "utf8" }, (err, stdout) => {
      resolve({ stdout: stdout ?? "", ...classifyExecError(err) });
    });
  });
}

/**
 * smartctl cannot auto-detect the device type of a bind-mounted by-id node inside an LXC
 * (there is no udev/sysfs symlink to follow) and fails with this message. Retrying with an
 * explicit type fixes it, e.g. `-d sat` for SATA disks.
 */
const NEEDS_DEVICE_TYPE = /Unable to detect device type|Please specify device type/i;
const FALLBACK_DEVICE_TYPES = ["sat", "scsi"] as const;

/** Types that worked after the fallback, remembered per device path for this process. */
const detectedTypes = new Map<string, string>();

/** For tests. */
export function resetDetectedDeviceTypes(): void {
  detectedTypes.clear();
}

export async function readDisk(
  config: Pick<Config, "smartctl" | "tempWarn" | "deviceTypes">,
  devicePath: string,
  type?: string,
  timeoutMs = 20_000,
  maxBuffer = SMARTCTL_MAX_BUFFER,
): Promise<DiskReading> {
  const explicit = type ?? config.deviceTypes[devicePath];
  const t = explicit ?? detectedTypes.get(devicePath);
  // Defence in depth: never hand smartctl something it could parse as an option.
  if (!isSafeDevicePath(devicePath) || (t !== undefined && !isSafeDeviceType(t))) {
    throw new SmartctlError("open_failed");
  }

  const attempt = async (deviceType: string | undefined): Promise<DiskReading> => {
    // -l devstat / -l scttempsts add Device Statistics and SCT temperatures. -n standby is
    // checked first, so they never wake a sleeping disk; non-ATA devices ignore them.
    const logs = ["-l", "devstat", "-l", "scttempsts"];
    const args = ["-j", "-a", ...logs, "-n", "standby", ...(deviceType ? ["-d", deviceType] : []), devicePath];
    // smartctl exits non-zero (a bit mask) for many benign reasons, so only stdout matters.
    const { stdout, timedOut, overflow, spawnFailed } = await run(config.smartctl, args, timeoutMs, maxBuffer);
    if (timedOut) throw new SmartctlError("timeout");
    // Truncated output is unusable JSON: report it as a parse error, with the real cause as detail.
    if (overflow) throw new SmartctlError("parse_error", `smartctl output exceeded ${maxBuffer} bytes`);
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
      if ((err as { code?: string }).code === "open_failed") {
        throw new SmartctlError("open_failed", NEEDS_DEVICE_TYPE.test(stdout) ? "needs_device_type" : undefined);
      }
      throw new SmartctlError("parse_error");
    }
  };

  try {
    return await attempt(t);
  } catch (err) {
    // Only when no type was given or learned, and only for the specific "cannot detect" failure:
    // an unplugged or broken disk must not cost two extra smartctl runs every cycle.
    if (t !== undefined || !(err instanceof SmartctlError) || err.detail !== "needs_device_type") throw err;
    for (const candidate of FALLBACK_DEVICE_TYPES) {
      try {
        const reading = await attempt(candidate);
        detectedTypes.set(devicePath, candidate);
        return reading;
      } catch (retryErr) {
        if (retryErr instanceof SmartctlError && retryErr.code === "timeout") throw retryErr;
      }
    }
    throw err;
  }
}

export interface DiscoveredDevice {
  path: string;
  type?: string;
}

export type ScanMode = "scan" | "scan-open";

/**
 * Parse `smartctl --scan[-open] -j`. Plain `--scan` only globs device names
 * and never opens them, but reports a generic `-d scsi` for every /dev/sdX;
 * passing that on would stop smartctl from auto-detecting SAT (ATA SMART
 * attributes), so generic types are dropped and smartctl auto-detects per read.
 */
export function parseScan(stdout: string, deviceTypes: Record<string, string>, mode: ScanMode): DiscoveredDevice[] {
  try {
    const json = JSON.parse(stdout) as Json;
    const devices: Json[] = Array.isArray(json.devices) ? json.devices : [];
    return devices
      .filter((d) => typeof d.name === "string" && isSafeDevicePath(d.name))
      .map((d) => {
        const scanned = typeof d.type === "string" && isSafeDeviceType(d.type) ? d.type : undefined;
        const keep = scanned !== undefined && !(mode === "scan" && (scanned === "scsi" || scanned === "ata"));
        return { path: d.name as string, type: deviceTypes[d.name] ?? (keep ? scanned : undefined) };
      });
  } catch {
    return [];
  }
}

/**
 * List devices: CHIRP_DEVICES verbatim, else a smartctl scan. Callers cache the
 * result (see `Collector`); scanning is not part of every SMART cycle.
 */
export async function discoverDevices(
  config: Pick<Config, "smartctl" | "devices" | "deviceTypes"> & { scanMode?: ScanMode },
): Promise<DiscoveredDevice[]> {
  if (config.devices.length) {
    return config.devices.map((path) => ({ path, type: config.deviceTypes[path] }));
  }
  const mode = config.scanMode ?? "scan";
  const { stdout } = await run(config.smartctl, [mode === "scan-open" ? "--scan-open" : "--scan", "-j"], 20_000);
  return parseScan(stdout, config.deviceTypes, mode);
}
