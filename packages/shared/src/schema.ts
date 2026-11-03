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

export const StatusSnapshot = z.object({
  apiVersion: z.literal(API_VERSION),
  instance: Instance,
  cpu: Cpu,
  sensors: z.array(SensorReading),
  disks: z.array(Disk),
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

/** GET /api/v1/history?metric=...&range=24h */
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
