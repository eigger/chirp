import { hostname, release, uptime } from "node:os";
import { API_VERSION, type Disk, type StatusSnapshot } from "@chirp/shared";
import { join } from "node:path";
import type { Config } from "./config.js";
import { DiskIdentity, provisionalId } from "./diskIdentity.js";
import { History } from "./history.js";
import { detectContainer } from "./hostPaths.js";
import { HostMetrics, type HostSample } from "./hostMetrics.js";
import { HostSnapshotReader } from "./hostSnapshot.js";
import { readCpuModel, readSensors, type SensorReadout } from "./hwmon.js";
import { StorageCollector, type StorageSample } from "./storage.js";
import {
  discoverDevices,
  parseSmartctl,
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
  /** Stable IDs for disks that have not been read yet. Defaults to `DiskIdentity.none()`. */
  identity?: DiskIdentity;
  /**
   * Memory/load/network/power/fans/voltages, sampled on the sensor interval.
   * Without it the snapshot carries none of these (optional) sections.
   */
  sampleHost?: (monotonicMs: number) => HostSample;
  sampleStorage?: () => Promise<StorageSample>;
  /** Monotonic clock for host metric rates (default `performance.now()`); wall-clock steps must not distort rates. */
  monotonicMs?: () => number;
}

export interface CollectorOptions {
  instanceId: string;
  version: string;
  displayName: string;
  sensorIntervalSec: number;
  smartIntervalSec: number;
  /**
   * How often the device list is re-discovered (seconds). Discovery also runs
   * at start and on `refresh()`. With CHIRP_DEVICES set it is a no-op anyway.
   */
  rescanIntervalSec?: number;
  concurrency?: number;
}

function mergeById<T extends { id: string }>(primary: T[] | null, fallback: T[] | null): T[] | null {
  if (primary === null && fallback === null) return null;
  const map = new Map<string, T>();
  for (const item of fallback ?? []) {
    map.set(item.id, item);
  }
  for (const item of primary ?? []) {
    map.set(item.id, item);
  }
  return Array.from(map.values());
}

