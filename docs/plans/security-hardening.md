# Plan: reduce the privileged-LXC attack surface without losing features

Status: completed. Phase 1 (1.1 exact devN: passthrough with PVE >= 8.1 detection and legacy fallback, 1.2 setup token, 1.3 built-in TLS, 1.4 docs) and Phase 2 (host collector, snapshot schema, server ingestion, unprivileged LXC support) fully implemented. Audience: the agent maintaining it. Read `CLAUDE.md` first (schema-first, never wake a disk, English only, no new native dependencies).

## Problem

chirp normally runs in a **privileged** LXC, so a compromise of the chirp process is a compromise of the Proxmox host. Findings, by severity:

| # | Finding | Where |
|---|---|---|
| 1 | Privileged container: root in the CT is effectively host root | `proxmox/install/chirp-install.sh` |
| 2 | `lxc.cgroup2.devices.allow: b <major>:* rw` also opens unselected disks, including the host boot disk | `proxmox/install/chirp-passthrough.sh` (`CHIRP_DEV_PERM`, ~l.42-50, ~l.215) |
| 3 | Plain HTTP: password, session cookie and API key cross the LAN in clear text | `apps/server/src/index.ts` (`app.listen`) |
| 4 | First-run registration is open to whoever reaches the server first | `apps/server/src/auth.ts` (`POST /bootstrap/admin`), `bootstrap.ts` |
| 5 | Default `CHIRP_HOST_MOUNTS=all` mounts the host `/sys` at `/host/sys`; AppArmor's path-based `/sys/**` write deny does not cover it | `chirp-passthrough.sh` (~l.200-203) |
| 6 | Static Bearer API key, no scope or expiry | `apiKey.ts` (low; out of scope here) |

Dead ends (do not retry): plain unprivileged LXC (SATA SG_IO and NVMe admin ioctls need `CAP_SYS_RAWIO`/`CAP_SYS_ADMIN` in the initial user namespace, so SMART breaks); `lxc.cap.drop: sys_admin` (NVMe SMART needs it); mounting only `/sys/class/net` (entries are symlinks into `/sys/devices`); relying on a `ro` bind mount (root with `CAP_SYS_ADMIN` can remount it).

## Phase 1 - no functional loss, small changes

Ship as one PR per item (`feat:`/`fix:` prefixes). Each item keeps current behaviour as the default unless noted.

### 1.1 Exact per-device passthrough (fixes #2)

Replace the major wildcard with Proxmox `devN:` entries.

- Hypothesis to verify FIRST, on a real PVE >= 8.1 host: `dev0: /dev/disk/by-id/wwn-...` makes PVE create the node in the CT and allow exactly that device's current `major:minor`, resolved on every CT start. If this does not hold (older PVE, or the rule is a wildcard or `rwm`), stop and report; keep the current behaviour and document the limit.
- If it holds: in `chirp-passthrough.sh` write one `devN:` line per selected disk instead of `lxc.cgroup2.devices.allow` + `lxc.mount.entry` for disks. Keep host-metric `lxc.mount.entry` lines unchanged.
- Migration: re-running the script must remove chirp's old `b <major>:*` rules and by-id `lxc.mount.entry` lines (ownership is tracked in `/var/lib/chirp-passthrough/<CTID>.majors`; keep that file's semantics for cleanup of old installs) and write `devN` instead. `devN` index allocation must not collide with user-defined `devN` lines.
- Gate on PVE version: below 8.1, keep the legacy behaviour and print a warning.
- Update the line-ownership/recognition awk, the `check-proxmox.sh` passthrough tests, and add fixtures for: fresh install, migration from wildcard config, user-owned `devN`, snapshot sections, CRLF refusal (existing behaviour).
- Unknown: whether `devN` also sets `rwm`; if so document it (exact device, so `m` is harmless) and drop `CHIRP_DEV_PERM` or keep it as a legacy-only knob.
- **Boot resilience constraint:** Proxmox LXC `devN:` entries do not have an `optional` flag (unlike `bind,optional`). If a disk goes missing or dies, Proxmox refuses to boot the CT. Because a monitoring container must stay online precisely when a disk fails, `legacy` mode (`bind,optional`) remains the default (`CHIRP_DEV_PASSTHROUGH=legacy`), while `dev` mode is available as an opt-in on PVE >= 8.1.
- Ownership and preservation: Chirp only owns `devN` entries targeting chirp-managed disks without user options (e.g., `,gid=`, `,mode=`). User wildcard cgroup rules and user-defined `devN` entries (including pending entries in `[pve:pending]`) are preserved. Managed disk by-ids and majors are tracked in `/var/lib/chirp-passthrough/<CTID>.disks` and `.majors`.

