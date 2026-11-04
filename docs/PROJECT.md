# chirp project overview

Collects the CPU temperature, disk SMART health and host metrics (memory, load, network, power, fans, voltages) of a Proxmox host and serves them as a REST API and a web dashboard. The Home Assistant integration lives in a separate repository (hass-chirp, integration domain `chirp`).

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
| `config.ts` | Environment -> `Config`; rejects invalid `CHIRP_PORT` / short `CHIRP_API_KEY` / bad `CHIRP_ADMIN_*` / `CHIRP_COOKIE_SECURE` (`ConfigError`) |
| `apiKey.ts` | The single `chp_` API key: generation, sha256 + `timingSafeEqual` verification, picks up key-file changes, regenerate (file keys only) |
| `keyNotice.ts` | Log line for a newly generated key (path + dashboard/CLI hint; the key only with `CHIRP_PRINT_KEY=true`) |
| `admin.ts` / `password.ts` | The admin account in `admin.json` (exclusive create, atomic update, reloaded on change) / scrypt hashing (`node:crypto`) |
| `session.ts` / `rateLimit.ts` | In-memory sessions (12 h sliding, 7 d max) / exponential login backoff per IP and username |
| `auth.ts` / `bootstrap.ts` | Auth gate (Bearer key vs. session vs. public, CSRF header), account and key routes / start-up env seed and notices |
| `secureFile.ts` | 0600 atomic writes (temp + rename) and exclusive creates (temp + link) |
| `instanceId.ts` | `CHIRP_DATA_DIR/instance-id` (UUIDv4) |
| `hwmon.ts` | `/sys/class/hwmon` parsing (coretemp/k10temp/zenpower/cpu_thermal), multi-socket merge, thermal_zone fallback, `/proc/cpuinfo` |
| `hostPaths.ts` | Host roots (`CHIRP_HOST_PROC` / `CHIRP_HOST_SYS`), container detection, host-first reads with `scope` |
| `procfs.ts` | Pure parsers: `/proc/meminfo`, `/proc/loadavg`, `/proc/stat` (CPU usage), `/proc/net/dev`, counter rates (a decrease is a reset) |
| `netdev.ts` | `/sys/class/net` interfaces, kind classification, default filter + `CHIRP_NET_INCLUDE`/`EXCLUDE` |
| `power.ts` | RAPL powercap zones (energy -> watts, wrap), hwmon power/fans/voltages |
| `hostMetrics.ts` | `HostMetrics`: samples every section in isolation, keeps the previous sample for rates, logs a failure once |
| `smartctl.ts` | Runs and parses `smartctl -j -a -n standby`, device discovery (`--scan`), the read-side ID rule |
| `diskIdentity.ts` | Stable disk IDs without waking the disk; pinned in `disk-ids.json` |
| `health.ts` | **The only** health logic |
| `scheduler.ts` | `Collector`: sensors + host metrics 10 s / SMART 300 s, concurrency 2, keeps standby values, cached discovery |
| `history.ts` | 1-minute downsampled, 24 h in-memory ring buffer |
| `app.ts` / `static.ts` | REST routes, auth, cooldown, JSON error bodies / dashboard + SPA fallback |
| `envFile.ts` | The CLI's env file (`--env-file`, `CHIRP_ENV_FILE`, else `/etc/chirp/chirp.env`) |
| `index.ts` / `cli.ts` / `healthcheck.ts` | Server entry point / `key show\|rotate`, `admin reset-password\|show-user` / container health probe |

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

## Host metrics and scope

chirp normally runs in a privileged LXC. hwmon and powercap are host sysfs, so CPU temperatures, fans, voltages and RAPL power are the host's from inside the container too. `/proc/meminfo`, `/proc/stat` and `/proc/loadavg` are not: Proxmox enables lxcfs, which may replace them with the container's view (its memory limit, its CPUs), and `/sys/class/net` and `/proc/net/dev` belong to the container's network namespace.

