import { hostname, release, uptime } from "node:os";
import { API_VERSION, type Disk, type StatusSnapshot } from "@chirp/shared";
import type { Config } from "./config.js";
import { History } from "./history.js";
import { readCpuModel, readSensors, type SensorReadout } from "./hwmon.js";
import {
  discoverDevices,
  readDisk,
  SmartctlError,
  unreadDisk,
  type DiscoveredDevice,
  type DiskReading,
} from "./smartctl.js";

export interface CollectorDeps {
  readSensors: () => SensorReadout;
  readCpuModel: () => string | null;
  discoverDevices: () => Promise<DiscoveredDevice[]>;
  readDisk: (device: DiscoveredDevice) => Promise<DiskReading>;
  now: () => Date;
}

export interface CollectorOptions {
  instanceId: string;
  version: string;
  displayName: string;
  sensorIntervalSec: number;
  smartIntervalSec: number;
  concurrency?: number;
}

export function defaultDeps(config: Config): CollectorDeps {
  return {
    readSensors: () => readSensors(config.sysfsRoot),
    readCpuModel: () => readCpuModel(),
    discoverDevices: () => discoverDevices(config),
    readDisk: (d) => readDisk(config, d.path, d.type),
    now: () => new Date(),
  };
}

/**
 * Merge a fresh read with the previous one. A disk in standby keeps its last
 * known values (we never wake it up); only `standby` flips to true.
 */
export function applyStandby(prev: DiskReading | undefined, next: DiskReading): DiskReading {
  if (!next.disk.standby) return next;
  if (!prev) return next;
  return { disk: { ...prev.disk, standby: true }, raw: prev.raw };
}

function unreadHealth(prev: DiskReading | undefined, path: string, error: NonNullable<Disk["error"]>, now: Date): DiskReading {
  if (!prev) return { disk: unreadDisk(path, error, now), raw: null };
  return {
    disk: { ...prev.disk, error, health: { status: "unknown", reasons: [{ code: "not_read" }] } },
    raw: prev.raw,
  };
}

export class Collector {
  readonly history = new History();
  private disks = new Map<string, DiskReading>();
  private cpuModel: string | null = null;
  private sensors: SensorReadout = {
    cpu: { packageTemp: null, maxTemp: null, highTemp: null, critTemp: null, cores: [], source: null },
    sensors: [],
  };
  private sensorsAt: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private smartRunning: Promise<void> | null = null;

  constructor(
    private readonly deps: CollectorDeps,
    private readonly opts: CollectorOptions,
  ) {
    this.cpuModel = deps.readCpuModel();
  }

  start(): void {
    this.collectSensors();
    void this.collectSmart();
    this.timers.push(setInterval(() => this.collectSensors(), this.opts.sensorIntervalSec * 1000));
    this.timers.push(setInterval(() => void this.collectSmart(), this.opts.smartIntervalSec * 1000));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Re-read everything now (does not wait). Concurrent runs are coalesced. */
  refresh(): void {
    this.collectSensors();
    void this.collectSmart();
  }

  collectSensors(): void {
    try {
      this.sensors = this.deps.readSensors();
      const now = this.deps.now();
      this.sensorsAt = now.toISOString();
      this.history.record("cpu.packageTemp", this.sensors.cpu.packageTemp, now.getTime());
    } catch {
      /* keep the previous readings */
    }
  }

  collectSmart(): Promise<void> {
    this.smartRunning ??= this.runSmart().finally(() => {
      this.smartRunning = null;
    });
    return this.smartRunning;
  }

  private async runSmart(): Promise<void> {
    let devices: DiscoveredDevice[] = [];
    try {
      devices = await this.deps.discoverDevices();
    } catch {
      return;
    }
    const seen = new Set(devices.map((d) => d.path));
    for (const [path, reading] of this.disks) {
      if (!seen.has(path)) {
        this.disks.delete(path);
        this.history.forget(`disk.${reading.disk.id}.`);
      }
    }

    const queue = [...devices];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        await this.readOne(d);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.opts.concurrency ?? 2) }, worker));
  }

  private async readOne(device: DiscoveredDevice): Promise<void> {
    const prev = this.disks.get(device.path);
    const now = this.deps.now();
    let result: DiskReading;
    try {
      result = applyStandby(prev, await this.deps.readDisk(device));
    } catch (err) {
      const code = err instanceof SmartctlError ? err.code : "parse_error";
      result = unreadHealth(prev, device.path, code, now);
    }
    this.disks.set(device.path, result);
    const d = result.disk;
    if (!d.standby && d.error === null) {
      this.history.record(`disk.${d.id}.temperature`, d.temperature, now.getTime());
    }
  }

  getSnapshot(): StatusSnapshot {
    const now = this.deps.now();
    return {
      apiVersion: API_VERSION,
      instance: {
        id: this.opts.instanceId,
        hostname: this.opts.displayName || hostname(),
        version: this.opts.version,
        kernel: release() || null,
        uptimeSeconds: Math.floor(uptime()),
        collectedAt: now.toISOString(),
      },
      cpu: { model: this.cpuModel, ...this.sensors.cpu, updatedAt: this.sensorsAt },
      sensors: this.sensors.sensors,
      disks: [...this.disks.values()].map((r) => r.disk).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  getDiskDetail(id: string): (Disk & { raw: unknown }) | null {
    for (const r of this.disks.values()) if (r.disk.id === id) return { ...r.disk, raw: r.raw };
    return null;
  }
}