### 1.2 Setup token for first-run registration (fixes #4)

- The installer generates a random one-time token and writes `CHIRP_SETUP_TOKEN` to the CT's `chirp.env` (0600) and prints it once at the end of the install output. It is never logged by the server.
- `POST /bootstrap/admin` requires it while `CHIRP_SETUP_TOKEN` is set: add an optional `setupToken` field to `BootstrapAdminRequest` in `packages/shared/src/schema.ts` (adding a field is compatible; no `API_VERSION` bump), compare in constant time, and answer `403`/`unauthorized` on mismatch. `GET /bootstrap/status` gains optional `setupTokenRequired: boolean` so the dashboard shows the extra input (add `ko` strings to `apps/web/src/i18n.ts`).
- When `CHIRP_SETUP_TOKEN` is unset (Docker, manual installs, existing installs) behaviour is unchanged, including `CHIRP_ADMIN_USER`/`CHIRP_ADMIN_PASSWORD` seeding.
- The token is useless once an admin exists; remove it from `chirp.env` after the admin is created (best effort, atomic rewrite via the existing `envFile.ts`/`secureFile.ts`; under systemd `ProtectSystem=strict`, `/etc/chirp` is read-only so the token remains in the file harmlessly as `POST /bootstrap/admin` returns `409 conflict` once an admin exists; deletion failure logs a warning without leaking the token).
- Update the `bootstrap.ts` warning text, rate-limit the token attempts through the existing limiter, add tests (missing, wrong, correct, unset, admin already exists) and `scripts/ci/smoke-release.sh` coverage.

### 1.3 Optional built-in TLS and bind control (fixes #3 partially)

- New env vars: `CHIRP_TLS_CERT` and `CHIRP_TLS_KEY` (paths; both or neither, otherwise `ConfigError`). When set, Fastify listens with `https`; `cookieSecure` is derived accordingly. `CHIRP_HOST` already controls the bind address (default `0.0.0.0`); document it.
- Default stays plain HTTP, so nothing breaks. Add the vars to `.env.example`, `docs/deploy.md`, `docs/ko/deploy.md`, and have `healthcheck.ts` use the right scheme.
- Do not generate or fetch certificates in the server; document a reverse proxy or Tailscale as the recommended path.

### 1.4 Docs

Update `docs/PROJECT.md` (security section), `docs/deploy.md` and `docs/ko/deploy.md` to match 1.1-1.3 and to recommend `CHIRP_HOST_MOUNTS=proc` for users who do not want host sysfs in the CT, with the consequence (network shown with `scope: "container"`).

## Phase 2 - remove the need for privilege (fixes #1 and #5)

### 2.1 Overview & Architecture

An unprivileged chirp container (`unprivileged: 1`) runs with no host device nodes (`devN:` or `/dev/sd*`), no `lxc.cgroup2.devices.allow` rules, and no `/host/sys` bind-mount. Instead, a host-side collector running as root gathers read-only snapshots and writes them atomically to `/run/chirp/host.json`. The host directory `/run/chirp` is bind-mounted read-only into the container.

