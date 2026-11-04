/** Pure parsers for /proc files used by the host metrics. */

export interface MemInfo {
  totalBytes: number;
  availableBytes: number | null;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
}

/** /proc/meminfo (kB values). Returns null without a MemTotal line. */
export function parseMeminfo(text: string): MemInfo | null {
  const kb = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9_()]+):\s+(\d+)(?:\s+kB)?\s*$/.exec(line.trim());
    if (m) kb.set(m[1], Number(m[2]) * 1024);
  }
  const total = kb.get("MemTotal");
  if (total === undefined || total <= 0) return null;
  let available = kb.get("MemAvailable") ?? null;
  if (available === null) {
    // Kernels before 3.14 have no MemAvailable: approximate it.
    const free = kb.get("MemFree");
    const buffers = kb.get("Buffers");
    const cached = kb.get("Cached");
    available = free !== undefined && buffers !== undefined && cached !== undefined ? free + buffers + cached : null;
  }
  return {
    totalBytes: total,
    availableBytes: available === null ? null : Math.min(available, total),
    swapTotalBytes: kb.get("SwapTotal") ?? null,
    swapFreeBytes: kb.get("SwapFree") ?? null,
  };
}

export interface LoadAvg {
  load1: number;
  load5: number;
  load15: number;
}

/** /proc/loadavg: "0.52 0.58 0.59 1/1234 5678". */
export function parseLoadavg(text: string): LoadAvg | null {
  const parts = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return { load1: parts[0], load5: parts[1], load15: parts[2] };
}

export interface CpuTimes {
  /** user+nice+system+idle+iowait+irq+softirq+steal (guest time is already in user/nice). */
  total: number;
  /** idle + iowait. */
  idle: number;
  ioWait?: number;
  /** Number of `cpuN` lines. */
  cpuCount: number;
}

/** First line of /proc/stat ("cpu  user nice system idle iowait irq softirq steal guest guest_nice"). */
export function parseProcStat(text: string): CpuTimes | null {
  let times: number[] | null = null;
  let cpuCount = 0;
  for (const line of text.split("\n")) {
    if (/^cpu\d+\s/.test(line)) cpuCount++;
    else if (/^cpu\s/.test(line)) {
      times = line.trim().split(/\s+/).slice(1).map(Number);
    }
  }
  if (!times || times.length < 4 || times.some((n) => !Number.isFinite(n))) return null;
  const t = [...times.slice(0, 8)];
  while (t.length < 8) t.push(0);
  const total = t.reduce((a, b) => a + b, 0);
  return { total, idle: t[3] + t[4], ioWait: times.length >= 5 ? t[4] : undefined, cpuCount };
}

export function ioWaitPercent(prev: CpuTimes | null, cur: CpuTimes): number | null {
  if (!prev || prev.ioWait === undefined || cur.ioWait === undefined) return null;
  const total = cur.total - prev.total;
  const wait = cur.ioWait - prev.ioWait;
  if (total <= 0 || wait < 0 || wait > total) return null;
  return Math.round(wait / total * 1000) / 10;
}

/** Busy share (0-100, one decimal) between two samples; null when not computable (first sample, counter reset). */
export function cpuUsagePercent(prev: CpuTimes | null, cur: CpuTimes): number | null {
  if (!prev) return null;
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0 || dIdle < 0 || dIdle > dTotal) return null;
  return Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10;
}

export interface NetDevCounters {
  rxBytes: number;
  rxPackets: number;
  rxErrors: number;
  rxDropped: number;
  txBytes: number;
  txPackets: number;
  txErrors: number;
  txDropped: number;
}

/** /proc/net/dev -> name -> counters. */
export function parseNetDev(text: string): Map<string, NetDevCounters> | null {
  const out = new Map<string, NetDevCounters>();
  let sawHeader = false;
  for (const line of text.split("\n")) {
    if (line.includes("|")) {
      sawHeader = true;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    if (!name || f.length < 16 || f.some((n) => !Number.isFinite(n))) continue;
    out.set(name, {
      rxBytes: f[0],
      rxPackets: f[1],
      rxErrors: f[2],
      rxDropped: f[3],
      txBytes: f[8],
      txPackets: f[9],
      txErrors: f[10],
      txDropped: f[11],
    });
  }
  return sawHeader || out.size ? out : null;
}

/**
 * Rate between two cumulative counter samples (per second).
 * - first sample (no prev) or dt <= 0 -> null
 * - counter went down -> a reset (interface re-created, driver reload) -> null
 *   for this sample. /proc/net/dev and sysfs statistics are 64-bit on 64-bit
 *   kernels, so a decrease is never treated as a wrap.
 */
export function counterRate(prev: number | null | undefined, cur: number | null, dtSec: number): number | null {
  if (prev === null || prev === undefined || cur === null || !(dtSec > 0)) return null;
  const delta = cur - prev;
  if (delta < 0) return null;
  return Math.round((delta / dtSec) * 10) / 10;
}
