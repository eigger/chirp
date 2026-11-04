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

`chirp_session=<random 256-bit token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`, plus `Secure` when the request came over HTTPS (`CHIRP_COOKIE_SECURE=auto`, the default; `X-Forwarded-Proto` counts only when `CHIRP_TRUST_PROXY` trusts the proxy) or when `CHIRP_COOKIE_SECURE=true`. Sessions live in server memory (a restart signs everyone out), end after **12 h without a request** (sliding) and after **7 days** in any case, and all of them end when the password changes (in the dashboard or with `cli.js admin reset-password`).

### Login rate limiting

Applies to credential checks: `POST /auth/login` and the current password on `POST /auth/password`. A **source** is an IPv4 address or an IPv6 **/64**. Every attempt is recorded *before* the password is checked, so parallel guesses count too. An attempt that is never checked because the server is busy (see the end of this section) is not counted. A correct password clears the source's and the username's backoff and remembers the source as **known** for that username, in memory, until a restart.

| Mechanism | Applies to | Rule |
|---|---|---|
| Source backoff | every attempt | after 5 failures the source waits 1 s, 2 s, 4 s, ... doubling, **capped at 15 min**; forgotten 15 min after its last failure |
| Username backoff | only sources that already failed in the window and are not known for this username | after 5 failures on the username: 1 s, 2 s, 4 s, **capped at 5 s** |
| Daily budget | sources not known for this username | at most `CHIRP_LOGIN_DAILY_BUDGET` (default **1000**) failed attempts per username per rolling 24 h (hourly buckets); when spent, only known sources may try |

While a rule blocks an attempt, the password is not checked: the answer is `429 {"error":"rate_limited","retryAfter":<s>}` with `Retry-After`. Unknown user and wrong password give the same `401` and take the same time.

**The state machine for one username:**

