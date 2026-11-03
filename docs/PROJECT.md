# chirp project overview

Collects the CPU temperature and disk SMART health of a Proxmox host and serves them as a REST API and a web dashboard. The Home Assistant integration lives in a separate repository (hass-chirp, integration domain `chirp`).

## Layout

| Path | Role |
|---|---|
| `packages/shared` | zod API contract (`schema.ts`, `fixtures/status.sample.json`) |
| `apps/server` | Fastify server: collection -> in-memory cache -> REST + static dashboard |
| `apps/web` | Dashboard (static build) |
| `proxmox/` | One-shot LXC install and update |
| `scripts/package-release.sh` | Runtime tree for the tarball and the Docker image |
| `Dockerfile` | Single image (server + web + smartmontools) |

## Server internals (`apps/server/src`)

| File | Contents |
|---|---|
| `config.ts` | Environment -> `Config`; rejects invalid `CHIRP_PORT` / short `CHIRP_API_KEY` (`ConfigError`) |
| `apiKey.ts` | `chp_` key generation, sha256 + `timingSafeEqual` verification, picks up key-file changes |
| `keyNotice.ts` | Log line for a newly generated key (path + CLI hint; the key only with `CHIRP_PRINT_KEY=true`) |
| `instanceId.ts` | `CHIRP_DATA_DIR/instance-id` (UUIDv4) |
| `hwmon.ts` | `/sys/class/hwmon` parsing (coretemp/k10temp/zenpower/cpu_thermal), multi-socket merge, thermal_zone fallback, `/proc/cpuinfo` |
| `smartctl.ts` | Runs and parses `smartctl -j -a -n standby`, device discovery (`--scan`), the read-side ID rule |
| `diskIdentity.ts` | Stable disk IDs without waking the disk; pinned in `disk-ids.json` |
| `health.ts` | **The only** health logic |
| `scheduler.ts` | `Collector`: sensors 10 s / SMART 300 s, concurrency 2, keeps standby values, cached discovery |
| `history.ts` | 1-minute downsampled, 24 h in-memory ring buffer |
| `app.ts` / `static.ts` | REST routes, auth, cooldown, JSON error bodies / dashboard + SPA fallback |
| `index.ts` / `cli.ts` / `healthcheck.ts` | Server entry point / `key show|rotate` / container health probe |

## Health

- **failing**: `smart_status.passed=false`; NVMe `critical_warning` bit 0 (spare), 2 (reliability degraded), 3 (read-only), 4 (volatile memory backup failed); `available_spare < threshold`
- **warning**: reallocated / pending / offline-uncorrectable sectors > 0, `media_errors > 0`, wear >= 90 %, temperature >= limit (HDD 55 / SSD 70 / NVMe 75 °C, configurable)
- **unknown**: not read (`not_read`)
- NVMe bit 1 (temperature) is covered by `temperature_high`; bit 5 (persistent memory region read-only) is ignored.
- Every reason is listed in `reasons[]` as `{code, value}`.

## CPU temperature

One hwmon chip per CPU package on multi-socket hosts (e.g. two `coretemp` chips). All chips of the detected CPU driver are merged:

- `packageTemp` = the hottest package sensor (falls back to the hottest core)
- `maxTemp` = the hottest of all package and core sensors
- `highTemp` / `critTemp` = the lowest limit reported by any package (most conservative)
- `cores` = every core of every package in socket order. With more than one package each label is prefixed (`Package 1 Core 0`); single-socket labels are unchanged.

## Disk IDs and standby

`-n standby` makes a sleeping disk return immediately without measurements; the server keeps the previous values and only flips `standby: true`.

A disk that is asleep (or unreadable) from the start has no SMART identity yet. `diskIdentity.ts` gets the final ID without touching the disk, in this order:

1. the ID pinned in `<dataDir>/disk-ids.json`, keyed by a `/dev/disk/by-id/...` path (by-id names embed WWN/serial, so a key never moves to another disk; `/dev/sdX` paths are mapped to their by-id alias through the symlinks);
2. sysfs: for ATA disks the libata VPD-83 `wwid` (`naa.<wwn>` -> `wwn_<hex>`, `t10.ATA <model> <serial>` -> model+serial slug); for NVMe the controller's `model` + `serial`;
3. by-id link names: `wwn-0x…` next to an `ata-…` alias, `ata-<model>_<serial>`, `nvme-<model>_<serial>`.

These yield exactly what `smartctl.ts#diskId` produces from a read. Every ID handed out is pinned (atomic write), and a pinned ID wins over a later read that disagrees (logged once), so an ID never changes and history stays on one ID. Disks behind SAS HBAs or USB bridges are not derived (their smartctl ID cannot be predicted); they are pinned after their first read. Only when nothing is known does the disk get a provisional `dev_<name>` ID with `lastReadAt: null`, replaced on the first read.

## Device discovery

With `CHIRP_DEVICES` empty the server runs `smartctl --scan -j`, which globs device names without opening them (`--scan-open` sends commands to each device and can spin up a sleeping disk; opt in with `CHIRP_SCAN_MODE=scan-open`). The generic `-d scsi` type that `--scan` reports for `/dev/sdX` is dropped so smartctl auto-detects SAT on each read. The list is cached and refreshed at start, every `CHIRP_RESCAN_INTERVAL` seconds (default 3600) and on `POST /api/v1/refresh`.

## Security model

- `/health` and the static dashboard need no auth. All data under `/api/v1/*` needs the bearer key.
- A generated key is stored in the key file (0600) and not logged unless `CHIRP_PRINT_KEY=true`.
- Plain HTTP and a privileged LXC are assumed; see the security notes in the README and [`deploy.md`](deploy.md).
