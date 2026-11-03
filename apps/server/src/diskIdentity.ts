import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Stable disk IDs without waking the disk.
 *
 * The final ID rule lives in `smartctl.ts#diskId` (WWN first, else model+serial
 * slug). That needs a successful SMART read, which a disk in standby (or one
 * that fails to read at boot) cannot give us. This module derives the same ID
 * from information the kernel already has cached, and pins every ID it hands
 * out to a persistent, identity-based key so an ID never changes afterwards:
 *
 *  1. pinned ID from the cache file (`<dataDir>/disk-ids.json`), keyed by a
 *     `/dev/disk/by-id/...` path (by-id names embed WWN/serial, so a key can
 *     never move to a different disk);
 *  2. derivation from sysfs (`/sys/dev/{block,char}/M:m`): ATA disks via the
 *     libata VPD-83 `wwid` ("naa.<wwn>" or "t10.ATA <model> <serial>"), NVMe via
 *     the controller's `model` + `serial` files;
 *  3. derivation from by-id link names (`wwn-0x...` next to an `ata-...` alias,
 *     `ata-<model>_<serial>`, `nvme-<model>_<serial>`).
 *
 * Nothing here opens the block device: only stat(), readlink/realpath and sysfs
 * attribute reads, none of which issue commands to the drive.
 * If nothing can be derived the caller falls back to a provisional
 * `dev_<name>` ID, which is the only kind of ID that may still change.
 */

export interface DiskIdentityOptions {
  /** Persisted path->id map. null = keep pins in memory only. */
  cacheFile?: string | null;
  byIdDir?: string;
  sysfsRoot?: string;
  warn?: (msg: string) => void;
  /** Test seam: major/minor of a device node (null if not a device node). */
  devNumber?: (path: string) => { type: "block" | "char"; major: number; minor: number } | null;
}

const ID_RE = /^[a-z0-9_]+$/;
const CACHE_VERSION = 1;

export function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** A provisional ID (`dev_<name>`) is used only while nothing better is known. */
export function provisionalId(devicePath: string): string {
  return `dev_${slug(basename(devicePath)) || "unknown"}`;
}

export function isProvisionalId(id: string): boolean {
  return id.startsWith("dev_");
}

