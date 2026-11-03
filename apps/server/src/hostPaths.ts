import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetricScope } from "@chirp/shared";

/**
 * Where host metrics are read from.
 *
 * In a (privileged) LXC, the container's /proc/meminfo, /proc/stat and
 * /proc/loadavg may be virtualised by lxcfs and /sys/class/net only shows the
 * container's network namespace. The installer bind-mounts the host's files
 * read-only under /host/proc and the host's /sys under /host/sys; Docker users
 * mount `-v /proc:/host/proc:ro -v /sys:/host/sys:ro`.
 *
 * Every read first tries the host root and falls back to the local one. The
 * value's scope is `host` when it came from a separate host root, or from the
 * local root while chirp does not run in a container; otherwise `container`.
 */
export interface HostRoots {
  /** CHIRP_HOST_PROC (default /host/proc if it exists, else /proc). */
  hostProc: string;
  /** CHIRP_HOST_SYS (default /host/sys if it exists, else /sys). */
  hostSys: string;
  /** The process's own /proc and /sys (fallback). */
  proc: string;
  sys: string;
  /** chirp runs inside a container (local /proc and /sys are not the host's view). */
  inContainer: boolean;
}

export function defaultHostRoot(envValue: string | undefined, mounted: string, local: string): string {
  const v = envValue?.trim();
  if (v) return v;
  return existsSync(mounted) ? mounted : local;
}

/**
 * Container detection: systemd's /run/systemd/container (LXC, nspawn), Docker's
 * /.dockerenv, podman's /run/.containerenv, or `container=` in PID 1's
 * environment (LXC sets it).
 */
export function detectContainer(root = "/"): boolean {
  for (const marker of ["run/systemd/container", ".dockerenv", "run/.containerenv"]) {
    if (existsSync(join(root, marker))) return true;
  }
  try {
    return readFileSync(join(root, "proc/1/environ"), "latin1").split("\0").some((e) => e.startsWith("container="));
  } catch {
    return false;
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export interface Scoped<T> {
  value: T;
  scope: MetricScope;
}

function scopeOf(roots: HostRoots, base: string, local: string): MetricScope {
  return base !== local || !roots.inContainer ? "host" : "container";
}

/**
 * Read `<proc root>/<rel>` and parse it, host root first. A file that exists
 * but does not parse (e.g. an empty placeholder left by a failed bind mount)
 * falls back like a missing one. Returns null when neither root yields a value.
 */
export function readProc<T>(roots: HostRoots, rel: string, parse: (text: string) => T | null): Scoped<T> | null {
  const bases = roots.hostProc === roots.proc ? [roots.proc] : [roots.hostProc, roots.proc];
  for (const base of bases) {
    const text = readText(join(base, rel));
    if (text === null) continue;
    const value = parse(text);
    if (value !== null) return { value, scope: scopeOf(roots, base, roots.proc) };
  }
  return null;
}

/** Candidate sysfs roots for host-namespaced data (network), host first. */
export function sysCandidates(roots: HostRoots): { base: string; scope: MetricScope }[] {
  const bases = roots.hostSys === roots.sys ? [roots.sys] : [roots.hostSys, roots.sys];
  return bases.map((base) => ({ base, scope: scopeOf(roots, base, roots.sys) }));
}