export function defaultDeps(config: Config, warn: (msg: string) => void = () => {}): CollectorDeps {
  const snapshotReader = config.hostSnapshot
    ? new HostSnapshotReader({
        path: config.hostSnapshot,
        maxAgeSec: config.snapshotMaxAgeSec,
        warn,
      })
    : undefined;

  const storage = new StorageCollector({
    paths: config.filesystemPaths,
    hostRoot: config.hostRoot,
    inContainer: detectContainer(),
    zfs: config.zfsEnabled,
  });
  const host = new HostMetrics({
    roots: { hostProc: config.hostProc, hostSys: config.hostSys, proc: "/proc", sys: "/sys", inContainer: detectContainer() },
    sysfsRoot: config.sysfsRoot,
    netFilter: { include: config.netInclude, exclude: config.netExclude },
    snapshotReader,
    warn,
  });
  return {
    sampleHost: (monotonicMs) => host.sample(monotonicMs),
    sampleStorage: async () => {
      const res = snapshotReader?.read();
      let snapStorage: StorageSample | null = null;
      if (res?.snapshot) {
        snapStorage = HostSnapshotReader.toStorage(res.snapshot.storage);
        // If snapshot is fresh and provides complete storage metrics, skip local collection
        if (snapStorage && snapStorage.filesystems !== null && snapStorage.zfsPools !== null) {
          return snapStorage;
        }
      } else if (res?.lastParsed?.storage) {
        // Snapshot is stale or failed read/parse: preserve host filesystem identities with scope: "host" and null values
        snapStorage = HostSnapshotReader.toStorage(res.lastParsed.storage, true);
      }

      const local = await storage.sample();
      if (!snapStorage) return local;

      return {
        filesystems: mergeById(snapStorage.filesystems, local.filesystems),
        zfsPools: mergeById(snapStorage.zfsPools, local.zfsPools),
      };
    },
    readSensors: () => {
      const snap = snapshotReader?.read().snapshot;
      const readout = snap ? HostSnapshotReader.toSensorReadout(snap.hwmon) : null;
      return readout ?? readSensors(config.sysfsRoot);
    },
    readCpuModel: () => {
      const snap = snapshotReader?.read().snapshot;
      return snap?.hwmon?.cpuModel ?? readCpuModel();
    },
    discoverDevices: async () => {
      if (config.devices.length > 0) {
        return config.devices.map((path) => ({
          path,
          type: config.deviceTypes[path],
        }));
      }
      const snap = snapshotReader?.read().snapshot;
      if (snap?.smart?.devices && snap.smart.devices.length > 0) {
        return snap.smart.devices.map((d) => ({
          path: d.devicePath,
          type: config.deviceTypes[d.devicePath] ?? d.type ?? undefined,
        }));
      }
      return discoverDevices(config);
    },
    readDisk: async (d) => {
      const snap = snapshotReader?.read().snapshot;
      if (snap?.smart?.devices) {
        const match = snap.smart.devices.find((x) => x.devicePath === d.path);
        if (match) {
          if (!match.smartctl || Object.keys(match.smartctl).length === 0) {
            throw new SmartctlError("open_failed", `host collector reported no smartctl output for ${d.path}`);
          }
          const collectedAt = snap.smart.collectedAt ? new Date(snap.smart.collectedAt) : undefined;
          return parseSmartctl(match.smartctl, {
            devicePath: d.path,
            tempWarn: config.tempWarn,
            now: collectedAt,
          });
        }
      }
      return readDisk(config, d.path, d.type);
    },
    now: () => new Date(),
    identity: new DiskIdentity({
      cacheFile: join(config.dataDir, "disk-ids.json"),
      sysfsRoot: config.sysfsRoot,
      warn,
    }),
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
  private host: HostSample | null = null;
  private storage: StorageSample | null = null;
  private storageRunning: Promise<void> | null = null;
  private storageAt: number | null = null;
  private timers: NodeJS.Timeout[] = [];
  private smartRunning: Promise<void> | null = null;
  private devices: DiscoveredDevice[] | null = null;
  private devicesAt = 0;
  private rescanRequested = true;
  private readonly identity: DiskIdentity;

  constructor(
    private readonly deps: CollectorDeps,
    private readonly opts: CollectorOptions,
  ) {
    this.cpuModel = deps.readCpuModel();
    this.identity = deps.identity ?? DiskIdentity.none();
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

  /** Re-read everything now, re-discovering devices first (does not wait). Concurrent runs are coalesced. */
  refresh(): void {
    this.rescanRequested = true;
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
    this.collectHost();
    void this.collectStorage();
  }

  /** At most once a minute, coalesced and independent of CPU/SMART collection. */
  async collectStorage(): Promise<void> {
    if (!this.deps.sampleStorage) return;
    if (this.storageRunning) return this.storageRunning;
    const now = (this.deps.monotonicMs ?? (() => performance.now()))();
    if (this.storageAt !== null && now >= this.storageAt && now - this.storageAt < 60_000) return;
    this.storageAt = now;
    this.storageRunning = Promise.resolve().then(() => this.deps.sampleStorage!()).then((next) => {
      this.storage = next;
    }).catch(() => { this.storage = { filesystems: null, zfsPools: null }; }).finally(() => { this.storageRunning = null; });
    return this.storageRunning;
  }

  /** Host metrics; isolated from the CPU sensors and SMART (HostMetrics already isolates each section). */
  private collectHost(): void {
    if (!this.deps.sampleHost) return;
    try {
      const at = this.deps.now().getTime();
      const next = this.deps.sampleHost((this.deps.monotonicMs ?? (() => performance.now()))());
      const ids = new Set(next.network?.interfaces.map((i) => i.id) ?? []);
      for (const old of this.host?.network?.interfaces ?? []) {
        if (!ids.has(old.id)) this.history.forget(`network.${old.id}.`);
      }
      this.host = next;
      this.history.record("memory.usedPercent", next.memory?.usedPercent ?? null, at);
      this.history.record("load.cpuUsagePercent", next.load?.cpuUsagePercent ?? null, at);
      this.history.record("load.load1", next.load?.load1 ?? null, at);
      this.history.record("power.packageWatts", next.power?.packageWatts ?? null, at);
      for (const i of next.network?.interfaces ?? []) {
        this.history.record(`network.${i.id}.rx`, i.rxBytesPerSec, at);
        this.history.record(`network.${i.id}.tx`, i.txBytesPerSec, at);
      }
    } catch {
      /* keep the previous host sample */
    }
  }

  /** Whether `network.<id>` is a currently listed interface. */
  hasInterface(id: string): boolean {
    return this.host?.network?.interfaces.some((i) => i.id === id) ?? false;
  }

  collectSmart(): Promise<void> {
    this.smartRunning ??= this.runSmart().finally(() => {
      this.smartRunning = null;
    });
    return this.smartRunning;
  }

  /**
   * The device list is cached: discovery (a smartctl scan when CHIRP_DEVICES
   * is empty) runs at start, on refresh() and every rescanIntervalSec — not on
   * every SMART cycle.
   */
  private async currentDevices(): Promise<DiscoveredDevice[] | null> {
    const now = this.deps.now().getTime();
    const maxAge = (this.opts.rescanIntervalSec ?? 3600) * 1000;
    if (this.devices && !this.rescanRequested && now - this.devicesAt < maxAge) return this.devices;
    try {
      this.devices = await this.deps.discoverDevices();
      this.devicesAt = now;
      this.rescanRequested = false;
    } catch {
      /* keep the previous list (if any) and retry next cycle */
    }
    return this.devices;
  }

  private async runSmart(): Promise<void> {
    const devices = await this.currentDevices();
    if (!devices) return;
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
      const next = await this.deps.readDisk(device);
      result = applyStandby(prev, next);
      if (!next.disk.standby) {
        // A real read: its ID is authoritative unless one was already pinned for this disk.
        result = { ...result, disk: { ...result.disk, id: this.identity.confirm(device.path, next.disk.id) } };
      }
    } catch (err) {
      const code = err instanceof SmartctlError ? err.code : "parse_error";
      result = unreadHealth(prev, device.path, code, now);
    }
    if ((result.disk.standby || result.disk.error !== null) && result.disk.lastReadAt === null) {
      // Never read yet (standby/unreadable since start): pinned or derived ID, never /dev/sdX.
      result = { ...result, disk: { ...result.disk, id: this.identity.known(device.path) ?? provisionalId(device.path) } };
    }
    if (prev && prev.disk.id !== result.disk.id) {
      // Only a provisional dev_ ID can be replaced; it never had history, but drop it to be safe.
      this.history.forget(`disk.${prev.disk.id}.`);
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
      ...(this.host ?? {}),
      ...(this.storage ?? {}),
    };
  }

  getDiskDetail(id: string): (Disk & { raw: unknown }) | null {
    for (const r of this.disks.values()) if (r.disk.id === id) return { ...r.disk, raw: r.raw };
    return null;
  }
}
