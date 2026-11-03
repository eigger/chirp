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
