export const HISTORY_MAX_POINTS = 24 * 60;
const MINUTE = 60_000;

/** In-memory 1-minute-resolution ring buffers, 24h deep. Points are [epochMs, value]. */
export class History {
  private series = new Map<string, [number, number][]>();

  record(metric: string, value: number | null, at = Date.now()): void {
    if (value === null || !Number.isFinite(value)) return;
    const bucket = Math.floor(at / MINUTE) * MINUTE;
    let points = this.series.get(metric);
    if (!points) {
      points = [];
      this.series.set(metric, points);
    }
    const last = points[points.length - 1];
    if (last && last[0] === bucket) last[1] = value;
    else {
      points.push([bucket, value]);
      if (points.length > HISTORY_MAX_POINTS) points.shift();
    }
  }

  has(metric: string): boolean {
    return this.series.has(metric);
  }

  query(metric: string, rangeMs = 24 * 60 * MINUTE, now = Date.now()): [number, number][] {
    const from = now - rangeMs;
    return (this.series.get(metric) ?? []).filter(([t]) => t >= from).map(([t, v]) => [t, v]);
  }

  forget(prefix: string): void {
    for (const key of this.series.keys()) if (key.startsWith(prefix)) this.series.delete(key);
  }
}
