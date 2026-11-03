import { z } from "zod";

/**
 * chirp API contract (apiVersion 1).
 * Single source of truth shared by apps/server, apps/web and the Home Assistant
 * integration (hass-chirp / domain `chirp`). Adding fields is compatible;
 * removing or changing the meaning of a field requires bumping API_VERSION.
 */
export const API_VERSION = 1;

const temp = z.number().nullable();

export const HealthStatus = z.enum(["ok", "warning", "failing", "unknown"]);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const HealthReasonCode = z.enum([
  "smart_failed",
  "nvme_critical_warning",
  "spare_below_threshold",
  "reallocated_sectors",
  "pending_sectors",
  "offline_uncorrectable",
  "media_errors",
  "wear_high",
  "temperature_high",
  "not_read",
]);
export type HealthReasonCode = z.infer<typeof HealthReasonCode>;

export const HealthReason = z.object({
  code: HealthReasonCode,
  value: z.number().nullable().optional(),
});

export const DiskHealth = z.object({
  status: HealthStatus,
  reasons: z.array(HealthReason),
});

export const AtaInfo = z.object({
  reallocatedSectors: z.number().nullable(),
  pendingSectors: z.number().nullable(),
  offlineUncorrectable: z.number().nullable(),
  udmaCrcErrors: z.number().nullable(),
  wearLevelPercentUsed: z.number().nullable(),
});

export const NvmeInfo = z.object({
  percentageUsed: z.number().nullable(),
  availableSpare: z.number().nullable(),
  availableSpareThreshold: z.number().nullable(),
  criticalWarning: z.number().nullable(),
  mediaErrors: z.number().nullable(),
  unsafeShutdowns: z.number().nullable(),
  dataUnitsWritten: z.number().nullable(),
  bytesWritten: z.number().nullable(),
});

export const Disk = z.object({
  /**
   * Stable slug: `wwn_<hex>`, else a model+serial slug. Never `/dev/sdX`.
   * Once assigned it does not change (it is derived without waking the disk
   * and pinned on the server). The only exception is a provisional
   * `dev_<name>` ID with `lastReadAt === null`: a disk that has never been read
   * and whose identity could not be derived; it is replaced on the first read.
   * A `dev_` ID with a non-null `lastReadAt` is permanent (the disk reports no identity).
   */
  id: z.string().regex(/^[a-z0-9_]+$/),
  devicePath: z.string(),
  /** Display only; may change across reboots. */
  name: z.string(),
  protocol: z.enum(["ata", "nvme", "scsi"]),
  kind: z.enum(["hdd", "ssd", "nvme", "unknown"]),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  firmware: z.string().nullable(),
  capacityBytes: z.number().nullable(),
  rotationRate: z.number().nullable(),
  standby: z.boolean(),
  temperature: temp,
  powerOnHours: z.number().nullable(),
  powerCycleCount: z.number().nullable(),
  smartPassed: z.boolean().nullable(),
  health: DiskHealth,
  ata: AtaInfo.nullable(),
  nvme: NvmeInfo.nullable(),
  lastReadAt: z.string().nullable(),
  error: z.enum(["open_failed", "timeout", "parse_error"]).nullable(),
});
export type Disk = z.infer<typeof Disk>;

export const CpuCore = z.object({ label: z.string(), temp });

export const Cpu = z.object({
  model: z.string().nullable(),
  packageTemp: temp,
  maxTemp: temp,
  highTemp: temp,
  critTemp: temp,
  cores: z.array(CpuCore),
  source: z
    .enum(["coretemp", "k10temp", "zenpower", "cpu_thermal", "thermal_zone"])
    .nullable(),
  updatedAt: z.string().nullable(),
});
export type Cpu = z.infer<typeof Cpu>;

export const SensorReading = z.object({
  chip: z.string(),
  label: z.string(),
  temp,
});