```
+-------------------------------------------------------------------+
| Proxmox Host (root)                                               |
|                                                                   |
| [ chirp-collector (Python 3, stdlib only) ]                       |
|   - smartctl --scan & smartctl -a -j -n standby (never wake disk) |
|   - /proc/meminfo, /proc/stat, /proc/loadavg                      |
|   - /sys/class/net/* & /sys/class/hwmon/*                         |
|      |                                                            |
|      v (atomic tmp + rename, mode 0644)                           |
|   /run/chirp/host.json                                            |
+------------------------------+------------------------------------+
                               | (bind-mount :ro)
+------------------------------v------------------------------------+
| Unprivileged LXC (chirp server)                                   |
|                                                                   |
|   /run/chirp/host.json (CHIRP_HOST_SNAPSHOT)                      |
|      |                                                            |
|      v (HostSnapshot zod validation, size & staleness checks)     |
|   [ hostSnapshot.ts ]                                             |
|      |                                                            |
|      +---> smartctl.ts (disk metrics & health)                    |
|      +---> hostMetrics.ts (mem, load, net, power, hwmon)          |
|      +---> scheduler.ts (serves snapshot with scope: "host")      |
+-------------------------------------------------------------------+
```

### 2.2 Host Collector Design (`proxmox/host/chirp-collector.py`)

- **Language & Runtime:** Python 3 using standard library only (`json`, `subprocess`, `os`, `sys`, `time`, `pathlib`, `glob`). Proxmox VE (Debian) ships with Python 3 out of the box. No external dependencies, no `pip`, no `jq` required.
- **Privilege:** Runs as host `root` via systemd. No network listener, no interactive inputs, strictly read-only hardware inspection.
- **Collection Cadence:**
  - Sensor & host metrics (procfs, netdev, hwmon, rapl): sampled every 10 seconds.
  - SMART readouts: sampled every 300 seconds (5 minutes) using `smartctl -a -j -n standby`. Uses `smartctl --scan` for discovery (never `--scan-open`). Standby exit code 2 is preserved so disks in standby are never woken.
- **Execution Modes:**
  - Daemon mode: `chirp-collector.py --daemon` (runs loop, handles SIGTERM/SIGINT cleanly, writes snapshot every 10s with 300s SMART intervals).
  - One-shot mode: `chirp-collector.py --once [--smart]` (for debugging or cron/systemd timer).
- **Atomic Output:**
  - Directory: `/run/chirp` (created mode 0755 if missing).
  - Writes to `/run/chirp/host.json.tmp.<pid>`, flushes, and renames atomically with `os.replace` to `/run/chirp/host.json` (mode 0644).

### 2.3 Snapshot Schema (`HostSnapshot`)

The snapshot is treated as untrusted input by the container. Defined in shared schema:
- `version`: integer schema version (starts at 1).
- `timestamp`: monotonic epoch milliseconds when the snapshot was written.
- `host`: `{ hostname: string, kernel: string, uptimeSeconds: number }`.
- `proc`:
  - `meminfo`: raw string of `/proc/meminfo` (parsed by existing `parseMeminfo`).
  - `stat`: raw string of `/proc/stat` (parsed by existing `parseProcStat`).
  - `loadavg`: raw string of `/proc/loadavg` (parsed by existing `parseLoadavg`).
- `net`: list of interface objects:
  - `name`, `operstate`, `speed`, `type`, `statistics` (`rx_bytes`, `tx_bytes`, `rx_errors`, `tx_errors`, `rx_dropped`, `tx_dropped`).
- `hwmon`:
  - `cpuModel`: string or null.
  - `chips`: list of `{ name: string, path: string, temps: [...], fans: [...], voltages: [...], power: [...] }`.
  - `rapl`: list of `{ name: string, energyUj: number, maxEnergyRangeUj: number }`.
- `smart`:
  - `collectedAt`: timestamp ms of the last SMART run.
  - `devices`: list of `{ devicePath: string, type: string | null, byIds: string[], wwn: string | null, smartctl: Record<string, unknown> }`.

### 2.4 Container-Side Ingestion (`hostSnapshot.ts`)

