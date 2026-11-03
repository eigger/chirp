import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MetricScope, NetInterfaceKind } from "@chirp/shared";
import { readProc, readText, sysCandidates, type HostRoots, type Scoped } from "./hostPaths.js";
import { parseNetDev, type NetDevCounters } from "./procfs.js";

/**
 * Hidden by default: per-guest devices Proxmox creates (veth*, tap*, fwbr*,
 * fwpr*, fwln*), loopback and Docker's bridges. Virtual devices of any other
 * name are hidden too (on the host view), so the default list shows physical
 * NICs, bonds, bridges (vmbr*) and VLANs.
 */
export const DEFAULT_NET_EXCLUDE = ["lo", "veth*", "tap*", "fwbr*", "fwpr*", "fwln*", "docker*", "br-*"];

/** Limits for CHIRP_NET_INCLUDE / CHIRP_NET_EXCLUDE (extra or longer entries are ignored). */
export const MAX_GLOBS = 64;
export const MAX_GLOB_LENGTH = 64;

export interface NetFilter {
  /** CHIRP_NET_INCLUDE: always shown (unless also in `exclude`). */
  include: string[];
  /** CHIRP_NET_EXCLUDE: always hidden (added to the defaults). */
  exclude: string[];
}

export interface RawInterface {
  name: string;
  kind: NetInterfaceKind;
  operState: string | null;
  /** operstate `up`, or `unknown` with carrier 1 (drivers that do not report operstate). */
  up: boolean;
  /** Changes when the interface is re-created; a change resets the rate. */
  ifindex: number | null;
  speedMbps: number | null;
  rxBytes: number | null;
  txBytes: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDropped: number | null;
  txDropped: number | null;
}

/**
 * Shell-style glob (`*`, `?`) matcher. Greedy matching with a single
 * backtrack point: O(pattern x name) worst case, no RegExp and therefore no
 * catastrophic backtracking.
 */
export function globMatch(glob: string, name: string): boolean {
  const g = glob.replace(/\*+/g, "*");
  let gi = 0;
  let ni = 0;
  let star = -1;
  let mark = 0;
  while (ni < name.length) {
    if (gi < g.length && g[gi] !== "*" && (g[gi] === "?" || g[gi] === name[ni])) {
      gi++;
      ni++;
    } else if (gi < g.length && g[gi] === "*") {
      star = gi++;
      mark = ni;
    } else if (star >= 0) {
      gi = star + 1;
      ni = ++mark;
    } else {
      return false;
    }
  }
  while (gi < g.length && g[gi] === "*") gi++;
  return gi === g.length;
}

function cap(globs: string[]): string[] {
  return globs.filter((g) => g.length > 0 && g.length <= MAX_GLOB_LENGTH).slice(0, MAX_GLOBS);
}

/** Interface filter, built once from the configuration. */
export class NetMatcher {
  private readonly include: string[];
  private readonly exclude: string[];

  constructor(filter: NetFilter) {
    this.include = cap(filter.include);
    this.exclude = cap(filter.exclude);
  }

  /**
   * Decision from the name alone: false = hidden whatever the kind (nothing
   * of the interface needs to be read), true = shown whatever the kind,
   * null = depends on the kind.
   */
  byName(name: string): boolean | null {
    if (this.exclude.some((g) => globMatch(g, name))) return false;
    if (this.include.some((g) => globMatch(g, name))) return true;
    if (DEFAULT_NET_EXCLUDE.some((g) => globMatch(g, name))) return false;
    return null;
  }

  /**
   * Order: CHIRP_NET_EXCLUDE hides, then CHIRP_NET_INCLUDE shows, then the
   * default exclude list hides, then virtual devices are hidden on the host
   * view. In the container view everything else is shown (the container's own
   * `eth0` is a veth and would otherwise vanish).
   */
  isShown(name: string, kind: NetInterfaceKind, scope: MetricScope): boolean {
    return this.byName(name) ?? (kind !== "virtual" || scope === "container");
  }
}

/** One-off check (tests). */
export function isShown(name: string, kind: NetInterfaceKind, filter: NetFilter, scope: MetricScope): boolean {
  return new NetMatcher(filter).isShown(name, kind, scope);
}

/** Kind from the name only (used with /proc/net/dev, and to refine sysfs `virtual`). */
export function kindFromName(name: string): NetInterfaceKind {
  if (/^(vmbr|br)/.test(name) && !name.includes(".")) return "bridge";
  if (/^bond\d+$/.test(name)) return "bond";
  if (name.includes(".") || /^vlan\d+$/.test(name)) return "vlan";
  if (/^(en|eth|wl|ib|ww)/.test(name)) return "physical";
  return "virtual";
}

