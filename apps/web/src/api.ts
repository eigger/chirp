import type { Disk, HealthStatus, StatusSnapshot } from "@chirp/shared";

const KEY = "chirp.apiKey";

export function getKey(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
export function setKey(key: string): void {
  try {
    sessionStorage.setItem(KEY, key);
  } catch {
    /* ignore */
  }
}
export function clearKey(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown = null,
  ) {
    super(`HTTP ${status}`);
  }
  get retryAfter(): number | null {
    const b = this.body as { retryAfter?: unknown } | null;
    return b && typeof b.retryAfter === "number" ? b.retryAfter : null;
  }
}

async function request<T>(path: string, key: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const fetchStatus = (key: string) => request<StatusSnapshot>("/api/v1/status", key);
export const fetchDisk = (key: string, id: string) =>
  request<Disk & { raw: unknown }>(`/api/v1/disks/${encodeURIComponent(id)}`, key);
export const fetchHistory = (key: string, metric: string, range = "24h") =>
  request<{ metric: string; points: [number, number][] }>(
    `/api/v1/history?metric=${encodeURIComponent(metric)}&range=${range}`,
    key,
  );
export const postRefresh = (key: string) =>
  request<{ queued: true }>("/api/v1/refresh", key, { method: "POST" });

export type { HealthStatus };
