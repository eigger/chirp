import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHostRoot } from "./hostPaths.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, Username } from "@chirp/shared";
import { isCommonPassword } from "./commonPassword.js";
import { DEFAULT_DAILY_BUDGET } from "./rateLimit.js";

export interface TempWarn {
  hdd: number;
  ssd: number;
  nvme: number;
}

export interface Config {
  port: number;
  /** Print a newly generated API key to the log (CHIRP_PRINT_KEY, opt-in). */
  printKey: boolean;
  host: string;
  /** API key set by the operator (CHIRP_API_KEY); wins over the key file and cannot be regenerated. */
  apiKey: string | null;
  /** Key file (default <dataDir>/api-key); created on the first start when CHIRP_API_KEY is unset. */
  apiKeyFile: string;
  /** Admin account seeded on start when none exists (CHIRP_ADMIN_USER + CHIRP_ADMIN_PASSWORD). */
  adminUser: string | null;
  adminPassword: string | null;
  /** One-time setup token for first-run registration (CHIRP_SETUP_TOKEN). */
  setupToken: string | null;
  /** Path to chirp.env (CHIRP_ENV_FILE), if known. */
  envFile: string | null;
  /** TLS certificate and key paths (CHIRP_TLS_CERT, CHIRP_TLS_KEY). */
  tlsCert: string | null;
  tlsKey: string | null;
  /** Session cookie `Secure` flag: auto = when the request arrived over HTTPS (honours CHIRP_TRUST_PROXY). */
  cookieSecure: "auto" | boolean;
  dataDir: string;
  devices: string[];
  deviceTypes: Record<string, string>;
  smartIntervalSec: number;
  sensorIntervalSec: number;
  /** Device discovery when CHIRP_DEVICES is empty: `--scan` (never opens devices) or `--scan-open`. */
  scanMode: "scan" | "scan-open";
  /** Re-discover devices this often (seconds); also at start and on POST /refresh. */
  rescanIntervalSec: number;
  smartctl: string;
  sysfsRoot: string;
  /** Host /proc for memory/load (CHIRP_HOST_PROC; default /host/proc if it exists, else /proc). */
  hostProc: string;
  /** Host /sys for network interfaces (CHIRP_HOST_SYS; default /host/sys if it exists, else /sys). */
  hostSys: string;
  /** Host snapshot path for unprivileged containers (CHIRP_HOST_SNAPSHOT; default /run/chirp/host.json if present). */
  hostSnapshot: string | null;
  /** Max acceptable age of a host snapshot before it is flagged stale (CHIRP_SNAPSHOT_MAX_AGE_SEC, default 60). */
  snapshotMaxAgeSec: number;
  /** Network interface globs always shown (CHIRP_NET_INCLUDE). */
  netInclude: string[];
  /** Network interface globs always hidden, on top of the defaults (CHIRP_NET_EXCLUDE). */
  netExclude: string[];
  tempWarn: TempWarn;
  webDir: string;
  displayName: string;
  /**
   * Fastify `trustProxy`: false (default), true (trust every X-Forwarded-For
   * hop: only safe when the proxy overwrites the header), a hop count, or a
   * list of proxy addresses/CIDRs.
   */
  trustProxy: boolean | number | string[];
  /** Failed logins per username per rolling 24 h before only known sources may try (CHIRP_LOGIN_DAILY_BUDGET). */
  loginDailyBudget: number;
  corsOrigins: string[];
  /** CHIRP_DEVICES / CHIRP_DEVICE_TYPES entries that were dropped as unsafe. */
  rejected: string[];
}

type Env = Record<string, string | undefined>;

/** Minimum length of a CHIRP_API_KEY supplied by the operator. */
export const MIN_API_KEY_LENGTH = 16;

/** Invalid configuration: the server refuses to start with a clear message. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function port(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 80;
  const v = value.trim();
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`CHIRP_PORT must be an integer between 1 and 65535 (got "${value}")`);
  }
  return n;
}

function apiKey(value: string | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (/\s/.test(v)) throw new ConfigError("CHIRP_API_KEY must not contain whitespace");
  if (v.length < MIN_API_KEY_LENGTH) {
    throw new ConfigError(
      `CHIRP_API_KEY is too short (${v.length} characters, minimum ${MIN_API_KEY_LENGTH}); ` +
        "unset it to use a generated key, or generate one with: node apps/server/dist/cli.js key rotate",
    );
  }
  return v;
}

function adminSeed(env: Env): { adminUser: string | null; adminPassword: string | null } {
  const user = env.CHIRP_ADMIN_USER?.trim() || null;
  // Passwords are taken verbatim (no trim): spaces may be intended.
  const password = env.CHIRP_ADMIN_PASSWORD ? env.CHIRP_ADMIN_PASSWORD : null;
  if (!user && !password) return { adminUser: null, adminPassword: null };
  if (!user || !password) {
    throw new ConfigError("CHIRP_ADMIN_USER and CHIRP_ADMIN_PASSWORD must be set together");
  }
  if (!Username.safeParse(user).success) {
    throw new ConfigError("CHIRP_ADMIN_USER must be 1-64 letters, digits, '.', '_', '@' or '-'");
  }
  const len = [...password].length;
  if (len < MIN_PASSWORD_LENGTH || len > MAX_PASSWORD_LENGTH) {
    throw new ConfigError(
      `CHIRP_ADMIN_PASSWORD must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters (got ${len})`,
    );
  }
  if (isCommonPassword(password, user)) {
    throw new ConfigError("CHIRP_ADMIN_PASSWORD is too common or easy to guess; choose another one");
  }
  return { adminUser: user, adminPassword: password };
}

function tls(env: Env): { tlsCert: string | null; tlsKey: string | null } {
  const cert = env.CHIRP_TLS_CERT?.trim() || null;
  const key = env.CHIRP_TLS_KEY?.trim() || null;
  if (!cert && !key) return { tlsCert: null, tlsKey: null };
  if (!cert || !key) {
    throw new ConfigError("CHIRP_TLS_CERT and CHIRP_TLS_KEY must be set together");
  }
  return { tlsCert: cert, tlsKey: key };
}

function cookieSecure(value: string | undefined, hasTls = false): Config["cookieSecure"] {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "auto") return hasTls ? true : "auto";
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(`CHIRP_COOKIE_SECURE must be auto, true or false (got "${value}")`);
}

/** An IP address, or an IP/CIDR with a valid prefix length (IPv4 0-32, IPv6 0-128). */
export function isProxyAddress(item: string): boolean {
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(item);
  if (!m) return false;
  const family = isIP(m[1]);
  if (family === 0) return false;
  if (m[2] === undefined) return true;
  const prefix = Number(m[2]);
  return prefix >= 0 && prefix <= (family === 4 ? 32 : 128);
}