export const Instance = z.object({
  /** UUIDv4, persisted. Source of Home Assistant unique IDs. */
  id: z.string(),
  hostname: z.string(),
  version: z.string(),
  kernel: z.string().nullable(),
  uptimeSeconds: z.number().nullable(),
  collectedAt: z.string(),
});

/**
 * Whose point of view a /proc-based section reflects.
 * - `host`: read from the host (a host mount such as `/host/proc`, or chirp is
 *   not running in a container).
 * - `container`: read from the container's own /proc or network namespace. In
 *   an LXC this may be the container's limits (lxcfs) and the container's own
 *   NICs, not the host's. Clients should label such values accordingly.
 */
export const MetricScope = z.enum(["host", "container"]);
export type MetricScope = z.infer<typeof MetricScope>;

const num = z.number().nullable();

/** /proc/meminfo. Byte values; percentages 0-100 with one decimal. */
export const Memory = z.object({
  scope: MetricScope,
  totalBytes: num,
  availableBytes: num,
  /** totalBytes - availableBytes. */
  usedBytes: num,
  usedPercent: num,
  swapTotalBytes: num,
  swapUsedBytes: num,
  /** null when there is no swap (swapTotalBytes is 0). */
  swapUsedPercent: num,
});
export type Memory = z.infer<typeof Memory>;

/** /proc/loadavg + /proc/stat. */
export const Load = z.object({
  scope: MetricScope,
  load1: num,
  load5: num,
  load15: num,
  /** Number of `cpuN` lines in /proc/stat (logical CPUs visible in this scope). */
  cpuCount: num,
  /** Busy share of all CPUs between the last two samples (0-100, one decimal); null until two samples exist. */
  cpuUsagePercent: num,
});
export type Load = z.infer<typeof Load>;

export const NetInterfaceKind = z.enum(["physical", "bridge", "bond", "vlan", "virtual"]);
export type NetInterfaceKind = z.infer<typeof NetInterfaceKind>;

export const NetInterface = z.object({
  /**
   * Stable slug of the interface name (`[a-z0-9_]+`, e.g. `vmbr0`, `bond0_100`
   * for `bond0.100`). Used in history metrics and Home Assistant unique IDs.
   */
  id: z.string().regex(/^[a-z0-9_]+$/),
  /** Kernel interface name (display). */
  name: z.string(),
  kind: NetInterfaceKind,
  /** operstate is `up`, or `unknown` with carrier 1 (drivers that do not report operstate). */
  up: z.boolean(),
  /** Raw operstate (`up`, `down`, `unknown`, `dormant`, ...); null if unreadable. */
  operState: z.string().nullable(),
  /** Link speed; null when unknown (virtual devices, link down). */
  speedMbps: num,
  /** Cumulative counters since the interface was created. */
  rxBytes: num,
  txBytes: num,
  /**
   * Rate between the last two samples; null on the first sample and after a
   * counter reset (a counter that went down, or the interface was re-created).
   */
  rxBytesPerSec: num,
  txBytesPerSec: num,
  rxErrors: num,
  txErrors: num,
  rxDropped: num,
  txDropped: num,
});
export type NetInterface = z.infer<typeof NetInterface>;

export const Network = z.object({
  scope: MetricScope,
  /** Filtered (see CHIRP_NET_INCLUDE / CHIRP_NET_EXCLUDE), sorted by name. */
  interfaces: z.array(NetInterface),
});
export type Network = z.infer<typeof Network>;

export const PowerSource = z.object({
  /** Stable slug: `rapl_<zone>` or `<chip>_<label>`. */
  id: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string(),
  /** null until two energy samples exist (RAPL) or when unreadable. */
  watts: num,
});
export type PowerSource = z.infer<typeof PowerSource>;

/**
 * Power from host sensors (sysfs: the same view inside and outside a
 * container, so there is no `scope`). The whole section is null when no
 * source is readable.
 */
