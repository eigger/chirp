import type { Disk, HealthStatus, StatusSnapshot } from "@chirp/shared";

/**
 * The dashboard authenticates with the HttpOnly session cookie set by login
 * (it never sees or stores a credential itself). Every state-changing request
 * carries the CSRF header the server requires for cookie authentication.
 */
const CSRF_HEADER = "X-Chirp-Csrf";

/**
 * Mirrors MIN_PASSWORD_LENGTH in @chirp/shared (a test keeps them equal). Copied
 * rather than imported so the bundle does not pull in zod for one number.
 */
export const MIN_PASSWORD_LENGTH = 10;

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown = null,
  ) {
    super(`HTTP ${status}`);
  }
  get code(): string | null {
    const b = this.body as { error?: unknown } | null;
    return b && typeof b.error === "string" ? b.error : null;
  }
  get retryAfter(): number | null {
    const b = this.body as { retryAfter?: unknown } | null;
    return b && typeof b.retryAfter === "number" ? b.retryAfter : null;
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers[CSRF_HEADER] = "1";
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty body (204) */
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

// --- monitoring data ---
export const fetchStatus = () => request<StatusSnapshot>("/api/v1/status");
export const fetchDisk = (id: string) => request<Disk & { raw: unknown }>(`/api/v1/disks/${encodeURIComponent(id)}`);
export const fetchHistory = (metric: string, range = "24h") =>
  request<{ metric: string; points: [number, number][] }>(
    `/api/v1/history?metric=${encodeURIComponent(metric)}&range=${range}`,
  );
export const postRefresh = () => request<{ queued: true }>("/api/v1/refresh", { method: "POST" });

// --- account ---
export const fetchMe = () => request<{ username: string }>("/api/v1/auth/me");
export const fetchBootstrapStatus = () => request<{ needsBootstrap: boolean }>("/api/v1/bootstrap/status");
export const bootstrapAdmin = (username: string, password: string, passwordConfirm: string) =>
  request<{ username: string }>("/api/v1/bootstrap/admin", { method: "POST", body: { username, password, passwordConfirm } });
export const login = (username: string, password: string) =>
  request<{ username: string }>("/api/v1/auth/login", { method: "POST", body: { username, password } });
export const logout = () => request<null>("/api/v1/auth/logout", { method: "POST" });
export const changePassword = (currentPassword: string, newPassword: string, newPasswordConfirm: string) =>
  request<null>("/api/v1/auth/password", { method: "POST", body: { currentPassword, newPassword, newPasswordConfirm } });

// --- API key ---
export interface ApiKeyState {
  key: string;
  /** `env` = set by CHIRP_API_KEY on the server: read-only here. */
  source: "file" | "env";
}
export const fetchApiKey = () => request<ApiKeyState>("/api/v1/admin/api-key");
export const regenerateApiKey = () => request<{ key: string }>("/api/v1/admin/api-key/regenerate", { method: "POST" });

export type { HealthStatus };
