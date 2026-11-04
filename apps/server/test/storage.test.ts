import { describe, expect, it, vi } from "vitest";
import { Filesystem, StatusSnapshot, ZfsPool } from "@chirp/shared";
import { loadConfig } from "../src/config.js";
import { ioWaitPercent, parseProcStat } from "../src/procfs.js";
import { StorageCollector, isolatedStatfs, parseZpool, type StorageIo } from "../src/storage.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("storage and IO API", () => {
  const stats = { bsize: 4096, blocks: 100, bfree: 40, bavail: 30 };
  const io = (): StorageIo => ({ statfs: vi.fn(async () => stats), zpool: vi.fn(async () => "123\ttank\tDEGRADED\t1000\t600\t400\n") });
  const opts = { paths: ["/data"], hostRoot: null, inContainer: true, zfs: true };

  it("is opt-in, validates paths and bounds the number of filesystem reads", () => {
    expect(loadConfig({})).toMatchObject({ filesystemPaths: [], hostRoot: null, zfsEnabled: false });
    expect(loadConfig({ CHIRP_FILESYSTEM_PATHS: "/,/data,/data", CHIRP_ZFS_ENABLED: "true" })).toMatchObject({ filesystemPaths: ["/", "/data"], zfsEnabled: true });
    for (const path of ["relative", "/data/../secret", Array.from({ length: 33 }, (_, i) => `/p${i}`).join(",")]) {
      expect(() => loadConfig({ CHIRP_FILESYSTEM_PATHS: path })).toThrow(/CHIRP_FILESYSTEM_PATHS/);
    }
  });

  it("uses application-available blocks and distinguishes the container from a mounted host root", async () => {
    const fake = io();
    const local = await new StorageCollector(opts, fake).sample();
    expect(Filesystem.parse(local.filesystems![0])).toMatchObject({ scope: "container", totalBytes: 409600, usedBytes: 245760, availableBytes: 122880, usedPercent: 66.7 });
    const host = await new StorageCollector({ ...opts, hostRoot: "/host/root" }, fake).sample();
    expect(fake.statfs).toHaveBeenLastCalledWith("/host/root/data", "/host/root");
    expect(host.filesystems![0].scope).toBe("host");
    expect(host.filesystems![0].id).toBe(local.filesystems![0].id);
    expect(ZfsPool.parse(host.zfsPools![0])).toMatchObject({ id: "123", health: "DEGRADED", usedPercent: 60 });
  });

  it("isolates storage failures and never falls back to the container root", async () => {
    const fake = io();
    fake.statfs = vi.fn(async () => { throw new Error("not mounted"); });
    const result = await new StorageCollector({ ...opts, hostRoot: "/missing" }, fake).sample();
    expect(result.filesystems![0].totalBytes).toBeNull();
    expect(fake.statfs).toHaveBeenCalledTimes(1);
    expect(result.zfsPools).toHaveLength(1);
    fake.zpool = async () => { throw new Error("no zpool"); };
    expect((await new StorageCollector(opts, fake).sample()).zfsPools).toBeNull();
    expect(await new StorageCollector({ ...opts, paths: [], zfs: false }, fake).sample()).toEqual({ filesystems: null, zfsPools: null });
  });

  it("handles unavailable ZFS sizes without inventing zero usage", () => {
    expect(parseZpool("123\ttank\tUNAVAIL\t-\t-\t-\n")[0].usedPercent).toBeNull();
    expect(parseZpool("no pools available\n")).toEqual([]);
    expect(() => parseZpool("broken output")).toThrow();
  });

  it("computes IO wait from deltas and rejects initial, missing and decreasing counters", () => {
    const a = parseProcStat("cpu 100 0 0 800 100 0 0 0")!;
    const b = parseProcStat("cpu 120 0 0 860 120 0 0 0")!;
    expect(ioWaitPercent(a, b)).toBe(20);
    expect(ioWaitPercent(null, b)).toBeNull();
    expect(ioWaitPercent(b, a)).toBeNull();
    expect(ioWaitPercent(a, parseProcStat("cpu 200 0 0 900 90")!)).toBeNull();
    expect(ioWaitPercent(a, parseProcStat("cpu 200 0 0 900")!)).toBeNull();
  });

  it("keeps older status snapshots valid", () => {
    // Pre-extension fixtures cover both an old server and an existing host-metrics server.
    for (const name of ["status.legacy.json", "status.container-scope.json"]) {
      const snapshot = JSON.parse(readFileSync(new URL(`../../../packages/shared/fixtures/${name}`, import.meta.url), "utf8"));
      expect(StatusSnapshot.safeParse(snapshot).success).toBe(true);
    }
  });

  it("reads filesystem statistics in a separate process", async () => {
    const result = await isolatedStatfs(process.cwd());
    expect(result.bsize).toBeGreaterThan(0);
    expect(result.blocks).toBeGreaterThan(0);
    await expect(isolatedStatfs("/a-missing-chirp-filesystem")).rejects.toThrow();
  });

  it("bounds both collectors even when a killed worker never exits, without launching duplicate work", async () => {
    vi.useFakeTimers();
    try {
      const fake = io();
      let finishFs!: (value: typeof stats) => void;
      let finishZfs!: (text: string) => void;
      fake.statfs = vi.fn(() => new Promise((resolve) => { finishFs = resolve; }));
      fake.zpool = vi.fn(() => new Promise((resolve) => { finishZfs = resolve; }));
      const collector = new StorageCollector(opts, fake);
      for (let i = 0; i < 2; i++) {
        const sample = collector.sample();
        await vi.advanceTimersByTimeAsync(5000);
        const result = await sample;
        expect(result.filesystems![0].totalBytes).toBeNull();
        expect(result.zfsPools).toBeNull();
      }
      expect(fake.statfs).toHaveBeenCalledTimes(1);
      expect(fake.zpool).toHaveBeenCalledTimes(1);
      const recovered = collector.sample();
      finishFs(stats);
      finishZfs("123\ttank\tONLINE\t1000\t600\t400\n");
      expect((await recovered).zfsPools![0].health).toBe("ONLINE");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects host-root symlinks that resolve into the container's filesystem", async () => {
    const root = mkdtempSync(join(tmpdir(), "chirp-storage-"));
    try {
      const host = join(root, "host"), outside = join(root, "container");
      mkdirSync(host); mkdirSync(outside);
      symlinkSync(outside, join(host, "data"));
      await expect(isolatedStatfs(join(host, "data"), host)).rejects.toThrow("escapes host root");
      const result = await new StorageCollector({ ...opts, paths: ["/data"], hostRoot: host, zfs: false }).sample();
      expect(result.filesystems![0]).toMatchObject({ scope: "host", totalBytes: null });
      expect((await isolatedStatfs(host, host)).blocks).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
