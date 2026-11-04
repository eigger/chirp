import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { promisify } from "node:util";
import type { Filesystem, ZfsPool } from "@chirp/shared";

const exec = promisify(execFile);
// Filesystem calls on hard/stalled mounts can block indefinitely. Keep them
// outside the server's shared libuv pool and bound the number of live workers.
let fsWorkers = 0;
const fsQueue: (() => void)[] = [];
const FS_SCRIPT = `
const fs = require("node:fs"), path = require("node:path");
let target = process.argv[1];
if (process.argv[2]) {
  const root = fs.realpathSync(process.argv[2]);
  target = fs.realpathSync(target);
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("Filesystem path escapes host root");
}
process.stdout.write(JSON.stringify(fs.statfsSync(target)));
`;
export function isolatedStatfs(path: string, hostRoot?: string | null): Promise<FsStats> {
  return new Promise((resolve, reject) => {
    const run = () => {
      fsWorkers++;
      void exec(process.execPath, ["-e", FS_SCRIPT, path, hostRoot ?? ""], {
        timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096, encoding: "utf8",
      }).then(({ stdout }) => JSON.parse(stdout) as FsStats).then(resolve, reject).finally(() => {
        fsWorkers--;
        fsQueue.shift()?.();
      });
    };
    if (fsWorkers < 2) run();
    else fsQueue.push(run);
  });
}

async function deadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("storage timeout")), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
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
  statfs: (path: string, hostRoot?: string | null) => Promise<FsStats>;
  zpool: () => Promise<string>;
}
const defaultIo: StorageIo = {
  statfs: isolatedStatfs,
  zpool: async () => (await exec("zpool", ["list", "-Hp", "-o", "guid,name,health,size,allocated,free"], {
    timeout: 5000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
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
  private pendingZpool: Promise<string> | null = null;
  constructor(private readonly options: StorageOptions, private readonly io: StorageIo = defaultIo) {}

  async sample(): Promise<StorageSample> {
    const [filesystems, zfsPools] = await Promise.all([
      this.options.paths.length ? Promise.all(this.options.paths.map((path) => this.filesystem(path))) : null,
      this.options.zfs ? this.zfs() : null,
    ]);
    return { filesystems, zfsPools };
  }

  private async zfs(): Promise<ZfsPool[] | null> {
    if (!this.pendingZpool) {
      this.pendingZpool = Promise.resolve().then(() => this.io.zpool());
      void this.pendingZpool.finally(() => { this.pendingZpool = null; }).catch(() => {});
    }
    try {
      return parseZpool(await deadline(this.pendingZpool));
    } catch {
      return null;
    }
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
      pending = Promise.resolve().then(() => this.io.statfs(target, this.options.hostRoot));
      this.pendingFs.set(target, pending);
      void pending.finally(() => this.pendingFs.delete(target)).catch(() => {});
    }
    try {
      const stats = await deadline(pending);
      const { bsize, blocks, bfree, bavail } = stats;
      if (![bsize, blocks, bfree, bavail].every((n) => Number.isSafeInteger(n) && n >= 0) || bsize <= 0 || bfree > blocks || bavail > bfree) return result;
      const total = blocks * bsize, used = (blocks - bfree) * bsize, available = bavail * bsize;
      if (![total, used, available].every(Number.isSafeInteger)) return result;
      return { ...result, totalBytes: total, usedBytes: used, availableBytes: available,
        // Like df: reserved blocks are unavailable to ordinary applications.
        usedPercent: percent(used, used + available) };
    } catch {
      return result;
    }
  }
}
