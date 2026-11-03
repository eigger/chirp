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
- `power` (host sysfs, so no `scope`): `packageWatts` + `packageSource` (`rapl`: sum of the RAPL `package-N` zones; `hwmon`: sum of the CPU hwmon chip's power readings, e.g. zenpower; `null` when neither exists), `sources[]` `{id, label, watts}` with every RAPL zone (`rapl_package_0`, `rapl_package_0_core`, `rapl_psys`, ...) and every hwmon `power*_input`/`power*_average` (`<chip>_<label>`). RAPL watts are `null` on the first sample. RAPL counters are root-only on Linux >= 5.10; unreadable sources are skipped silently. `power` is `null` when nothing is readable.
- `fans[]` `{id, chip, label, rpm}` (hwmon `fan*_input`) and `voltages[]` `{id, chip, label, volts}` (hwmon `in*_input`, mV -> V). `label` is the chip's label or `fanN`/`inN`; `id` is a chip+label slug with `_2`, `_3`, ... on duplicates. Empty arrays when the host exposes none. Values of a runtime-suspended GPU (hwmon name or driver amdgpu, radeon, nouveau, nvidia, i915, xe) are `null` rather than read, so chirp never wakes it; CPU and other chips are always read. On ZFS hosts `memory.usedPercent` includes the ARC (as in the Proxmox GUI).

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

`GET /` and `/assets/*` are public static files (SPA fallback). Nothing is served if `CHIRP_WEB_DIR` has no `index.html`. `/api` and `/health` paths never fall back to the dashboard.