export const Power = z.object({
  /**
   * CPU package power: the sum of the RAPL `package-N` zones, else the sum of
   * the CPU hwmon chip's power readings. null if neither is available (yet).
   */
  packageWatts: num,
  packageSource: z.enum(["rapl", "hwmon"]).nullable(),
  sources: z.array(PowerSource),
});
export type Power = z.infer<typeof Power>;

export const Fan = z.object({
  /** Stable slug of chip + label (`_2`, `_3` ... suffix on duplicates). */
  id: z.string().regex(/^[a-z0-9_]+$/),
  chip: z.string(),
  label: z.string(),
  rpm: num,
});
export type Fan = z.infer<typeof Fan>;

export const Voltage = z.object({
  /** Stable slug of chip + label (`_2`, `_3` ... suffix on duplicates). */
  id: z.string().regex(/^[a-z0-9_]+$/),
  chip: z.string(),
  /** The chip's label, or `inN` when it has none (exposed as is; may be cryptic). */
  label: z.string(),
  volts: num,
});
export type Voltage = z.infer<typeof Voltage>;

export const StatusSnapshot = z.object({
  apiVersion: z.literal(API_VERSION),
  instance: Instance,
  cpu: Cpu,
  sensors: z.array(SensorReading),
  disks: z.array(Disk),
  /*
   * Host metrics, added within apiVersion 1. Every field below is optional:
   * older servers do not send them. A section that could not be read at all
   * is `null` (not an object full of nulls); single unreadable values inside
   * a section are `null`.
   */
  memory: Memory.nullable().optional(),
  load: Load.nullable().optional(),
  network: Network.nullable().optional(),
  power: Power.nullable().optional(),
  /** hwmon fan*_input; empty when the host exposes none. */
  fans: z.array(Fan).optional(),
  /** hwmon in*_input (mV -> V); empty when the host exposes none. */
  voltages: z.array(Voltage).optional(),
});
export type StatusSnapshot = z.infer<typeof StatusSnapshot>;

/** GET /health (no auth). */
export const HealthResponse = z.object({
  status: z.literal("ok"),
  version: z.string(),
});

/** GET /api/v1/disks/:id — a Disk plus raw SMART data. */
export const DiskDetail = Disk.extend({
  raw: z.unknown(),
});

/**
 * GET /api/v1/history?metric=...&range=24h
 * Metrics: `cpu.packageTemp`, `disk.<id>.temperature`, `memory.usedPercent`,
 * `load.cpuUsagePercent`, `load.load1`, `power.packageWatts`,
 * `network.<interface id>.rx` / `.tx` (bytes/s).
 */
export const HistoryResponse = z.object({
  metric: z.string(),
  points: z.array(z.tuple([z.number(), z.number()])),
});

/** POST /api/v1/refresh -> 202 */
export const RefreshResponse = z.object({ queued: z.literal(true) });

/** Every error body is `{"error": <code>}` (429 adds `retryAfter`). */
export const ErrorCode = z.enum(["bad_request", "unauthorized", "not_found", "cooldown", "internal_error"]);
export type ErrorCode = z.infer<typeof ErrorCode>;
export const ErrorResponse = z.object({ error: ErrorCode });
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** 400: bad query parameters, malformed URL encoding, unparsable request body. */
export const BadRequestResponse = z.object({ error: z.literal("bad_request") });
/** 401: missing or wrong API key (`WWW-Authenticate: Bearer`). */
export const UnauthorizedResponse = z.object({ error: z.literal("unauthorized") });
/** 404: unknown disk id, unknown history metric, unknown /api or /health path. */
export const NotFoundResponse = z.object({ error: z.literal("not_found") });
/** 429: POST /refresh within the cooldown (`Retry-After` header carries the same seconds). */
export const CooldownResponse = z.object({
  error: z.literal("cooldown"),
  retryAfter: z.number(),
});
/** 5xx: unexpected server error (details are only logged). */
export const InternalErrorResponse = z.object({ error: z.literal("internal_error") });

export const API_KEY_PREFIX = "chp_";