- **Host roots.** Every `/proc` read for memory/load first tries `CHIRP_HOST_PROC` (default `/host/proc` if it exists), every interface read first tries `CHIRP_HOST_SYS` (default `/host/sys` if it exists), then falls back to the local `/proc` / `/sys`. A file that exists but does not parse (an empty placeholder left by a failed bind mount) falls back too.
- **Scope.** A value read from a separate host root is `host`. A value read from the local root is `host` outside a container and `container` inside one (detected via `/run/systemd/container`, `/.dockerenv`, `/run/.containerenv` or `container=` in PID 1's environment). The API carries `scope` on `memory`, `load` and `network`; the dashboard labels container-scope sections. An LXC without lxcfs would show host memory in its own `/proc` but is still labelled `container`: the label errs on the side of caution.
- **Installer mounts.** `chirp-passthrough.sh` bind-mounts the host's `/proc/meminfo`, `/proc/stat`, `/proc/loadavg` (files; these are not namespaced by the kernel) and, with `CHIRP_HOST_MOUNTS=all` (default), `/sys` (read-only, `nosuid,nodev,noexec`, non-recursive) to `/host/...` in the container; `proc` mounts only the files, `0` nothing. The `/sys` mount exposes the host sysfs read-only and the CT's path-based AppArmor `/sys` rules do not cover `/host/sys` (see [`deploy.md`](deploy.md#host-metrics-memory-load-network)). `/proc/net/dev` is not mounted: `/proc/net` resolves to the reading process's network namespace, so a bind mount would not reliably show the host. A sysfs mount instead keeps the network namespace it was created in, so the host's `/sys` mounted elsewhere lists the host's interfaces (`/host/sys/class/net/<if>/statistics/*`, `operstate`, `speed`). Without sysfs the server falls back to `<host proc>/1/net/dev` (PID 1's namespace, when the whole host `/proc` is mounted) and then the local `/proc/net/dev`.
- **Not verified on every setup.** The mounts are verified by the installer's smoke test (MemTotal compared between host and container, and one host-only interface (`vmbr*`, then `bond<N>`, then any real device absent from the container's own namespace) checked under `/host/sys/class/net`; "inconclusive" when there is none) and by the `scope` field at runtime; see the verification steps in [`deploy.md`](deploy.md#host-metrics-memory-load-network).
- **Rates.** CPU usage, network bytes/s and RAPL watts need two samples (`null` on the first) and use a monotonic clock (wall-clock steps do not distort them). A network counter that goes down, or an interface whose `ifindex` changed (re-created), is a reset: `null` for that sample (the counters are 64-bit, so a decrease is never read as a wrap). RAPL energy wraps at `max_energy_range_uj`. A change of scope discards the previous sample. A sample requested less than 2 s after the previous one (e.g. `POST /refresh` right after a tick) reuses the previous sample.
- **Cost.** Interfaces hidden by name (`tap*`, `veth*`, `fw*`, `CHIRP_NET_EXCLUDE`) are skipped before any of their files is read; the filter is built once and glob matching is linear (no RegExp backtracking), with at most 64 patterns of 64 characters. hwmon inputs of runtime-suspended GPUs (amdgpu, radeon, nouveau, nvidia, i915, xe by hwmon name or driver) are not read, so sampling never wakes them; their entries stay with `null` values. CPU chips (zenpower, k10temp, coretemp, ...) and other devices are always read, since with PCI runtime PM on `auto` they may report "suspended" too. Patterns beyond the CHIRP_NET_INCLUDE/EXCLUDE caps are logged once at start.
- **ZFS.** The ARC is not in `MemAvailable`, so `usedPercent` includes it (same basis as the Proxmox GUI); subtracting reclaimable ARC from `arcstats` is a possible future improvement.
- **Power priority.** `packageWatts` = sum of RAPL `package-N` zones (Intel, and AMD Zen via the same powercap driver); without RAPL the sum of a CPU hwmon chip's power readings (`zenpower`, `fam15h_power`, ...). Other hwmon power readings (GPUs, PSUs) only appear in `sources[]`.
- **Isolation.** Each section is read in its own `try`; a failure makes that section `null`/empty, is logged once until it recovers and never affects the CPU or SMART collection. Missing or unreadable files are not failures (no log). GET never triggers a read.
- **IDs.** Interface IDs are slugs of the name; hwmon power/fan/voltage IDs are chip+label slugs followed by a device-path/channel hash, independent of other sensors and `hwmonN` renumbering.

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

- `/health`, the static dashboard and `GET /api/v1/bootstrap/status` need no auth. All data under `/api/v1/*` needs the API key (Bearer) or an admin session (cookie).
- **One admin account** (`<dataDir>/admin.json`, 0600, scrypt N=32768 r=8 p=1 with a 16-byte salt). On Proxmox installations, the installer generates a one-time random setup token and writes `CHIRP_SETUP_TOKEN` to `/etc/chirp/chirp.env` (0600), requiring it for `POST /bootstrap/admin` (and attempting best-effort removal from the env file; under systemd `ProtectSystem=strict`, the token remains in the file harmlessly as bootstrap is permanently disabled once an admin exists). Retrieve it anytime before setup with `pct exec <CTID> -- grep -E '^CHIRP_SETUP_TOKEN=' /etc/chirp/chirp.env`. When `CHIRP_SETUP_TOKEN` is unset (Docker, manual installs), the account is created by the first visitor of the dashboard (first-run registration, like kibble), or seeded from `CHIRP_ADMIN_USER`/`CHIRP_ADMIN_PASSWORD`. While no admin exists and no token is configured, anyone who can reach the server can create it, so the installer and the server log say to do it right away. Registration is serialized in process and the file is created with an exclusive link(2), so two racing requests (or processes) can never both win.
- **Sessions** are random 256-bit tokens in an `HttpOnly; SameSite=Strict` cookie (`Secure` over HTTPS), kept in memory as sha256, 12 h idle / 7 d absolute, all ended by a password change or `cli.js admin reset-password` (the server notices admin.json changes).
- **CSRF:** SameSite=Strict plus a required `X-Chirp-Csrf: 1` header on state-changing requests that are not Bearer-authenticated. A cross-site page cannot set a custom header without a CORS preflight, which chirp never grants. Origin/Host comparison was not used because reverse proxies often rewrite `Host`.
- **Brute force** (`rateLimit.ts`, details and guarantees in [`api.md`](api.md#login-rate-limiting)):
  - Per-source backoff (IPv4 / IPv6 /64, capped at 15 min) always applies.
  - Username backoff (capped at 5 s) applies only to sources that already failed and never signed in as that user. A clean or known source is still checked, so a distributed attack cannot keep the admin out.
  - A daily per-username budget (`CHIRP_LOGIN_DAILY_BUDGET`, default 1000) caps distributed guessing. Once it is spent only known sources may try, until the window passes, a password reset, or a restart.
  - Attempts are counted before the scrypt check (parallel guesses are throttled) and refunded when the scrypt gate sheds them.
  - Same `401` and same work (a dummy scrypt) for an unknown user and a wrong password.
  - At most 2 scrypt hashes run at once (16 queued, plus 4 reserved for known sources and sessions; the rest get a quick 429).
  - scrypt parameters read from admin.json are capped (N <= 2^17, r <= 16, p <= 4).
- **Password rules:** 10-256 characters, plus a rule-based blocklist (`commonPassword.ts`). It catches breach-list base words with digits, symbols or leet substitutions, keyboard walks, sequences, repetition, the username, and chirp/admin words, which covers thousands of variants without shipping a word list. It applies to bootstrap, password change, `cli.js admin reset-password --password-stdin` and `CHIRP_ADMIN_PASSWORD`.
- **Client address:** the TCP peer, unless `CHIRP_TRUST_PROXY` names the proxies to believe. Recommended: the proxy's IP/CIDR list. A hop count or `true` believes `X-Forwarded-For` from any peer, so it is only safe when chirp is reachable only through the proxy. The server warns when either is combined with a wildcard bind.
- **The API key** (`CHIRP_API_KEY` or `<dataDir>/api-key`, 0600, generated on first start) is the only Bearer credential. The admin reads and regenerates it in Settings; the key itself can never call the account/key routes (`403`). It is not logged unless `CHIRP_PRINT_KEY=true`.
- **TLS and network transport:** By default chirp listens on plain HTTP, so credentials cross the network in clear text. Built-in TLS can be enabled by specifying `CHIRP_TLS_CERT` and `CHIRP_TLS_KEY` (paths to certificate and key; `cookieSecure` is derived as `true`). For production setups, a TLS reverse proxy (Caddy, nginx) or Tailscale is recommended. The bind address is controlled by `CHIRP_HOST` (e.g. `127.0.0.1` when placed behind a local reverse proxy).
- **Privileged LXC and host mounts:** A privileged LXC is assumed; its root is effectively host root. For host metrics, `CHIRP_HOST_MOUNTS=all` mounts the host `/sys` at `/host/sys`; users who do not want host sysfs in the container should choose `CHIRP_HOST_MOUNTS=proc`, which mounts only the host `/proc` files, showing the network section with `scope: "container"`.
