# chirp REST API (apiVersion 1)

The contract is defined in [`packages/shared/src/schema.ts`](../packages/shared/src/schema.ts). Every response satisfies the corresponding zod schema.

## Authentication

Two ways in:

| | How | Allowed on |
|---|---|---|
| **API key** | `Authorization: Bearer chp_...` (scheme case-insensitive) | data routes: `/status`, `/disks/:id`, `/history`, `/refresh`. This is what Home Assistant uses. |
| **Session** | `chirp_session` cookie from `POST /auth/login` or `POST /bootstrap/admin` | data routes **and** the session-only routes (`/auth/me`, `/auth/password`, `/admin/*`) |

- A present `Authorization` header decides a data request: a wrong key is `401` even next to a valid cookie.
- Session-only routes refuse any `Authorization` header with `403 {"error":"forbidden"}`, so the API key can never read or regenerate itself or touch the account.
- **CSRF:** every non-GET request that is not authenticated by a Bearer key (login, logout, bootstrap, password change, regenerate, cookie-authenticated `POST /refresh`) must send `X-Chirp-Csrf: 1`, else `403 {"error":"forbidden"}`. The cookie is also `SameSite=Strict`, and CORS (`CHIRP_CORS_ORIGINS`) never allows credentials or that header.
- Missing/invalid credentials: `401 {"error":"unauthorized"}` with `WWW-Authenticate: Bearer`.

### The API key

There is one key. It is `CHIRP_API_KEY` (at least 16 characters) when set, otherwise `<dataDir>/api-key` (mode 0600), generated on the first start. The key is never logged unless `CHIRP_PRINT_KEY=true`. The signed-in admin sees it under **Settings -> API key** and can regenerate it there; on the server use `node apps/server/dist/cli.js key show|rotate`. A regenerated or rotated key takes effect on the next request (the old key is `401` at once).

### Session cookie

`chirp_session=<random 256-bit token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`, plus `Secure` when the request came over HTTPS (`CHIRP_COOKIE_SECURE=auto`, the default; `X-Forwarded-Proto` counts only with `CHIRP_TRUST_PROXY=true`) or when `CHIRP_COOKIE_SECURE=true`. Sessions live in server memory (a restart signs everyone out), end after **12 h without a request** (sliding) and after **7 days** in any case, and all of them end when the password changes (in the dashboard or with `cli.js admin reset-password`).

### Login rate limiting

Failed credential checks (login, current password on a password change) are counted per client IP and per username. After 5 failures the next attempt must wait 1 s, then 2 s, 4 s, ... (capped at 15 min per IP and 60 s per username, so nobody can lock the admin out for long); while waiting, the password is not even checked: `429 {"error":"rate_limited","retryAfter":<s>}` with `Retry-After`. Failures are forgotten after 15 min or on success. Unknown user and wrong password give the same `401` and take the same time.

### First-run registration

While no admin account exists, `GET /bootstrap/status` returns `{"needsBootstrap":true}` and **the first visitor** can create the admin with `POST /bootstrap/admin`. Concurrent requests are serialized and the account file is created exclusively, so exactly one wins; every later call is `409 {"error":"conflict"}`. Create the account right after installing (or seed it with `CHIRP_ADMIN_USER` / `CHIRP_ADMIN_PASSWORD`).

**GET never triggers collection; it always returns the cache.**

## Errors

Every error body is `{"error": <code>}` (`ErrorResponse`); 429 adds `retryAfter`.

| Status | Body | Schema | When |
|---|---|---|---|
| 400 | `{"error":"bad_request"}` | `BadRequestResponse` | bad query parameters, malformed URL encoding, unparsable or invalid request body |
| 400 | `{"error":"password_mismatch"}` | `PasswordMismatchResponse` | password and confirmation differ (bootstrap, password change) |
| 400 | `{"error":"weak_password"}` | `WeakPasswordResponse` | new password shorter than 10 (or longer than 256) characters |
| 400 | `{"error":"invalid_credentials"}` | `InvalidCredentialsResponse` | wrong current password on `POST /auth/password` |
| 401 | `{"error":"unauthorized"}` | `UnauthorizedResponse` | missing or wrong API key / session; wrong username or password on login |
| 403 | `{"error":"forbidden"}` | `ForbiddenResponse` | API key on a session-only route; missing `X-Chirp-Csrf` header |
| 404 | `{"error":"not_found"}` | `NotFoundResponse` | unknown disk id or history metric, unknown `/api/*` path, non-GET request to an unknown path (also any path when no dashboard is installed) |
| 409 | `{"error":"conflict"}` | `ConflictResponse` | `POST /bootstrap/admin` once an admin exists; regenerating a key set by `CHIRP_API_KEY` |
| 429 | `{"error":"cooldown","retryAfter":<s>}` | `CooldownResponse` | `POST /refresh` within the cooldown; `Retry-After` header has the same seconds |
| 429 | `{"error":"rate_limited","retryAfter":<s>}` | `RateLimitedResponse` | too many failed logins / current-password checks |
| 5xx | `{"error":"internal_error"}` | `InternalErrorResponse` | unexpected server error (details are only logged) |

