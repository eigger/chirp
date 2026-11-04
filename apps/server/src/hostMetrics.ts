import type { Fan, Load, MetricScope, Memory, Network, Power, PowerSource, Voltage } from "@chirp/shared";
import { readProc, type HostRoots } from "./hostPaths.js";
import { uniqueIds } from "./ids.js";
import { MAX_GLOB_LENGTH, MAX_GLOBS, NetMatcher, readInterfaces, type NetFilter } from "./netdev.js";
import { CPU_POWER_CHIPS, energyWatts, readHwmonExtras, readRaplZones, type HwmonPower } from "./power.js";
import { counterRate, cpuUsagePercent, ioWaitPercent, parseLoadavg, parseMeminfo, parseProcStat, type CpuTimes } from "./procfs.js";

export interface HostSample {
  memory: Memory | null;
  load: Load | null;
  network: Network | null;
  power: Power | null;
  fans: Fan[];
  voltages: Voltage[];
}

export interface HostMetricsOptions {
  roots: HostRoots;
  /** sysfs root for hwmon/powercap (CHIRP_SYSFS_ROOT): host sensors are visible from a container too. */
  sysfsRoot: string;
  netFilter: NetFilter;
  warn?: (msg: string) => void;
}

const pct = (part: number, total: number) => Math.round((part / total) * 1000) / 10;

/**
 * Samples memory, load, network, power, fans and voltages. Cheap (a handful of
 * small file reads), so it runs on the sensor interval. Rates (CPU usage,
 * network bytes/s, RAPL watts) are computed against the previous sample.
 *
 * Every section is isolated: a section that throws becomes null (or empty) and
 * is logged once until it recovers; the others are unaffected. Missing or
 * unreadable files are not errors (null, no log).
 */
/** Samples closer together than this reuse the previous sample (no new rates from tiny intervals). */
export const MIN_SAMPLE_INTERVAL_MS = 2000;

export class HostMetrics {
  private last: { at: number; sample: HostSample } | null = null;
  private readonly matcher: NetMatcher;
  private prevStat: { scope: MetricScope; times: CpuTimes } | null = null;
  private prevNet: {
    scope: MetricScope;
    at: number;
    counters: Map<string, { rx: number | null; tx: number | null; ifindex: number | null }>;
  } | null = null;
  private prevRapl: { at: number; energy: Map<string, number | null> } | null = null;
  private failing = new Map<string, string>();

  constructor(private readonly opts: HostMetricsOptions) {
    this.matcher = new NetMatcher(opts.netFilter);
    for (const [name, list] of [
      ["CHIRP_NET_INCLUDE", this.matcher.ignored.include],
      ["CHIRP_NET_EXCLUDE", this.matcher.ignored.exclude],
    ] as const) {
      if (list.length) {
        opts.warn?.(
          `${name}: ignoring ${list.length} pattern(s) beyond the limits (${MAX_GLOBS} patterns of at most ${MAX_GLOB_LENGTH} characters): ${list.join(", ")}`,
        );
      }
    }
  }

  /**
   * `nowMs` must come from a monotonic clock (rates are deltas; a wall-clock
   * step would distort them). A call within MIN_SAMPLE_INTERVAL_MS of the
   * previous sample (e.g. POST /refresh right after a scheduled tick) returns
   * that sample unchanged.
   */
  sample(nowMs: number): HostSample {
    if (this.last && nowMs >= this.last.at && nowMs - this.last.at < MIN_SAMPLE_INTERVAL_MS) return this.last.sample;
    const sample = this.read(nowMs);
    this.last = { at: nowMs, sample };
    return sample;
  }

  private read(nowMs: number): HostSample {
    const extras = this.guard("hwmon", () => readHwmonExtras(this.opts.sysfsRoot), { power: [], fans: [], voltages: [] });
    return {
      memory: this.guard("memory", () => this.memory(), null),
      load: this.guard("load", () => this.load(), null),
      network: this.guard("network", () => this.network(nowMs), null),
      power: this.guard("power", () => this.power(nowMs, extras.power), null),
      fans: extras.fans,
      voltages: extras.voltages,
    };
  }

