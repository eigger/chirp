# Plan: reduce the privileged-LXC attack surface without losing features

Status: in progress. Phase 1 items 1.2, 1.3, 1.4 implemented; item 1.1 pending live PVE >= 8.1 host verification. Audience: the agent implementing it. Read `CLAUDE.md` first (schema-first, never wake a disk, English only, no new native dependencies).

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

Design first; implement only after the Phase 1 PRs land and the design is approved by the maintainer.

Idea: a **host-side read-only collector** feeds an unprivileged chirp container, so the container needs no device nodes, no cgroup rules, no `/host/sys`.

- Host component: a small script plus a systemd service/timer in `proxmox/host/` (no network listener, no dependencies beyond what Proxmox ships; shell + `smartctl -j`, or a prebuilt single file if a runtime is unavoidable). It runs as root on the host and writes a snapshot atomically (0644, tmp + rename) to `/run/chirp/host.json`:
  - SMART per disk via `smartctl -n standby -j` (same never-wake-a-disk rules as `smartctl.ts`; device discovery with `--scan`, no `--scan-open`), including the `wwn`/by-id data needed by `diskIdentity.ts`.
  - host `/proc/meminfo`, `/proc/stat`, `/proc/loadavg` content and per-interface `/sys/class/net` data (operstate, speed, counters).
  - hwmon/fans/voltages and RAPL if not already readable from inside the CT.
- Container side: bind-mount `/run/chirp` read-only; the container is created `unprivileged: 1`, with no `devN`, no device cgroup rules and no `/host/sys`. Add a snapshot-file reader beside `hostPaths.ts` and make `smartctl`/`netdev`/`hostMetrics` prefer it when `CHIRP_HOST_SNAPSHOT` is set; fall back to current behaviour otherwise (Docker and tarball users unaffected). The API contract in `schema.ts` does not change; values read from the snapshot report `scope: "host"`.
- The snapshot is untrusted input to the server: validate with a zod schema, bound its size, ignore stale files (age limit), and fail each section in isolation like the existing collectors.
- The collector is a new host-root trust boundary: keep it minimal, validate nothing it does not need, and document that it is the only code chirp runs as host root.
- Open questions for the maintainer: scripting language for the collector; update path (extend `proxmox/` update script vs separate package); migration of existing privileged installs (offer `chirp-passthrough.sh --unprivileged`, requires CT re-creation because `unprivileged` cannot be flipped in place); whether `POST /refresh` should trigger the collector (needs a socket or a trigger file; default: no, scheduler cadence only).

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