- **Configuration:** `CHIRP_HOST_SNAPSHOT` points to snapshot file path (default: `/run/chirp/host.json` if present; fallback to direct reading if absent).
- **Validation & Security Guards:**
  - Max file size bound (e.g. 10 MB limit) to prevent memory exhaustion attacks.
  - Staleness limit: snapshot older than `CHIRP_SNAPSHOT_MAX_AGE_SEC` (default 60s) is flagged as stale; if stale, a warning is logged and metrics indicate degradation.
  - Section isolation: invalid or missing sections (`proc`, `net`, `hwmon`, `smart`) fail independently without crashing the server.
- **Metric Scoping:** All metrics derived from the snapshot report `scope: "host"`.
- **Standby & Health:** Disk health evaluation remains strictly in `health.ts` using data parsed through `parseSmartctl()`.

### 2.5 Proxmox Integration & Packaging

- `proxmox/host/chirp-collector.py`: the host collection script.
- `proxmox/host/chirp-collector.service`: systemd unit (`Type=simple`, `ExecStart=/usr/local/bin/chirp-collector --daemon`, `Restart=always`).
- `proxmox/ct/chirp.sh`:
  - Introduces unprivileged container option: `var_unprivileged=1`.
  - Configures container mount entry: `mp0: /run/chirp,mp=/run/chirp,ro=1` (or `lxc.mount.entry: /run/chirp run/chirp none bind,ro,create=dir 0 0`).
  - Automatically installs/enables host collector service if not already present.
- `proxmox/install/update.sh`:
  - Updates container server as usual.
  - Provides a check/notice if host collector version is out of sync.

### 2.6 Implementation Tasks & PR Breakdown