  private guard<T>(section: string, fn: () => T, fallback: T): T {
    try {
      const value = fn();
      if (this.failing.delete(section)) this.opts.warn?.(`host metrics: ${section} recovered`);
      return value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.failing.get(section) !== msg) {
        this.failing.set(section, msg);
        this.opts.warn?.(`host metrics: reading ${section} failed: ${msg}`);
      }
      return fallback;
    }
  }

  private memory(): Memory | null {
    const r = readProc(this.opts.roots, "meminfo", parseMeminfo);
    if (!r) return null;
    const m = r.value;
    const used = m.availableBytes === null ? null : m.totalBytes - m.availableBytes;
    const swapUsed =
      m.swapTotalBytes === null || m.swapFreeBytes === null ? null : Math.max(0, m.swapTotalBytes - m.swapFreeBytes);
    return {
      scope: r.scope,
      totalBytes: m.totalBytes,
      availableBytes: m.availableBytes,
      usedBytes: used,
      usedPercent: used === null ? null : pct(used, m.totalBytes),
      swapTotalBytes: m.swapTotalBytes,
      swapUsedBytes: swapUsed,
      swapUsedPercent: swapUsed === null || !m.swapTotalBytes ? null : pct(swapUsed, m.swapTotalBytes),
    };
  }

  private load(): Load | null {
    const avg = readProc(this.opts.roots, "loadavg", parseLoadavg);
    const stat = readProc(this.opts.roots, "stat", parseProcStat);
    if (!avg && !stat) {
      this.prevStat = null;
      return null;
    }
    let usage: number | null = null;
    let wait: number | null = null;
    if (stat) {
      const prev = this.prevStat && this.prevStat.scope === stat.scope ? this.prevStat.times : null;
      usage = cpuUsagePercent(prev, stat.value);
      wait = ioWaitPercent(prev, stat.value);
      this.prevStat = { scope: stat.scope, times: stat.value };
    } else {
      this.prevStat = null;
    }
    return {
      // Both files come from the same root in practice; if they differ, report the more conservative scope.
      scope: avg?.scope === "container" || stat?.scope === "container" ? "container" : "host",
      load1: avg?.value.load1 ?? null,
      load5: avg?.value.load5 ?? null,
      load15: avg?.value.load15 ?? null,
      cpuCount: stat && stat.value.cpuCount > 0 ? stat.value.cpuCount : null,
      cpuUsagePercent: usage,
      ioWaitPercent: wait,
    };
  }

  private network(nowMs: number): Network | null {
    // Name-only pre-filter: hidden guest devices (tap*, veth*, fw*) are never read.
    const r = readInterfaces(this.opts.roots, (name) => this.matcher.byName(name) !== false);
    if (!r) {
      this.prevNet = null;
      return null;
    }
    const prev = this.prevNet && this.prevNet.scope === r.scope ? this.prevNet : null;
    const dt = prev ? (nowMs - prev.at) / 1000 : 0;
    const counters = new Map<string, { rx: number | null; tx: number | null; ifindex: number | null }>();
    const shown = r.value.filter((i) => this.matcher.isShown(i.name, i.kind, r.scope));
    const ids = uniqueIds(shown.map((i) => i.name), "if");
    const interfaces = shown.map((i, idx) => {
      counters.set(i.name, { rx: i.rxBytes, tx: i.txBytes, ifindex: i.ifindex });
      const old = prev?.counters.get(i.name);
      // A different ifindex means the interface was re-created: its counters restarted.
      const p = old && old.ifindex === i.ifindex ? old : undefined;
      return {
        id: ids[idx],
        name: i.name,
        kind: i.kind,
        up: i.up,
        operState: i.operState,
        speedMbps: i.speedMbps,
        rxBytes: i.rxBytes,
        txBytes: i.txBytes,
        rxBytesPerSec: counterRate(p?.rx, i.rxBytes, dt),
        txBytesPerSec: counterRate(p?.tx, i.txBytes, dt),
        rxErrors: i.rxErrors,
        txErrors: i.txErrors,
        rxDropped: i.rxDropped,
        txDropped: i.txDropped,
      };
    });
    this.prevNet = { scope: r.scope, at: nowMs, counters };
    return { scope: r.scope, interfaces };
  }

  private power(nowMs: number, hwmon: HwmonPower[]): Power | null {
    const zones = readRaplZones(this.opts.sysfsRoot).filter((z) => z.energyUj !== null);
    const prev = this.prevRapl;
    const dt = prev ? (nowMs - prev.at) / 1000 : 0;
    const raplSources = zones.map((z) => ({
      label: z.label,
      isPackage: z.isPackage,
      watts: energyWatts(prev?.energy.get(z.zone), z.energyUj, z.maxEnergyRangeUj, dt),
    }));
    this.prevRapl = zones.length ? { at: nowMs, energy: new Map(zones.map((z) => [z.zone, z.energyUj])) } : null;

    if (!raplSources.length && !hwmon.length) return null;

    const raplIds = uniqueIds(raplSources.map((s) => `rapl_${s.label}`), "rapl");
    const sources: PowerSource[] = [
      ...raplSources.map((s, i) => ({ id: raplIds[i], label: s.label, watts: s.watts })),
      ...hwmon.map((h) => ({ id: h.id, label: `${h.chip} ${h.label}`, watts: h.watts })),
    ];

    let packageWatts: number | null = null;
    let packageSource: Power["packageSource"] = null;
    const packages = raplSources.filter((s) => s.isPackage);
    const cpuHwmon = hwmon.filter((h) => CPU_POWER_CHIPS.includes(h.chip));
    if (packages.length) {
      packageSource = "rapl";
      packageWatts = packages.every((s) => s.watts !== null)
        ? Math.round(packages.reduce((a, s) => a + (s.watts ?? 0), 0) * 10) / 10
        : null;
    } else if (cpuHwmon.length) {
      packageSource = "hwmon";
      packageWatts = cpuHwmon.every((h) => h.watts !== null)
        ? Math.round(cpuHwmon.reduce((a, h) => a + (h.watts ?? 0), 0) * 10) / 10
        : null;
    }
    return { packageWatts, packageSource, sources };
  }
}