`ErrorCode` = `bad_request | unauthorized | not_found | cooldown | internal_error | forbidden | conflict | rate_limited | invalid_credentials | weak_password | password_mismatch`. Codes are only ever added; treat an unknown code like its HTTP status.

## Account and key endpoints

All bodies are JSON (`Content-Type: application/json`); schemas are in `schema.ts`.

| Method and path | Auth | Body | Success |
|---|---|---|---|
| `GET /api/v1/bootstrap/status` | none | | `200 {"needsBootstrap":bool}` |
| `POST /api/v1/bootstrap/admin` | none + CSRF | `{"username","password","passwordConfirm"}` | `201 {"username"}` + session cookie |
| `POST /api/v1/auth/login` | none + CSRF | `{"username","password"}` | `200 {"username"}` + session cookie |
| `POST /api/v1/auth/logout` | none + CSRF | | `204`, cookie cleared |
| `GET /api/v1/auth/me` | session | | `200 {"username"}` |
| `POST /api/v1/auth/password` | session + CSRF | `{"currentPassword","newPassword","newPasswordConfirm"}` | `204`; every session ends, the caller gets a new cookie |
| `GET /api/v1/admin/api-key` | session | | `200 {"key":"chp_...","source":"file"\|"env"}` |
| `POST /api/v1/admin/api-key/regenerate` | session + CSRF | | `200 {"key":"chp_..."}`; the old key is dead at once. `409` when `source` is `env` |

Usernames are 1-64 of `A-Z a-z 0-9 . _ @ -`; passwords 10-256 characters. Responses under `/api/v1` carry `Cache-Control: no-store`.

## GET /health  (no auth)

```json
{"status":"ok","version":"0.1.0"}
```

## GET /api/v1/status

`StatusSnapshot`: `apiVersion`, `instance`, `cpu`, `sensors[]`, `disks[]`. Example: [`packages/shared/fixtures/status.sample.json`](../packages/shared/fixtures/status.sample.json).

- A disk with `standby: true` shows the values of its last read (the disk is never woken up).
- `disk.health.status`: `ok | warning | failing | unknown`; `reasons[]` holds `{code, value?}`.
- `disk.error`: `open_failed | timeout | parse_error | null`. On an error the previous values are kept and health becomes `unknown`. `timeout` means smartctl ran past its time limit; output that is too large to buffer is a `parse_error`.
- `cpu`: on multi-socket hosts `packageTemp` is the hottest package, `maxTemp` the hottest package or core, `highTemp`/`critTemp` the lowest limit across packages, and core labels are prefixed with `Package <n> ` (see [`PROJECT.md`](PROJECT.md#cpu-temperature)).

### Disk IDs

- `disk.id` is `wwn_<hex>` (WWN) or a model+serial slug (`[a-z0-9_]+`). It is never `/dev/sdX`, and once assigned it does not change, even across restarts and while the disk sleeps: the server derives it without waking the disk and pins it.
- **Provisional IDs:** a disk that has never been read and whose identity could not be derived gets `dev_<device name>` with `lastReadAt: null`. That ID is replaced on the first successful read. Clients should not create long-lived entities for it.
- A `dev_` ID with a non-null `lastReadAt` is permanent (the disk reports no WWN, model or serial).
- `devicePath` is the configured path; `name` is display only and may change across reboots.

## GET /api/v1/disks/:id

`DiskDetail` = `Disk` + `raw` (the raw smartctl JSON). Unknown id: `404 {"error":"not_found"}`.

## GET /api/v1/history?metric=...&range=24h

- `metric`: `cpu.packageTemp` or `disk.<id>.temperature`
- `range`: `1h | 6h | 12h | 24h` (default `24h`)
- Response: `{"metric":"cpu.packageTemp","points":[[epochMs, value], ...]}`, 1-minute resolution, kept in server memory (reset on restart)
- Bad parameters `400 {"error":"bad_request"}`, unknown metric `404 {"error":"not_found"}`

## POST /api/v1/refresh

Requests an immediate re-collection (does not wait for it), including a re-discovery of devices when `CHIRP_DEVICES` is empty. Disks in standby are still not woken up.

- `202 {"queued":true}`
- Within 30 s of the last accepted request: `429 {"error":"cooldown","retryAfter":<seconds>}` (with a `Retry-After` header)

## Dashboard

`GET /` and `/assets/*` are public static files (SPA fallback); the data behind them needs a session. Nothing is served if `CHIRP_WEB_DIR` has no `index.html`. `/api` and `/health` paths never fall back to the dashboard.
