import { statSync, readFileSync, existsSync } from "node:fs";
import { HostSnapshot, type HostSnapshotNetInterface, type HostSnapshotSmartDevice } from "@chirp/shared";
import type { RawInterface } from "./netdev.js";
import type { SensorReadout } from "./hwmon.js";
import type { HwmonExtras, RaplZone } from "./power.js";

/** Max snapshot file size accepted (10 MB). Prevents memory exhaustion attacks. */
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_AGE_SEC = 60;

export interface SnapshotReaderOptions {
  path: string | null;
  maxAgeSec?: number;
  maxBytes?: number;
  warn?: (msg: string) => void;
  now?: () => number;
}

export interface ReadSnapshotResult {
  snapshot: HostSnapshot | null;
  stale: boolean;
  error: string | null;
}

export class HostSnapshotReader {
  private readonly path: string | null;
  private readonly maxAgeSec: number;
  private readonly maxBytes: number;
  private readonly warn: (msg: string) => void;
  private readonly now: () => number;

  private lastMtimeMs = 0;
  private lastResult: ReadSnapshotResult = { snapshot: null, stale: false, error: null };
  private warnedStale = false;
  private warnedError: string | null = null;

  constructor(opts: SnapshotReaderOptions) {
    this.path = opts.path;
    this.maxAgeSec = opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
    this.maxBytes = opts.maxBytes ?? MAX_SNAPSHOT_BYTES;
    this.warn = opts.warn ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Reads and validates the host snapshot.
   * Returns null if no snapshot path is configured or the file does not exist.
   * If the file is invalid or oversized, reports the error and returns null snapshot.
   */
  read(): ReadSnapshotResult {
    if (!this.path) {
      return { snapshot: null, stale: false, error: null };
    }

    if (!existsSync(this.path)) {
      return { snapshot: null, stale: false, error: null };
    }

    try {
      const stat = statSync(this.path);
      if (stat.size > this.maxBytes) {
        const err = `snapshot file exceeds maximum size (${stat.size} > ${this.maxBytes} bytes)`;
        this.logError(err);
        return { snapshot: null, stale: false, error: err };
      }

      // Fast-path: mtime has not changed since last successful parse
      if (this.lastResult.snapshot && stat.mtimeMs === this.lastMtimeMs) {
        const ageSec = Math.floor((this.now() - this.lastResult.snapshot.timestamp) / 1000);
        const stale = ageSec > this.maxAgeSec;
        this.checkStale(stale, ageSec);
        return { ...this.lastResult, stale };
      }

      const text = readFileSync(this.path, "utf8");
      const raw = JSON.parse(text);
      const parsed = HostSnapshot.safeParse(raw);
      if (!parsed.success) {
        const err = `snapshot schema validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`;
        this.logError(err);
        return { snapshot: null, stale: false, error: err };
      }

      const snapshot = parsed.data;
      const ageSec = Math.floor((this.now() - snapshot.timestamp) / 1000);
      const stale = ageSec > this.maxAgeSec;
      this.checkStale(stale, ageSec);

      this.lastMtimeMs = stat.mtimeMs;
      this.lastResult = { snapshot, stale, error: null };
      if (this.warnedError) {
        this.warn(`host snapshot recovered: parsed valid snapshot (${this.path})`);
        this.warnedError = null;
      }
      return this.lastResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logError(`failed to read snapshot: ${msg}`);
      return { snapshot: null, stale: false, error: msg };
    }
  }

  private checkStale(stale: boolean, ageSec: number) {
    if (stale && !this.warnedStale) {
      this.warn(`host snapshot is stale (${ageSec}s old > ${this.maxAgeSec}s limit)`);
      this.warnedStale = true;
    } else if (!stale && this.warnedStale) {
      this.warn(`host snapshot is no longer stale (${ageSec}s old)`);
      this.warnedStale = false;
    }
  }

  private logError(msg: string) {
    if (this.warnedError !== msg) {
      this.warnedError = msg;
      this.warn(msg);
    }
  }

  /** Convert snapshot network interfaces into RawInterface[] */
  static toRawInterfaces(interfaces: HostSnapshotNetInterface[] | undefined): RawInterface[] {
    if (!interfaces) return [];
    return interfaces.map((i) => ({
      name: i.name,
      kind: i.kind,
      operState: i.operState,
      up: i.up,
      ifindex: i.ifindex,
      speedMbps: i.speedMbps,
      rxBytes: i.rxBytes,
      txBytes: i.txBytes,
      rxErrors: i.rxErrors,
      txErrors: i.txErrors,
      rxDropped: i.rxDropped,
      txDropped: i.txDropped,
    }));
  }

  /** Convert snapshot hwmon section into SensorReadout */
  static toSensorReadout(hwmon: HostSnapshot["hwmon"]): SensorReadout | null {
    if (!hwmon?.cpu) return null;
    return {
      cpu: {
        packageTemp: hwmon.cpu.packageTemp,
        maxTemp: hwmon.cpu.maxTemp,
        highTemp: hwmon.cpu.highTemp,
        critTemp: hwmon.cpu.critTemp,
        cores: hwmon.cpu.cores,
        source: hwmon.cpu.source,
      },
      sensors: (hwmon.sensors ?? []).map((s) => ({
        chip: s.chip,
        label: s.label,
        temp: s.temp,
      })),
    };
  }

  /** Convert snapshot hwmon power/fan/voltage section into HwmonExtras */
  static toHwmonExtras(hwmon: HostSnapshot["hwmon"]): HwmonExtras {
    if (!hwmon) return { power: [], fans: [], voltages: [] };
    return {
      power: (hwmon.power ?? []).map((p) => ({
        id: p.id,
        chip: p.chip,
        label: p.label,
        watts: p.watts,
      })),
      fans: (hwmon.fans ?? []).map((f) => ({
        id: f.id,
        chip: f.chip,
        label: f.label,
        rpm: f.rpm,
      })),
      voltages: (hwmon.voltages ?? []).map((v) => ({
        id: v.id,
        chip: v.chip,
        label: v.label,
        volts: v.volts,
      })),
    };
  }

  /** Convert snapshot rapl section into RaplZone[] */
  static toRaplZones(hwmon: HostSnapshot["hwmon"]): RaplZone[] {
    if (!hwmon?.rapl) return [];
    return hwmon.rapl.map((r) => ({
      zone: r.zone,
      label: r.label,
      isPackage: r.isPackage,
      energyUj: r.energyUj,
      maxEnergyRangeUj: r.maxEnergyRangeUj,
    }));
  }

  /** Map smart devices by devicePath */
  static toSmartDeviceMap(devices: HostSnapshotSmartDevice[] | undefined): Map<string, HostSnapshotSmartDevice> {
    const map = new Map<string, HostSnapshotSmartDevice>();
    if (!devices) return map;
    for (const d of devices) {
      map.set(d.devicePath, d);
    }
    return map;
  }
}