/** File access used by readSysNet (injectable so tests can count reads). */
export interface SysIo {
  readText: (path: string) => string | null;
  exists: (path: string) => boolean;
  readdir: (path: string) => string[] | null;
}

export const defaultSysIo: SysIo = {
  readText,
  exists: existsSync,
  readdir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return null;
    }
  },
};

function num(io: SysIo, path: string): number | null {
  const text = io.readText(path)?.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function sysKind(io: SysIo, dir: string, name: string): NetInterfaceKind {
  if (io.exists(join(dir, "bridge"))) return "bridge";
  if (io.exists(join(dir, "bonding"))) return "bond";
  const devtype = /^DEVTYPE=(.+)$/m.exec(io.readText(join(dir, "uevent")) ?? "")?.[1]?.trim();
  if (devtype === "vlan") return "vlan";
  if (devtype === "bridge") return "bridge";
  if (devtype === "bond") return "bond";
  if (io.exists(join(dir, "device"))) return "physical";
  // No sysfs marker: Open vSwitch bridges/bonds/VLAN ports (`vmbr0` as an OVS
  // internal port), ... Refine by name, but never promote a virtual device to "physical".
  const byName = kindFromName(name);
  return byName === "physical" ? "virtual" : byName;
}

/**
 * /sys/class/net under one sysfs root; null when the directory is missing or
 * empty. `keep(name)` returning false skips an interface before anything of
 * it is read (a hidden guest device costs one readdir entry, no file reads).
 */
export function readSysNet(
  sysRoot: string,
  keep: (name: string) => boolean = () => true,
  io: SysIo = defaultSysIo,
): RawInterface[] | null {
  const base = join(sysRoot, "class", "net");
  const names = io.readdir(base);
  if (!names || names.length === 0) return null;
  const out: RawInterface[] = [];
  for (const name of names.sort()) {
    if (!keep(name)) continue;
    const dir = join(base, name);
    const stat = (f: string) => num(io, join(dir, "statistics", f));
    const operState = io.readText(join(dir, "operstate"))?.trim() || null;
    const up = operState === "up" || (operState === "unknown" && num(io, join(dir, "carrier")) === 1);
    // speed is only meaningful (and readable without EINVAL) while the link is up.
    const speed = up ? num(io, join(dir, "speed")) : null;
    out.push({
      name,
      kind: sysKind(io, dir, name),
      operState,
      up,
      ifindex: num(io, join(dir, "ifindex")),
      speedMbps: speed !== null && speed > 0 ? speed : null,
      rxBytes: stat("rx_bytes"),
      txBytes: stat("tx_bytes"),
      rxErrors: stat("rx_errors"),
      txErrors: stat("tx_errors"),
      rxDropped: stat("rx_dropped"),
      txDropped: stat("tx_dropped"),
    });
  }
  return out;
}

function fromNetDev(counters: Map<string, NetDevCounters>, keep: (name: string) => boolean): RawInterface[] {
  return [...counters.entries()]
    .filter(([name]) => keep(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, c]) => ({
      name,
      kind: kindFromName(name),
      operState: null,
      up: false,
      ifindex: null,
      speedMbps: null,
      rxBytes: c.rxBytes,
      txBytes: c.txBytes,
      rxErrors: c.rxErrors,
      txErrors: c.txErrors,
      rxDropped: c.rxDropped,
      txDropped: c.txDropped,
    }));
}

/**
 * Interfaces with their scope. Sources, in order:
 * 1. `<host sys>/class/net` (the host's /sys bind-mounted: shows the host's network namespace);
 * 2. the local `/sys/class/net`;
 * 3. `/proc/net/dev` without operstate/speed: `<host proc>/1/net/dev` (PID 1's
 *    namespace when the whole host /proc is mounted), then the local one.
 * /proc/net is per network namespace, so `<host proc>/net/dev` is never used.
 *
 * `keep` pre-filters by name (NetMatcher.byName); the result can still hold
 * interfaces that the kind-based rule hides.
 */
export function readInterfaces(
  roots: HostRoots,
  keep: (name: string) => boolean = () => true,
  io: SysIo = defaultSysIo,
): Scoped<RawInterface[]> | null {
  for (const { base, scope } of sysCandidates(roots)) {
    const list = readSysNet(base, keep, io);
    if (list) return { value: list, scope };
  }
  const parse = (text: string) => {
    const m = parseNetDev(text);
    return m && m.size ? fromNetDev(m, keep) : null;
  };
  if (roots.hostProc !== roots.proc) {
    const host = readText(join(roots.hostProc, "1", "net", "dev"));
    const list = host === null ? null : parse(host);
    if (list) return { value: list, scope: "host" };
  }
  return readProc({ ...roots, hostProc: roots.proc }, join("net", "dev"), parse);
}