/** NAA type 5 WWN (16 hex digits): the only form smartctl's naa/oui/id fields reproduce. */
function wwnFromHex(hex: string): string | null {
  const h = hex.toLowerCase();
  return /^5[0-9a-f]{15}$/.test(h) && h !== "0".repeat(16) ? `wwn_${h}` : null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function defaultDevNumber(path: string): { type: "block" | "char"; major: number; minor: number } | null {
  try {
    const s = statSync(path);
    if (!s.isBlockDevice() && !s.isCharacterDevice()) return null;
    const rdev = s.rdev;
    // glibc dev_t encoding (major: bits 8-19 and 32+, minor: bits 0-7 and 20-31).
    const major = Math.floor(rdev / 256) & 0xfff;
    const minor = (rdev & 0xff) | (Math.floor(rdev / 4096) & 0xfff00);
    return { type: s.isBlockDevice() ? "block" : "char", major, minor };
  } catch {
    return null;
  }
}

/** Parse a libata/SCSI sysfs `wwid` into a chirp ID (ATA disks only). */
export function idFromAtaWwid(wwid: string): string | null {
  const naa = /^naa\.([0-9a-f]+)$/i.exec(wwid.trim());
  if (naa) return wwnFromHex(naa[1]);
  // libata always emits a T10 designator: vendor "ATA" + model + serial.
  const t10 = /^t10\.ATA\s+(.+)$/.exec(wwid.trim());
  if (t10) return slug(t10[1]) || null;
  return null;
}

/** Derive an ID from by-id alias names of one device (no sysfs). */
export function idFromByIdNames(names: string[]): string | null {
  const nvme = names.filter((n) => n.startsWith("nvme-") && !/^nvme-(eui|nvme|uuid)\./.test(n));
  if (nvme.length) {
    // udev creates nvme-<model>_<serial> and nvme-<model>_<serial>_<nsid>; prefer the shorter.
    const [short] = [...nvme].sort((a, b) => a.length - b.length || a.localeCompare(b));
    const ambiguous = /_\d+$/.test(short) && !nvme.some((n) => n !== short && n.startsWith(short));
    return ambiguous && nvme.length === 1 ? null : slug(short.slice("nvme-".length)) || null;
  }
  const ata = names.filter((n) => n.startsWith("ata-"));
  if (!ata.length) return null; // SAS/USB/virtual: smartctl's ID cannot be predicted from names.
  for (const n of names) {
    const m = /^wwn-0x([0-9a-f]+)$/i.exec(n);
    const id = m ? wwnFromHex(m[1]) : null;
    if (id) return id;
  }
  if (names.some((n) => n.startsWith("wwn-"))) return null; // a WWN we cannot map: do not guess
  const [first] = [...ata].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return slug(first.slice("ata-".length)) || null;
}

export class DiskIdentity {
  private readonly byIdDir: string;
  private readonly sysfsRoot: string;
  private readonly cacheFile: string | null;
  private readonly warn: (msg: string) => void;
  private readonly devNumber: NonNullable<DiskIdentityOptions["devNumber"]>;
  private pins = new Map<string, string>();
  private warned = new Set<string>();

  constructor(opts: DiskIdentityOptions = {}) {
    this.byIdDir = opts.byIdDir ?? "/dev/disk/by-id";
    this.sysfsRoot = opts.sysfsRoot ?? "/sys";
    this.cacheFile = opts.cacheFile ?? null;
    this.warn = opts.warn ?? (() => {});
    this.devNumber = opts.devNumber ?? defaultDevNumber;
    this.load();
  }

  /** An identity that never derives or persists anything (tests, fallbacks). */
  static none(): DiskIdentity {
    return new DiskIdentity({ byIdDir: "/nonexistent-chirp-by-id", sysfsRoot: "/nonexistent-chirp-sys", devNumber: () => null });
  }

  private load(): void {
    if (!this.cacheFile) return;
    let text: string;
    try {
      text = readFileSync(this.cacheFile, "utf8");
    } catch {
      return; // first start
    }
    try {
      const json = JSON.parse(text) as { version?: unknown; ids?: Record<string, unknown> };
      for (const [key, id] of Object.entries(json.ids ?? {})) {
        if (typeof id === "string" && ID_RE.test(id) && !isProvisionalId(id)) this.pins.set(key, id);
      }
    } catch {
      this.warn(`ignoring unreadable disk id cache ${this.cacheFile}`);
    }
  }

  private save(): void {
    if (!this.cacheFile) return;
    const ids = Object.fromEntries([...this.pins].sort(([a], [b]) => a.localeCompare(b)));
    const dir = dirname(this.cacheFile);
    const tmp = join(dir, `.${basename(this.cacheFile)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, `${JSON.stringify({ version: CACHE_VERSION, ids }, null, 2)}\n`, { mode: 0o644, flag: "wx" });
      renameSync(tmp, this.cacheFile);
    } catch (err) {
      rmSync(tmp, { force: true });
      this.warnOnce(`cache-write`, `could not persist disk ids to ${this.cacheFile}: ${(err as Error).message}`);
    }
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(msg);
  }

  private realpath(path: string): string | null {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  }

  /** by-id names (without -partN) that point at the same node as `devicePath`. */
  aliases(devicePath: string): string[] {
    const names = new Set<string>();
    if (dirname(devicePath) === this.byIdDir) names.add(basename(devicePath));
    const target = this.realpath(devicePath);
    let entries: string[] = [];
    try {
      entries = readdirSync(this.byIdDir);
    } catch {
      /* no by-id directory (container without udev) */
    }
    if (target) {
      for (const name of entries) {
        if (/-part\d+$/.test(name)) continue;
        if (this.realpath(join(this.byIdDir, name)) === target) names.add(name);
      }
    }
    return [...names].filter((n) => !/-part\d+$/.test(n)).sort();
  }

  /** The identity-based key a pin is stored under, or null for paths with no by-id alias. */
  stableKey(devicePath: string, aliases = this.aliases(devicePath)): string | null {
    if (dirname(devicePath) === this.byIdDir) return devicePath;
    const rank = (n: string) =>
      n.startsWith("wwn-") ? 1 : n.startsWith("ata-") || n.startsWith("nvme-eui.") ? 2 : n.startsWith("nvme-") ? 3 : n.startsWith("scsi-") ? 4 : 5;
    const [best] = [...aliases].sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));
    return best ? join(this.byIdDir, best) : null;
  }

  /** Derive the final ID from sysfs (kernel-cached identify data). */
  private fromSysfs(devicePath: string): string | null {
    const dev = this.devNumber(devicePath);
    if (!dev) return null;
    let sysdir: string;
    try {
      sysdir = realpathSync(join(this.sysfsRoot, "dev", dev.type, `${dev.major}:${dev.minor}`));
    } catch {
      return null;
    }
    const name = basename(sysdir);
    if (name.startsWith("nvme")) {
      // char /dev/nvmeN is the controller itself; block nvmeNnM links to it (or its subsystem) via device/.
      for (const ctrl of dev.type === "char" ? [sysdir] : [join(sysdir, "device"), sysdir]) {
        const model = readText(join(ctrl, "model"));
        const serial = readText(join(ctrl, "serial"));
        if (model && serial) return slug(`${model}_${serial}`) || null;
      }
      return null;
    }
    if (dev.type !== "block") return null;
    const vendor = readText(join(sysdir, "device", "vendor"));
    if (vendor !== "ATA") return null; // SAS/USB bridges: smartctl's ID cannot be predicted
    const wwid = readText(join(sysdir, "device", "wwid"));
    return wwid ? idFromAtaWwid(wwid) : null;
  }

  /**
   * The ID to use for a device that has not been read successfully yet:
   * pinned ID, else a derived one (which is pinned right away), else null.
   */
  known(devicePath: string): string | null {
    const aliases = this.aliases(devicePath);
    const key = this.stableKey(devicePath, aliases);
    if (key) {
      const pinned = this.pins.get(key);
      if (pinned) return pinned;
    }
    const derived = this.fromSysfs(devicePath) ?? idFromByIdNames(aliases);
    if (!derived || !ID_RE.test(derived)) return null;
    if (key) {
      this.pins.set(key, derived);
      this.save();
    }
    return derived;
  }

  /**
   * After a successful read: returns the ID to publish. A pinned (or derivable)
   * ID wins over the one computed from this read so a disk's ID never changes;
   * a mismatch is logged once. A read ID is pinned for later restarts.
   */
  confirm(devicePath: string, readId: string): string {
    const pinned = this.known(devicePath);
    if (pinned) {
      if (pinned !== readId && !isProvisionalId(readId)) {
        this.warnOnce(
          `mismatch:${devicePath}`,
          `disk ${devicePath}: keeping pinned id ${pinned} (this read suggests ${readId})`,
        );
      }
      return pinned;
    }
    if (isProvisionalId(readId)) return readId;
    const key = this.stableKey(devicePath);
    if (key && this.pins.get(key) !== readId) {
      this.pins.set(key, readId);
      this.save();
    }
    return readId;
  }
}
