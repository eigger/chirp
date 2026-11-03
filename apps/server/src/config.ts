import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TempWarn {
  hdd: number;
  ssd: number;
  nvme: number;
}

export interface Config {
  port: number;
  host: string;
  apiKey: string | null;
  apiKeyFile: string;
  dataDir: string;
  devices: string[];
  deviceTypes: Record<string, string>;
  smartIntervalSec: number;
  sensorIntervalSec: number;
  smartctl: string;
  sysfsRoot: string;
  tempWarn: TempWarn;
  webDir: string;
  displayName: string;
  trustProxy: boolean;
  corsOrigins: string[];
  /** CHIRP_DEVICES / CHIRP_DEVICE_TYPES entries that were dropped as unsafe. */
  rejected: string[];
}

type Env = Record<string, string | undefined>;

function num(value: string | undefined, fallback: number, min = 0): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Values below end up as smartctl argv entries (execFile, no shell). They are
 * still validated so a device can never be parsed as an option ("-s on",
 * "--set=...", "-t long" ...) by smartctl itself.
 */
export function isSafeDevicePath(path: string): boolean {
  return /^\/[^\0\s]+$/.test(path);
}

export function isSafeDeviceType(type: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9,+_.:/-]*$/.test(type);
}

/**
 * Split CHIRP_DEVICE_TYPES on commas, but keep commas that belong to a type
 * ("/dev/sda=megaraid,0", "/dev/sdb=sat+megaraid,1", "/dev/sdc=areca,1/2"):
 * a new entry only starts at a token that looks like "/path=...".
 */
function deviceTypeEntries(value: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    if (/^\/[^=]*=/.test(token) || out.length === 0) out.push(token);
    else out[out.length - 1] += `,${token}`;
  }
  return out;
}

export function defaultWebDir(): string {
  // apps/server/{src,dist} -> apps/web/dist
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

export function loadConfig(env: Env = process.env): Config {
  const rejected: string[] = [];
  const deviceTypes: Record<string, string> = {};
  for (const entry of deviceTypeEntries(env.CHIRP_DEVICE_TYPES)) {
    const idx = entry.lastIndexOf("=");
    if (idx <= 0) {
      rejected.push(entry);
      continue;
    }
    const path = entry.slice(0, idx).trim();
    const type = entry.slice(idx + 1).trim();
    if (isSafeDevicePath(path) && isSafeDeviceType(type)) deviceTypes[path] = type;
    else rejected.push(entry);
  }
  const devices: string[] = [];
  for (const d of list(env.CHIRP_DEVICES)) {
    if (isSafeDevicePath(d)) devices.push(d);
    else rejected.push(d);
  }
  const dataDir = env.CHIRP_DATA_DIR?.trim() || "/var/lib/chirp";
  return {
    port: num(env.CHIRP_PORT, 80, 0),
    host: env.CHIRP_HOST?.trim() || "0.0.0.0",
    apiKey: env.CHIRP_API_KEY?.trim() || null,
    apiKeyFile: env.CHIRP_API_KEY_FILE?.trim() || resolve(dataDir, "api-key"),
    dataDir,
    devices,
    deviceTypes,
    smartIntervalSec: num(env.CHIRP_SMART_INTERVAL, 300, 1),
    sensorIntervalSec: num(env.CHIRP_SENSOR_INTERVAL, 10, 1),
    smartctl: env.CHIRP_SMARTCTL?.trim() || "smartctl",
    sysfsRoot: env.CHIRP_SYSFS_ROOT?.trim() || "/sys",
    tempWarn: {
      hdd: num(env.CHIRP_TEMP_WARN_HDD, 55),
      ssd: num(env.CHIRP_TEMP_WARN_SSD, 70),
      nvme: num(env.CHIRP_TEMP_WARN_NVME, 75),
    },
    webDir: env.CHIRP_WEB_DIR?.trim() ? resolve(env.CHIRP_WEB_DIR.trim()) : defaultWebDir(),
    displayName: env.CHIRP_DISPLAY_NAME?.trim() || hostname(),
    trustProxy: bool(env.CHIRP_TRUST_PROXY),
    corsOrigins: list(env.CHIRP_CORS_ORIGINS),
    rejected,
  };
}
