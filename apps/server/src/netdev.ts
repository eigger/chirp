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
  speedMbps: number | null;
  rxBytes: number | null;
  txBytes: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDropped: number | null;
  txDropped: number | null;
}

/** Shell-style glob (`*`, `?`) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

function matchAny(globs: string[], name: string): boolean {
  return globs.some((g) => globToRegExp(g).test(name));
}

/**
 * Whether an interface is listed. Order: CHIRP_NET_EXCLUDE hides, then
 * CHIRP_NET_INCLUDE shows, then the default exclude list hides, then virtual
 * devices are hidden on the host view. In the container view everything else
 * is shown (the container's own `eth0` is a veth and would otherwise vanish).
 */
export function isShown(name: string, kind: NetInterfaceKind, filter: NetFilter, scope: MetricScope): boolean {
  if (matchAny(filter.exclude, name)) return false;
  if (matchAny(filter.include, name)) return true;
  if (matchAny(DEFAULT_NET_EXCLUDE, name)) return false;
  return kind !== "virtual" || scope === "container";
}

/** Kind from the name only (used with /proc/net/dev, where sysfs is not available). */
export function kindFromName(name: string): NetInterfaceKind {
  if (/^(vmbr|br)/.test(name) && !name.includes(".")) return "bridge";
  if (/^bond\d+$/.test(name)) return "bond";
  if (name.includes(".") || /^vlan\d+$/.test(name)) return "vlan";
  if (/^(en|eth|wl|ib|ww)/.test(name)) return "physical";
  return "virtual";
}

function readNum(path: string): number | null {
  const text = readText(path)?.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function sysKind(dir: string): NetInterfaceKind {
  if (existsSync(join(dir, "bridge"))) return "bridge";
  if (existsSync(join(dir, "bonding"))) return "bond";
  const devtype = /^DEVTYPE=(.+)$/m.exec(readText(join(dir, "uevent")) ?? "")?.[1]?.trim();
  if (devtype === "vlan") return "vlan";
  if (devtype === "bridge") return "bridge";
  if (devtype === "bond") return "bond";
  if (existsSync(join(dir, "device"))) return "physical";
  return "virtual";
}

/** /sys/class/net under one sysfs root; null when the directory is missing or empty. */
export function readSysNet(sysRoot: string): RawInterface[] | null {
  const base = join(sysRoot, "class", "net");
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return null;
  }
  const out: RawInterface[] = [];
  for (const name of names.sort()) {
    const dir = join(base, name);
    const stat = (f: string) => readNum(join(dir, "statistics", f));
    const speed = readNum(join(dir, "speed"));
    out.push({
      name,
      kind: sysKind(dir),
      operState: readText(join(dir, "operstate"))?.trim() || null,
      speedMbps: speed !== null && speed > 0 ? speed : null,
      rxBytes: stat("rx_bytes"),
      txBytes: stat("tx_bytes"),
      rxErrors: stat("rx_errors"),
      txErrors: stat("tx_errors"),
      rxDropped: stat("rx_dropped"),
      txDropped: stat("tx_dropped"),
    });
  }
  return out.length ? out : null;
}

function fromNetDev(counters: Map<string, NetDevCounters>): RawInterface[] {
  return [...counters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, c]) => ({
      name,
      kind: kindFromName(name),
      operState: null,
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
 * All interfaces with their scope. Sources, in order:
 * 1. `<host sys>/class/net` (the host's /sys bind-mounted: shows the host's network namespace);
 * 2. the local `/sys/class/net`;
 * 3. `/proc/net/dev` without operstate/speed: `<host proc>/1/net/dev` (PID 1's
 *    namespace when the whole host /proc is mounted, e.g. Docker), then the local one.
 * /proc/net is per network namespace, so `<host proc>/net/dev` is never used.
 */
export function readInterfaces(roots: HostRoots): Scoped<RawInterface[]> | null {
  for (const { base, scope } of sysCandidates(roots)) {
    const list = readSysNet(base);
    if (list) return { value: list, scope };
  }
  const parse = (text: string) => {
    const m = parseNetDev(text);
    return m && m.size ? fromNetDev(m) : null;
  };
  if (roots.hostProc !== roots.proc) {
    const host = readText(join(roots.hostProc, "1", "net", "dev"));
    const list = host === null ? null : parse(host);
    if (list) return { value: list, scope: "host" };
  }
  return readProc({ ...roots, hostProc: roots.proc }, join("net", "dev"), parse);
}