- **Normal:** each source has its own backoff, and that is the only limit.
- **Username backoff active** (5+ recent failures on the name): a source with no recorded failure, or a known one, is still checked. A source that already failed must also wait out the username backoff (at most 5 s). Every checked guess spends budget.
- **Budget spent** (1000 failures in 24 h): only known sources are checked. Everyone else, including the real admin on a new address, gets 429 until failures age out of the window.
  - Recovery: wait; sign in from a known address; run `cli.js admin reset-password` (a credential change resets the username's budget and backoff); or restart the service (all limiter state is in memory).

**What this guarantees:**

- One source can test about 10 passwords in the first minute and about 15 in the first 20 minutes, then one per 15 min.
- A distributed attacker that keeps switching sources can test at most the daily budget per username (1000 per 24 h by default). Pair that with the password rules (at least 10 characters, common passwords refused) and online guessing is impractical.
- A sustained attack cannot keep out a source that signed in before. A clean source also gets in until the budget is spent.
- Sessions that are already signed in, the API key, Home Assistant and the CLI are never affected.

**What it does not guarantee:**

- Once the budget is spent, a new address (a phone on mobile data, say) cannot sign in until the window passes or the password is reset.
- A restart forgets which sources are known.

**Busy server:** password hashing (scrypt) runs at most 2 at a time, with up to 16 waiting plus 4 reserved queue places for known sources and signed-in sessions. Beyond that, login, bootstrap and password requests are answered at once with `429 {"error":"rate_limited","retryAfter":1}`, and such shed attempts are not counted against anyone.

**Behind a proxy**, the source is the TCP peer unless `CHIRP_TRUST_PROXY` names the proxy (see [`deploy.md`](deploy.md#security)). Without it, every client shares the proxy's address: one source backoff for everybody, so an attacker's failures make all users wait up to 15 min, and "known source" means "anyone behind the proxy".

### First-run registration

While no admin account exists, `GET /bootstrap/status` returns `{"needsBootstrap":true}` (plus `setupTokenRequired:true` when `CHIRP_SETUP_TOKEN` is configured) and **the first visitor** can create the admin with `POST /bootstrap/admin`. If `CHIRP_SETUP_TOKEN` is configured, `POST /bootstrap/admin` requires `setupToken` matching the token; an invalid or missing token responds with `403 {"error":"unauthorized"}` and is subject to the per-address rate limiter. Concurrent requests are serialized and the account file is created exclusively, so exactly one wins; every later call is `409 {"error":"conflict"}`. Create the account right after installing (or seed it with `CHIRP_ADMIN_USER` / `CHIRP_ADMIN_PASSWORD`).

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
| 403 | `{"error":"unauthorized"}` | `UnauthorizedResponse` | wrong or missing setup token on `POST /bootstrap/admin` when `CHIRP_SETUP_TOKEN` is configured |
| 404 | `{"error":"not_found"}` | `NotFoundResponse` | unknown disk id or history metric, unknown `/api/*` path, non-GET request to an unknown path (also any path when no dashboard is installed) |
| 409 | `{"error":"conflict"}` | `ConflictResponse` | `POST /bootstrap/admin` once an admin exists; regenerating a key set by `CHIRP_API_KEY` |
| 429 | `{"error":"cooldown","retryAfter":<s>}` | `CooldownResponse` | `POST /refresh` within the cooldown; `Retry-After` header has the same seconds |
| 429 | `{"error":"rate_limited","retryAfter":<s>}` | `RateLimitedResponse` | too many failed logins / current-password checks / invalid setup token attempts |
| 5xx | `{"error":"internal_error"}` | `InternalErrorResponse` | unexpected server error (details are only logged) |

`ErrorCode` = `bad_request | unauthorized | not_found | cooldown | internal_error | forbidden | conflict | rate_limited | invalid_credentials | weak_password | password_mismatch`. Codes are only ever added; treat an unknown code like its HTTP status.

## Account and key endpoints

All bodies are JSON (`Content-Type: application/json`); schemas are in `schema.ts`.

| Method and path | Auth | Body | Success |
|---|---|---|---|
| `GET /api/v1/bootstrap/status` | none | | `200 {"needsBootstrap":bool,"setupTokenRequired"?:bool}` |
| `POST /api/v1/bootstrap/admin` | none + CSRF | `{"username","password","passwordConfirm","setupToken"?:string}` | `201 {"username"}` + session cookie |
| `POST /api/v1/auth/login` | none + CSRF | `{"username","password"}` | `200 {"username"}` + session cookie |
| `POST /api/v1/auth/logout` | none + CSRF | | `204`, cookie cleared |
| `GET /api/v1/auth/me` | session | | `200 {"username"}` |
| `POST /api/v1/auth/password` | session + CSRF | `{"currentPassword","newPassword","newPasswordConfirm"}` | `204`; every session ends, the caller gets a new cookie |
| `GET /api/v1/admin/api-key` | session | | `200 {"key":"chp_...","source":"file"\|"env"}` |
| `POST /api/v1/admin/api-key/regenerate` | session + CSRF | | `200 {"key":"chp_..."}`; the old key is dead at once. `409` when `source` is `env` |

Usernames are 1-64 of `A-Z a-z 0-9 . _ @ -`; passwords 10-256 characters and not a common/guessable password (breach-list words with digits, symbols or letter substitutions, keyboard walks, sequences, repeated characters, the username or chirp/admin words). A rejected password gets `400 {"error":"weak_password","reason":"too_short"|"too_long"|"common"}`. Responses under `/api/v1` carry `Cache-Control: no-store`.

## GET /health  (no auth)

```json
{"status":"ok","version":"0.1.0"}
```

## GET /api/v1/status

`StatusSnapshot`: `apiVersion`, `instance`, `cpu`, `sensors[]`, `disks[]`, and the optional host metric sections `memory`, `load`, `network`, `power`, `fans[]`, `voltages[]`. Example: [`packages/shared/fixtures/status.sample.json`](../packages/shared/fixtures/status.sample.json).

- A disk with `standby: true` shows the values of its last read (the disk is never woken up).
- `disk.health.status`: `ok | warning | failing | unknown`; `reasons[]` holds `{code, value?}`.
- `disk.error`: `open_failed | timeout | parse_error | null`. On an error the previous values are kept and health becomes `unknown`. `timeout` means smartctl ran past its time limit; output that is too large to buffer is a `parse_error`.
- `cpu`: on multi-socket hosts `packageTemp` is the hottest package, `maxTemp` the hottest package or core, `highTemp`/`critTemp` the lowest limit across packages, and core labels are prefixed with `Package <n> ` (see [`PROJECT.md`](PROJECT.md#cpu-temperature)).

### Host metrics (memory, load, network, power, fans, voltages)

Added within apiVersion 1; **every one of these fields is optional** (older servers do not send them), so clients must treat a missing field as "not supported". Collected on the sensor interval (`CHIRP_SENSOR_INTERVAL`, 10 s); rates are computed against the previous sample.

- A section that could not be read at all is `null` (never an object full of nulls). Single unreadable values inside a section are `null`.
- **`scope`** (`memory`, `load`, `network`): `"host"` when the values come from the host (the `/host/proc` / `/host/sys` mounts, or chirp is not in a container), `"container"` when they come from the container's own `/proc` or network namespace. In an LXC the container view can be the container's limits (lxcfs: e.g. 512 MB of RAM) and its own `eth0`. Clients should show container-scope values as such. See [deploy.md](deploy.md#host-metrics-memory-load-network).
- `memory`: `totalBytes`, `availableBytes`, `usedBytes` (= total - available), `usedPercent`, `swapTotalBytes`, `swapUsedBytes`, `swapUsedPercent` (`null` when there is no swap).
- `load`: `load1`, `load5`, `load15`, `cpuCount` (`cpuN` lines in `/proc/stat`), `cpuUsagePercent` (busy share between the last two `/proc/stat` samples; `null` until there are two).
- `network.interfaces[]`: `id` (stable slug of the name, `[a-z0-9_]+`: `vmbr0.100` -> `vmbr0_100`), `name`, `kind` (`physical | bridge | bond | vlan | virtual`), `up` (operstate `up`, or `unknown` with carrier 1), `operState` (raw), `speedMbps` (`null` when unknown), cumulative `rxBytes`/`txBytes` (bytes since the interface was created; they restart from 0 when it is re-created, e.g. a guest `tap`/`veth` or a reloaded driver), `rxBytesPerSec`/`txBytesPerSec` (`null` on the first sample and after a counter reset: a counter that went down or an interface that was re-created), `rxErrors`, `txErrors`, `rxDropped`, `txDropped`. By default physical NICs, bonds, bridges and VLANs are listed; `veth*`, `tap*`, `fwbr*`, `fwpr*`, `fwln*`, `lo`, `docker*`, `br-*` and other virtual devices are hidden. `CHIRP_NET_INCLUDE` / `CHIRP_NET_EXCLUDE` (comma-separated globs with `*` and `?`, at most 64 of 64 characters) adjust this (exclude wins). Open vSwitch bridges/bonds without sysfs markers are classified by name (`vmbr*`, `bond*`). In the container view the container's own interfaces (e.g. `eth0`) are listed.
- `power` (host sysfs, so no `scope`): `packageWatts` + `packageSource` (`rapl`: sum of the RAPL `package-N` zones; `hwmon`: sum of the CPU hwmon chip's power readings, e.g. zenpower; `null` when neither exists), `sources[]` `{id, label, watts}` with every RAPL zone (`rapl_package_0`, `rapl_package_0_core`, `rapl_psys`, ...) and every hwmon `power*_input`/`power*_average` (`<chip>_<label>_<device/channel hash>`). RAPL watts are `null` on the first sample. RAPL counters are root-only on Linux >= 5.10; unreadable sources are skipped silently. `power` is `null` when nothing is readable.
- `fans[]` `{id, chip, label, rpm}` (hwmon `fan*_input`) and `voltages[]` `{id, chip, label, volts}` (hwmon `in*_input`, mV -> V). `label` is the chip's label or `fanN`/`inN`; `id` is a chip+label slug followed by a hash of the sysfs device path and channel. It stays the same when another sensor disappears or `hwmonN` is renumbered. Empty arrays when the host exposes none. Values of a runtime-suspended GPU (hwmon name or driver amdgpu, radeon, nouveau, nvidia, i915, xe) are `null` rather than read, so chirp never wakes it; CPU and other chips are always read. On ZFS hosts `memory.usedPercent` includes the ARC (as in the Proxmox GUI).

Fixtures: [`status.sample.json`](../packages/shared/fixtures/status.sample.json) (all sections, host scope), [`status.container-scope.json`](../packages/shared/fixtures/status.container-scope.json) (container scope, some values `null`), [`status.null-sections.json`](../packages/shared/fixtures/status.null-sections.json) (every section `null`), [`status.legacy.json`](../packages/shared/fixtures/status.legacy.json) (an older server: no host sections).

### Disk IDs

- `disk.id` is `wwn_<hex>` (WWN) or a model+serial slug (`[a-z0-9_]+`). It is never `/dev/sdX`, and once assigned it does not change, even across restarts and while the disk sleeps: the server derives it without waking the disk and pins it.
- **Provisional IDs:** a disk that has never been read and whose identity could not be derived gets `dev_<device name>` with `lastReadAt: null`. That ID is replaced on the first successful read. Clients should not create long-lived entities for it.
- A `dev_` ID with a non-null `lastReadAt` is permanent (the disk reports no WWN, model or serial).
- `devicePath` is the configured path; `name` is display only and may change across reboots.

## GET /api/v1/disks/:id

`DiskDetail` = `Disk` + `raw` (the raw smartctl JSON). Unknown id: `404 {"error":"not_found"}`.

## GET /api/v1/history?metric=...&range=24h

- `metric`: `cpu.packageTemp`, `disk.<id>.temperature`, `memory.usedPercent`, `load.cpuUsagePercent`, `load.load1`, `power.packageWatts`, `network.<interface id>.rx` / `network.<interface id>.tx` (bytes/s; the interface `id`, not its name)
- The fixed metrics always exist (empty `points` until there is data); `disk.*` and `network.*` only for a disk / interface that is currently listed
- `range`: `1h | 6h | 12h | 24h` (default `24h`)
- Response: `{"metric":"cpu.packageTemp","points":[[epochMs, value], ...]}`, 1-minute resolution, kept in server memory (reset on restart)
- Bad parameters `400 {"error":"bad_request"}`, unknown metric `404 {"error":"not_found"}`

## POST /api/v1/refresh

Requests an immediate re-collection (does not wait for it), including a re-discovery of devices when `CHIRP_DEVICES` is empty. Disks in standby are still not woken up.

- `202 {"queued":true}`
- Within 30 s of the last accepted request: `429 {"error":"cooldown","retryAfter":<seconds>}` (with a `Retry-After` header)

## Dashboard

`GET /` and `/assets/*` are public static files (SPA fallback); the data behind them needs a session. Nothing is served if `CHIRP_WEB_DIR` has no `index.html`. `/api` and `/health` paths never fall back to the dashboard.

## Additional host and storage metrics

These are additive fields in API version 1. Older snapshots remain valid.

- `sensors[].id`: stable device-path/channel hash for non-CPU hwmon temperature sensors. It survives label changes, peer removal and hwmon renumbering; older servers omit it. Runtime-suspended GPUs retain their ID with a null temperature without waking the GPU.
- `load.ioWaitPercent`: percentage of CPU time waiting for I/O between two `/proc/stat` samples, with the same scope as `load`. Null on the first sample, a scope change, a missing I/O counter or a counter reset. Linux I/O wait is a diagnostic CPU-time measure, not disk utilization.
- `filesystems`: optional/null array of `{id, path, scope, totalBytes, usedBytes, availableBytes, usedPercent}`. Enable with `CHIRP_FILESYSTEM_PATHS=/,/data` (at most 32 absolute paths). `usedBytes` excludes free blocks; `availableBytes` excludes reserved blocks. Usage is `used / (used + available)`, like `df`. An unreadable path retains its ID and null values.
- `zfsPools`: optional/null array of `{id, name, health, totalBytes, usedBytes, freeBytes, usedPercent}`. Enable with `CHIRP_ZFS_ENABLED=true`; the GUID is the stable ID even if the pool is renamed. Reads `zpool list -Hp -o guid,name,health,size,allocated,free`, without a shell, with a five-second timeout and 1 MiB output limit. Unknown sizes remain null. Pool free bytes are raw pool space, not dataset available space.

Storage is cached asynchronously, at most once every 60 seconds. GET never triggers collection. Disabled/failed ZFS collection is null; a successful query with no pools is `[]`. Filesystem failures do not affect ZFS, CPU, network or SMART data. Filesystem statistics run in separate Node processes (at most two live workers), protecting the server's libuv pool from stalled mounts. Both collectors have a five-second response deadline and send SIGKILL on timeout. Pending work is reused until the actual process exits, so an unkillable worker cannot accumulate replacements.

In a container, filesystem paths refer to that container and report `scope: container`. To read host paths, explicitly bind the host root read-only at `/host/root` and set `CHIRP_HOST_ROOT=/host/root`; configured paths are then resolved under it with `scope: host`, with no fallback to the container. Symlinks resolving outside the mounted host root are rejected and reported as null values. No mounts or privileges are added automatically. ZFS requires `zpool` and access to the relevant host devices; opt in only on deployments where these already exist. No pool modification commands are run.

The ZFS columns and flags follow the [OpenZFS zpool-list manual](https://openzfs.github.io/openzfs-docs/man/v2.2/8/zpool-list.8.html).