function trustProxy(value: string | undefined): Config["trustProxy"] {
  const v = (value ?? "").trim();
  const lower = v.toLowerCase();
  if (v === "" || ["0", "false", "no", "off"].includes(lower)) return false;
  if (["true", "yes", "on"].includes(lower)) return true;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    if (hops >= 1 && hops <= 10) return hops;
  }
  const items = list(v);
  if (items.length && items.every(isProxyAddress)) return items;
  throw new ConfigError(
    "CHIRP_TRUST_PROXY must be false, a comma-separated list of proxy IPs/CIDRs (e.g. 10.0.0.5,fd00::/64), " +
      `a hop count (1-10) or true (got "${value}")`,
  );
}

function dailyBudget(value: string | undefined): number {
  const v = (value ?? "").trim();
  if (v === "") return DEFAULT_DAILY_BUDGET;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < 10 || n > 1_000_000) {
    throw new ConfigError(`CHIRP_LOGIN_DAILY_BUDGET must be an integer between 10 and 1000000 (got "${value}")`);
  }
  return n;
}

function scanMode(value: string | undefined): Config["scanMode"] {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "scan") return "scan";
  if (v === "scan-open") return "scan-open";
  throw new ConfigError(`CHIRP_SCAN_MODE must be "scan" or "scan-open" (got "${value}")`);
}

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

function defaultHostSnapshot(envValue: string | undefined): string | null {
  const v = envValue?.trim();
  if (v) return v;
  return existsSync("/run/chirp/host.json") ? "/run/chirp/host.json" : null;
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
  const { tlsCert, tlsKey } = tls(env);
  const setupToken = env.CHIRP_SETUP_TOKEN?.trim() || null;
  const envFile = env.CHIRP_ENV_FILE?.trim() || null;
  return {
    port: port(env.CHIRP_PORT),
    printKey: bool(env.CHIRP_PRINT_KEY),
    host: env.CHIRP_HOST?.trim() || "0.0.0.0",
    apiKey: apiKey(env.CHIRP_API_KEY),
    apiKeyFile: env.CHIRP_API_KEY_FILE?.trim() || resolve(dataDir, "api-key"),
    ...adminSeed(env),
    setupToken,
    envFile,
    tlsCert,
    tlsKey,
    cookieSecure: cookieSecure(env.CHIRP_COOKIE_SECURE, tlsCert !== null && tlsKey !== null),
    dataDir,
    devices,
    deviceTypes,
    smartIntervalSec: num(env.CHIRP_SMART_INTERVAL, 300, 1),
    sensorIntervalSec: num(env.CHIRP_SENSOR_INTERVAL, 10, 1),
    scanMode: scanMode(env.CHIRP_SCAN_MODE),
    rescanIntervalSec: num(env.CHIRP_RESCAN_INTERVAL, 3600, 60),
    smartctl: env.CHIRP_SMARTCTL?.trim() || "smartctl",
    sysfsRoot: env.CHIRP_SYSFS_ROOT?.trim() || "/sys",
    hostProc: defaultHostRoot(env.CHIRP_HOST_PROC, "/host/proc", "/proc"),
    hostSys: defaultHostRoot(env.CHIRP_HOST_SYS, "/host/sys", "/sys"),
    hostSnapshot: defaultHostSnapshot(env.CHIRP_HOST_SNAPSHOT),
    snapshotMaxAgeSec: num(env.CHIRP_SNAPSHOT_MAX_AGE_SEC, 60, 5),
    netInclude: list(env.CHIRP_NET_INCLUDE),
    netExclude: list(env.CHIRP_NET_EXCLUDE),
    tempWarn: {
      hdd: num(env.CHIRP_TEMP_WARN_HDD, 55),
      ssd: num(env.CHIRP_TEMP_WARN_SSD, 70),
      nvme: num(env.CHIRP_TEMP_WARN_NVME, 75),
    },
    webDir: env.CHIRP_WEB_DIR?.trim() ? resolve(env.CHIRP_WEB_DIR.trim()) : defaultWebDir(),
    displayName: env.CHIRP_DISPLAY_NAME?.trim() || hostname(),
    trustProxy: trustProxy(env.CHIRP_TRUST_PROXY),
    loginDailyBudget: dailyBudget(env.CHIRP_LOGIN_DAILY_BUDGET),
    corsOrigins: list(env.CHIRP_CORS_ORIGINS),
    rejected,
  };
}
