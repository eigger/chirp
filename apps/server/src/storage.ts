import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { Filesystem, ZfsPool } from "@chirp/shared";

const exec = promisify(execFile);
export interface StorageSample { filesystems: Filesystem[] | null; zfsPools: ZfsPool[] | null }
export interface StorageOptions {
  paths: string[];
  /** Read-only host-root mount; never fall back to container paths. */
  hostRoot: string | null;
  inContainer: boolean;
  zfs: boolean;
}
interface FsStats { bsize: number; blocks: number; bfree: number; bavail: number }
export interface StorageIo {
  statfs: (path: string) => Promise<FsStats>;
  zpool: () => Promise<string>;
}
const defaultIo: StorageIo = {
  statfs,
  zpool: async () => (await exec("zpool", ["list", "-Hp", "-o", "guid,name,health,size,allocated,free"], {
    timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  })).stdout,
};
const percent = (used: number | null, total: number | null) =>
  used === null || total === null || total <= 0 ? null : Math.round(used / total * 1000) / 10;
const bytes = (value: string): number | null => {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
};

export function parseZpool(text: string): ZfsPool[] {
  if (!text.trim() || text.trim() === "no pools available") return [];
  return text.trim().split(/\r?\n/).map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 6 || !/^\d+$/.test(fields[0]) || !fields[1] || !fields[2]) throw new Error("Invalid zpool list output");
    const [id, name, health, size, allocated, free] = fields;
    const totalBytes = bytes(size), usedBytes = bytes(allocated);
    if ([size, allocated, free].some((v) => v !== "-" && bytes(v) === null)) throw new Error("Invalid zpool size");
    return { id, name, health, totalBytes, usedBytes, freeBytes: bytes(free), usedPercent: percent(usedBytes, totalBytes) };
  });
}

/** Async opt-in collection; GET handlers only read completed samples. */
export class StorageCollector {
  // Keep one syscall per stalled filesystem rather than accumulating work.
  private pendingFs = new Map<string, Promise<FsStats>>();
  constructor(private readonly options: StorageOptions, private readonly io: StorageIo = defaultIo) {}

  async sample(): Promise<StorageSample> {
    const [filesystems, zfsPools] = await Promise.all([
      this.options.paths.length ? Promise.all(this.options.paths.map((path) => this.filesystem(path))) : null,
      this.options.zfs ? this.io.zpool().then(parseZpool).catch(() => null) : null,
    ]);
    return { filesystems, zfsPools };
  }

  private async filesystem(path: string): Promise<Filesystem> {
    const result: Filesystem = {
      id: `fs_${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
      path, scope: this.options.hostRoot || !this.options.inContainer ? "host" : "container",
      totalBytes: null, usedBytes: null, availableBytes: null, usedPercent: null,
    };
    const target = this.options.hostRoot ? posix.join(this.options.hostRoot, path) : path;
    let pending = this.pendingFs.get(target);
    if (!pending) {
      pending = this.io.statfs(target);
      this.pendingFs.set(target, pending);
      void pending.finally(() => this.pendingFs.delete(target)).catch(() => {});
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stats = await Promise.race([
        pending,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("statfs timeout")), 5000); }),
      ]);
      const { bsize, blocks, bfree, bavail } = stats;
      if (![bsize, blocks, bfree, bavail].every((n) => Number.isSafeInteger(n) && n >= 0) || bsize <= 0 || bfree > blocks || bavail > bfree) return result;
      const total = blocks * bsize, used = (blocks - bfree) * bsize, available = bavail * bsize;
      if (![total, used, available].every(Number.isSafeInteger)) return result;
      return { ...result, totalBytes: total, usedBytes: used, availableBytes: available,
        // Like df: reserved blocks are unavailable to ordinary applications.
        usedPercent: percent(used, used + available) };
    } catch {
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}
