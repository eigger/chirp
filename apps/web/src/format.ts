import type { Disk, HealthStatus } from "@chirp/shared";

const SEVERITY: Record<HealthStatus, number> = { ok: 0, unknown: 1, warning: 2, failing: 3 };

/** Overall status = the worst disk; unknown when there are no disks. */
export function overallStatus(disks: Pick<Disk, "health">[]): HealthStatus {
  if (disks.length === 0) return "unknown";
  return disks.reduce<HealthStatus>(
    (worst, d) => (SEVERITY[d.health.status] > SEVERITY[worst] ? d.health.status : worst),
    "ok",
  );
}

/** First two serial characters + "****". */
export function maskSerial(serial: string | null): string {
  if (!serial) return "—";
  return serial.slice(0, 2) + "****";
}

export function formatBytes(n: number | null): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatUptime(sec: number | null): string {
  if (sec == null) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatTemp(t: number | null): string {
  return t == null ? "—" : `${Math.round(t)}°C`;
}

export function tempLevel(t: number | null, high: number | null, crit: number | null): "ok" | "warning" | "failing" | "unknown" {
  if (t == null) return "unknown";
  if (crit != null && t >= crit - 5) return "failing";
  if (high != null && t >= high - 10) return "warning";
  return "ok";
}

export function formatTime(iso: string | null, lang: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(lang === "ko" ? "ko-KR" : "en-US");
}

export function wearPercent(d: Disk): number | null {
  return d.nvme?.percentageUsed ?? d.ata?.wearLevelPercentUsed ?? null;
}

/** Binary units for memory sizes (GiB etc.). */
export function formatBytesIEC(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Throughput from bytes per second, shown in bits per second like link
 * speeds ("1.2 Mbit/s" next to "1 Gbit/s").
 */
export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null) return "—";
  const units = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s", "Tbit/s"];
  let v = bytesPerSec * 8;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Link speed in Mbit/s -> "1 Gbit/s", "2.5 Gbit/s", "100 Mbit/s". */
export function formatLinkSpeed(mbps: number | null | undefined): string {
  if (mbps == null || mbps <= 0) return "—";
  if (mbps >= 1000) {
    const g = mbps / 1000;
    return `${Number.isInteger(g) ? g.toFixed(0) : g.toFixed(1)} Gbit/s`;
  }
  return `${mbps} Mbit/s`;
}

export function formatPercent(p: number | null | undefined): string {
  return p == null ? "—" : `${p.toFixed(1)}%`;
}

export function formatWatts(w: number | null | undefined): string {
  return w == null ? "—" : `${w.toFixed(1)} W`;
}

export function formatVolts(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(3)} V`;
}

export function formatLoad(l: number | null | undefined): string {
  return l == null ? "—" : l.toFixed(2);
}

/** Bar level for a usage percentage. */
export function usageLevel(p: number | null | undefined): "ok" | "warning" | "failing" | "unknown" {
  if (p == null) return "unknown";
  if (p >= 95) return "failing";
  if (p >= 85) return "warning";
  return "ok";
}
