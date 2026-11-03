# chirp REST API (apiVersion 1)

The contract is defined in [`packages/shared/src/schema.ts`](../packages/shared/src/schema.ts). Every response satisfies the corresponding zod schema.

## Authentication

`/api/v1/*` requires `Authorization: Bearer chp_...` (the scheme is case-insensitive). On failure:

```
401 {"error":"unauthorized"}      (WWW-Authenticate: Bearer)
```

The key is generated on the first start or set with `CHIRP_API_KEY` (at least 16 characters). Read or rotate it with `node apps/server/dist/cli.js key show|rotate`.

**GET never triggers collection; it always returns the cache.**

## Errors

Every error body is `{"error": <code>}` (`ErrorResponse`); 429 adds `retryAfter`.

| Status | Body | Schema | When |
|---|---|---|---|
| 400 | `{"error":"bad_request"}` | `BadRequestResponse` | bad query parameters, malformed URL encoding, unparsable request body |
| 401 | `{"error":"unauthorized"}` | `UnauthorizedResponse` | missing or wrong API key |
| 404 | `{"error":"not_found"}` | `NotFoundResponse` | unknown disk id or history metric, unknown `/api/*` path, non-GET request to an unknown path (also any path when no dashboard is installed) |
| 429 | `{"error":"cooldown","retryAfter":<s>}` | `CooldownResponse` | `POST /refresh` within the cooldown; `Retry-After` header has the same seconds |
| 5xx | `{"error":"internal_error"}` | `InternalErrorResponse` | unexpected server error (details are only logged) |

`ErrorCode` = `bad_request | unauthorized | not_found | cooldown | internal_error`.

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

`GET /` and `/assets/*` are public static files (SPA fallback). Nothing is served if `CHIRP_WEB_DIR` has no `index.html`. `/api` and `/health` paths never fall back to the dashboard.