1. **PR 2.1 - Shared Schema & Host Snapshot Reader (Completed in PR #8):**
   - Define `HostSnapshot` zod schema in `packages/shared/src/schema.ts`.
   - Implement `apps/server/src/hostSnapshot.ts` with size bound (10 MB limit), staleness check, error isolation.
   - Wire `CHIRP_HOST_SNAPSHOT` config in `apps/server/src/config.ts`.
   - Comprehensive tests for valid, malformed, oversize, and stale snapshots.
2. **PR 2.2 - Server Collector Integration (Completed in PR #8):**
   - Adapt `scheduler.ts`, `smartctl.ts`, `hostMetrics.ts`, and `hwmon.ts` to source data from `hostSnapshot` when available.
   - Maintain 100% backward compatibility with direct read mode (Docker / bare metal / privileged LXC).
3. **PR 2.3 - Host Collector Script & Systemd Unit (Completed in PR #8):**
   - Implement `proxmox/host/chirp-collector.py` (Python 3 stdlib, atomic write, safe smartctl execution).
   - Unit/integration tests for the collector script against mock sysfs/procfs and mock smartctl.
   - Add `chirp-collector.service`.
4. **PR 2.4 - Proxmox Scripts & Unprivileged CT Support (Completed in PR #8):**
   - Update `proxmox/ct/chirp.sh` and `proxmox/install/chirp-passthrough.sh` to support unprivileged mode with `/run/chirp` mount.
   - Update documentation (`docs/deploy.md`, `docs/ko/deploy.md`, `docs/PROJECT.md`).

### 2.7 Review Iterations & Hardening Fixes (PR #8)

During peer review cycles for PR #8, several critical edge cases and failure modes were uncovered and hardened prior to merge:

1. **Schema Nullability & Resilience:**
   - `hwmon.cpu` made nullable/optional: prevents total snapshot rejection on hosts without standard CPU hwmon chips.
   - `HostSnapshotSmartDevice.smartctl` made nullable/optional: if `smartctl` fails on an individual drive, valid disks are preserved and the server handles open failures gracefully rather than rejecting the entire snapshot.
2. **SMART Failing Disks (Never Discard Diagnostics):**
   - `smartctl` exit codes with bit 3 (DISK FAILING) or bit 6 (device error log) contain valid JSON diagnostics. The collector parses JSON across all non-zero exit codes whenever valid output is returned, ensuring chirp detects and alerts on failing disks instead of falling back to empty open failures.
3. **Staleness & Clock Skew Guard:**
   - Ingestion tracks `stale` state; if the host collector stops or dies, stale metrics are served with degradation warnings without advancing SMART collection timestamps using container clock.
   - Network rate and RAPL power calculations use snapshot sample timestamps (`sampleAt`) rather than mixing container wall-clock time, avoiding false 0 W readings or rate spikes.
4. **Boot Ordering & Host Inode Preservation:**
   - `chirp-collector.service` configured with `RuntimeDirectory=chirp`, `RuntimeDirectoryPreserve=yes` to ensure `/run/chirp` is recreated on boot without destroying the directory inode across daemon restarts (which would detach LXC bind mounts).
   - Added `Before=pve-guests.service` so onboot containers never start before `/run/chirp` exists.
5. **Collector Download & Release Fallback:**
   - Installer queries `/opt/chirp/current/package.json` for installed version; if release tags 404 (e.g. v0.2.0 lacks `proxmox/host/`), it gracefully falls back to `master`.
6. **hwmon Parity with Direct Read:**
   - Stable sensor IDs: `chirp-collector.py` generates `temp_${sha256(key/name/tempN)[:16]}` IDs identical to `hwmon.ts` (#7).
   - Sysfs label whitespace trimming: `hwmon_label` trims whitespace matching TypeScript `readText()?.trim() || fallback`.
   - CPU package priority: selects `Package id N` > `Tdie` > `Tctl` > `Package` to prevent AMD Ryzen +10~20°C Tctl offsets.
   - Dual-socket AMD socket fallback: falls back to `Package {chip_order}` when multiple sockets lack sysfs package IDs.
   - Idle GPU protection: checks runtime PM status and skips `temp_max`/`temp_crit` reads on suspended GPUs (PCI D3) to prevent waking them up.
7. **Atomic Host Environment:**
   - `/etc/chirp/chirp.env` is written using `mktemp` with `chmod 0600` before atomic `mv -f` to prevent permission race conditions.

### 2.8 Current Status & Next Steps

- **PR #8 Status:** Merged into `master` via commit `3561970`. All CI suites (`lint`, `build`, `test`, `proxmox`) passing.
- **Default Container Mode:** `var_unprivileged=0` (privileged) remains the default in `proxmox/ct/chirp.sh` until release `v0.3.0` is tagged, ensuring one-liner installs do not fail against older release tarballs (v0.2.0). Unprivileged mode is opt-in via `var_unprivileged=1`.
- **v0.3.0 Release Roadmap:**
  1. Extend `chirp-collector.py` to collect host filesystem / ZFS pool metrics for unprivileged containers (Implemented in current PR).
  2. Cut `v0.3.0` release tag containing Phase 2 collector assets and server snapshot ingestion.
  3. Flip `var_unprivileged=1` as the default in `proxmox/ct/chirp.sh` and update deploy documentation.

## Verification

- `npm run build:shared && npm run build -w @chirp/server && npm test -w @chirp/server && npm run lint -w @chirp/server`
- `bash scripts/ci/check-proxmox.sh` (shellcheck, syntax, passthrough and `update.sh` tests; extend for 1.1)
- `SMOKE_PORT=18090 bash scripts/ci/smoke-release.sh .` (extend for the setup token and TLS)
- Manual on a real Proxmox host (record results in the PR): `pct config <CTID>` before/after, confirm only selected disks are reachable from the CT (`ls`/`smartctl` on an unselected disk must fail), reboot the host and confirm by-id disks still map to the right devices, confirm a standby disk stays in standby across a collection cycle.

## Rules for the implementer

- Schema first: any new request/response field goes into `packages/shared/src/schema.ts` before the server or web uses it.
- English everywhere except `README.ko.md`, `docs/ko/` and the `ko` dictionary in `apps/web/src/i18n.ts`.
- Never log a password, setup token, session token or API key.
- Do not commit to `master`; use a branch and the repo's commit prefixes. `git pull` before starting.
- Do not weaken existing protections (0600 credential files, session-only routes, CSRF header, never wake a disk).
