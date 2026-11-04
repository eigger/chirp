# chirp deployment guide

[한국어](ko/deploy.md)

## Requirements

- Linux host (Proxmox VE recommended), Node.js 24, `smartmontools`
- Port 80 (change with `CHIRP_PORT`, an integer 1-65535)
- Access to the host's block devices and `/sys` (plus the host's `/proc` files for memory/load; see below)

## 1. Proxmox one-liner

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
```

Creates a privileged LXC container by default (`var_unprivileged=0`) for compatibility with current release tarballs. To use an unprivileged LXC with the host-side reader daemon (`chirp-collector`) writing to `/run/chirp/host.json` (no device nodes or host sysfs mounts required inside the container), set `var_unprivileged=1`. The default will change after a release containing the host collector is available. Script details are in `proxmox/`.

**Right after installing, open `http://<container IP>/` and create the admin account** (username, password twice, and the one-time `Setup token` printed during installation). The installer writes `CHIRP_SETUP_TOKEN` to `/etc/chirp/chirp.env` (`0600`). On registration, the server attempts best-effort deletion of the token from the env file. Under systemd (`ProtectSystem=strict`), `/etc/chirp` is read-only so the token remains in `chirp.env`; this is harmless because once an admin exists, first-run bootstrap is disabled permanently (`POST /bootstrap/admin` returns `409 conflict`). To retrieve the token if it scrolled off during installation: `pct exec <CTID> -- grep -E '^CHIRP_SETUP_TOKEN=' /etc/chirp/chirp.env`. When `CHIRP_SETUP_TOKEN` is unset (Docker, manual installs), the registration window is open to anyone who reaches it first, so create it immediately. Then copy the API key from **Settings -> API key** into Home Assistant. Forgot the password: `pct exec <CTID> -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password` (prints a new random password and signs out every session).

### Disk passthrough and its permissions

`proxmox/install/chirp-passthrough.sh` (run on the host; re-run after adding or replacing disks) configures device access into the container:

For an unprivileged container, re-run the script on the Proxmox host after updating the container, replacing `<CTID>` with its ID. The container cannot check the host collector version. The script selects the installed release when available and may fall back to `master` for older releases.

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/install/chirp-passthrough.sh)" _ <CTID>
```

- **Legacy passthrough (`CHIRP_DEV_PASSTHROUGH=legacy`, default):** uses legacy bind mounts and major wildcard rules:

```
lxc.cgroup2.devices.allow: b 8:* rw
lxc.mount.entry: /dev/disk/by-id/wwn-0x5000c500a1b2c3d4 dev/disk/by-id/wwn-0x5000c500a1b2c3d4 none bind,optional,create=file
```

  - **Boot resilience with `optional`:** Proxmox LXC `devN:` entries lack an `optional` flag and abort container startup if a host path is missing. `legacy` mode with `bind,optional` allows the container to boot normally even if a disk is unplugged or fails, ensuring the monitoring container stays online when disk issues occur.
  - **`rw`, not `rwm`.** Disks are bind-mounted, so the container never needs `mknod`; smartctl opens SCSI/SAT devices read-write for SG_IO, so `r` alone is not enough. Override with `CHIRP_DEV_PERM` (e.g. `CHIRP_DEV_PERM=rwm`).
  - **Major wildcard (`8:*`), not exact `major:minor`.** `sd` minors follow probe order and NVMe namespaces (major 259) get dynamic minors, so a static rule for an exact minor would point at the wrong disk after reboot. The cost: container root can reach other block devices with the same major (e.g. host boot disk).

- **Exact device passthrough (`CHIRP_DEV_PASSTHROUGH=dev`, requires Proxmox VE >= 8.1):** native exact device passthrough using `devN:` entries:

```
dev0: /dev/disk/by-id/wwn-0x5000c500a1b2c3d4
```

  - Proxmox automatically resolves the exact `major:minor` on every container start and allows only the selected devices in cgroups (no wildcard rules). Other devices sharing the same block major (such as the host boot disk) are not accessible from the container.
  - Indices (`dev0`, `dev1`, ...) are allocated dynamically to avoid colliding with user-defined `devN` entries (including pending entries in `[pve:pending]`).
  - **Caveat:** Proxmox `devN:` has no `optional` flag; if a disk is removed or dies, Proxmox will refuse to start the container until the config is updated.

- **Mode selection:** `CHIRP_DEV_PASSTHROUGH=legacy` (default) | `dev` | `auto` (resolves to `legacy` for boot resilience). Invalid values exit with an error.

- **How lines and migrations are managed.** The script recognises its own lines by content: `devN: /dev/disk/by-id/...` (strictly without user options like `gid=`, `mode=`, and only matching chirp's managed disks), by-id mounts, host metric mounts, and `lxc.cgroup2.devices.allow: b <major>:* <perm>` for the majors of the disks it manages. It preserves user-defined `devN` entries (with or without options) and user wildcard cgroup rules. On every run it deletes chirp's lines wherever they are in the main section and writes the new set once, before the first `[snapshot]` / `[pve:pending]` section. Snapshot sections, your own `lxc.*` lines, and user `devN` lines stay as they are, and a run that changes nothing does not rewrite the file. Older versions wrapped the lines in `# chirp-passthrough:start` / `:end` comments; Proxmox treats every `#` line as the container description and moves it to the top of the file (encoding `:` as `%3A`) whenever it rewrites the config, so markers cannot be relied on. They are no longer written and old ones are deleted. Managed disk by-ids and block majors are recorded on the host in `/var/lib/chirp-passthrough/<CTID>.disks` and `.majors` for cleanup. Files with CRLF line endings are refused unchanged.
  - **Backup & restore note:** Containers restored onto a new host lack `/var/lib/chirp-passthrough/<CTID>.disks`. To prevent accidental deletion of user devices, chirp preserves existing `devN:` entries when no state file exists. If restoring a container that previously used `dev` mode and switching to `legacy` mode, manually remove any old `devN: /dev/disk/by-id/...` lines from `/etc/pve/lxc/<CTID>.conf` to prevent Proxmox boot aborts if disks go offline.

### Host metrics (memory, load, network)

Inside the container `/proc/meminfo`, `/proc/stat` and `/proc/loadavg` can be lxcfs views of the container (e.g. 512 MB of RAM instead of the host's 64 GB), and the network namespace only has the container's `eth0`. The same script therefore also writes read-only mounts of the host's files into the container config. Choose with `CHIRP_HOST_MOUNTS`:

| `CHIRP_HOST_MOUNTS` | Mounts | Result |
|---|---|---|
| `all` (default) | `/proc/meminfo`, `/proc/stat`, `/proc/loadavg` -> `/host/proc`; `/sys` -> `/host/sys` | memory, load and network with `scope: "host"` |
| `proc` | the three `/proc` files only | memory and load `host`; network shows the container's own interfaces (`scope: "container"`) |
| `0` | none | memory, load and network `scope: "container"` |

```
lxc.mount.entry: /proc/meminfo host/proc/meminfo none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/stat host/proc/stat none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/loadavg host/proc/loadavg none bind,ro,optional,create=file 0 0
lxc.mount.entry: /sys host/sys none bind,ro,nosuid,nodev,noexec,optional,create=dir 0 0
```

Re-run the script to add the mounts to an existing install or to switch modes (e.g. `CHIRP_HOST_MOUNTS=proc CHIRP_DISKS=<your current disks> bash -c "$(curl ...)" _ <CTID>`); chirp's lines are replaced, never duplicated. **The disk selection of a re-run replaces the current one**: in the checklist keep every disk you want, and non-interactively pass the same `CHIRP_DISKS` as before (a run without a terminal defaults to `all`; `none` removes every passed-through disk).

chirp reads `/host/proc` and `/host/sys` first and reports `scope: "host"`; without them it falls back to the container's own files and reports `scope: "container"`, and the dashboard shows "container view" (its tooltip explains that the values come from the container, not the host). `optional` means a mount that fails never stops the container from starting. `/proc/net/dev` is deliberately not mounted: `/proc/net` follows the reader's network namespace.

**What `all` exposes.** The host's whole sysfs becomes readable at `/host/sys`. It is mounted read-only, `nosuid,nodev,noexec` and non-recursively (no cgroup, debugfs or other submounts), but the container's AppArmor profile denies writes to `/sys/**` *by path* and does not cover `/host/sys`. A root process in the container that can remount could therefore make it writable and change host network settings (MTU, bridge or bond parameters). That is not a new capability for a privileged container, whose root already has raw read-write access to the passed-through disks and is effectively host root, but if you do not want the host's sysfs in the container use `CHIRP_HOST_MOUNTS=proc`. It cannot be narrowed to `/sys/class/net`: its entries are symlinks into `/sys/devices/...`, and mounting `/sys/devices` would expose nearly all of sysfs anyway.

**These mounts have not been verified on every Proxmox/LXC/AppArmor combination.** The installer's smoke test compares MemTotal and checks that a host-only interface (e.g. `vmbr0`) is visible; you can check by hand:

```bash
# on the Proxmox host
grep -E 'MemTotal|MemAvailable' /proc/meminfo; free -b; ls /sys/class/net
# inside the container
pct exec <CTID> -- grep -E 'MemTotal|MemAvailable' /proc/meminfo /host/proc/meminfo
pct exec <CTID> -- ls /host/sys/class/net
# what chirp reports (scope must be "host")
curl -s -H "Authorization: Bearer $KEY" http://<ip>/api/v1/status | jq '{m: .memory.scope, l: .load.scope, n: .network.scope, total: .memory.totalBytes}'
```

`/host/proc/meminfo` must show the host's `MemTotal` (`free -b` "total" on the host), and `/host/sys/class/net` must list the host's interfaces (`vmbr0`, `eno1`, ...). If they show the container's values, the API reports `scope: "container"`; please open an issue with your Proxmox version.

**ZFS hosts.** The ZFS ARC is not counted in `MemAvailable`, so `memory.usedPercent` includes the ARC and can look permanently high (the Proxmox GUI shows memory on the same basis). Subtracting the reclaimable ARC (`/proc/spl/kstat/zfs/arcstats`) is a possible future improvement.

## 2. Docker

```bash
docker run -d --name chirp \
  --privileged -p 80:80 \
  -v /sys:/host/sys:ro -e CHIRP_SYSFS_ROOT=/host/sys \
  -v /proc/meminfo:/host/proc/meminfo:ro -v /proc/stat:/host/proc/stat:ro \
  -v /proc/loadavg:/host/proc/loadavg:ro \
  -v chirp-data:/var/lib/chirp \
  --device /dev/sda --device /dev/nvme0 \
  -e CHIRP_DEVICES=/dev/sda,/dev/nvme0 \
  ghcr.io/eigger/chirp:latest
```

- **Admin account:** open `http://<host>/` right after the first start and create it (until then anyone who can reach the port can). For unattended setups add `-e CHIRP_ADMIN_USER=admin -e CHIRP_ADMIN_PASSWORD=<10+ characters>`: the account is created on start when none exists (the variables are ignored afterwards and never overwrite a changed password). Reset: `docker exec chirp node apps/server/dist/cli.js admin reset-password`.
- **`CHIRP_ADMIN_PASSWORD` stays visible** in `docker inspect` and your compose file after the account exists: remove both variables after the first start and change the password in the dashboard.
- Instead of `--privileged` you can combine `--cap-add SYS_RAWIO --cap-add SYS_ADMIN` with `--device`.
- **One read-only host sysfs mount, `-v /sys:/host/sys:ro` with `CHIRP_SYSFS_ROOT=/host/sys`,** serves everything that comes from sysfs: CPU sensors (hwmon), RAPL power, stable disk IDs derived without waking disks, and the host's network interfaces with `scope: "host"`. A bind mount of the host's sysfs keeps the host's network namespace, so `/host/sys/class/net` lists `vmbr0`, `eno1`, ... Caveat: the whole host sysfs is visible to a privileged container; it is read-only, but a privileged container could remount it. Unlike the LXC mount (non-recursive), Docker's `-v` is a **recursive** bind: the host's sub-mounts under `/sys` (cgroup, debugfs, securityfs, efivarfs, ...) come along, and `:ro` is applied to them recursively only with Docker 25+ on kernel 5.12+ (on older setups they may stay writable). With Docker 25+ prefer the non-recursive form, which matches the LXC mount:
  `--mount type=bind,src=/sys,dst=/host/sys,readonly,bind-recursive=disabled`
  (the `-v` form in the example works on any Docker version).
- **Other sysfs setups:**
  - `-v /sys:/sys:ro` instead (older examples): sensors and disk IDs work, and `/sys/class/net` then also shows the host's interfaces, but chirp cannot tell that apart from a container's own `/sys` and reports the network section as `scope: "container"`. Use `/host/sys` to get the host label.
  - `--network host`: the container's own `/sys/class/net` is the host's namespace; again host data labelled `scope: "container"` unless `/host/sys` is mounted.
  - No host sysfs and the default bridge network: only the container's `eth0` (`scope: "container"`). CPU sensors and RAPL still work through the container's own `/sys` (only `/sys/class/net` is network-namespace aware; a non-privileged container may have `/sys/class/powercap` masked).
- The three `/proc` file mounts give the host's memory and load with `scope: "host"`; only these files are needed. Mounting all of `/proc` at `/host/proc` also works (then the host's network counters can come from PID 1's `/host/proc/1/net/dev` when there is no host sysfs). Without them memory/load are reported as `scope: "container"` (Docker does not virtualise `/proc/meminfo`, so the values are usually the host's anyway).
- The `chirp-data` volume stores the API key (`api-key`), the admin account (`admin.json`), `instance-id` and `disk-ids.json` (pinned disk IDs). Losing the volume changes the key and instance ID, so Home Assistant creates new entities, and you register the admin again.
- **API key:** sign in and open **Settings -> API key** (show, copy, regenerate). It is not printed to the container log; on the host you can also run `docker exec chirp node apps/server/dist/cli.js key show` (or start once with `-e CHIRP_PRINT_KEY=true` if you really want it in the log).
- If device names can change, use `/dev/disk/by-id/...` paths in `CHIRP_DEVICES`. RAID controllers/USB bridges: `CHIRP_DEVICE_TYPES=/dev/sda=sat`. When no type is set and smartctl reports `Unable to detect device type` (typical for by-id nodes bind-mounted into an LXC), chirp retries with `-d sat`, then `-d scsi`, and remembers the type that worked; set `CHIRP_DEVICE_TYPES` to skip the detection.
- The image's `HEALTHCHECK` probes the address that `CHIRP_HOST`/`CHIRP_PORT` bind (loopback for `0.0.0.0`/`::`).

## 3. Release tarball

Each release carries `chirp-<version>.tar.gz` and `.sha256`.

```bash
sha256sum -c chirp-<version>.tar.gz.sha256
mkdir -p /opt/chirp && tar -xzf chirp-<version>.tar.gz -C /opt/chirp
cd /opt/chirp && node apps/server/dist/index.js
```

Tarball layout (built by `scripts/package-release.sh`): `package.json`, `node_modules` (production), any nested workspace `node_modules` (`apps/*/node_modules`, `packages/*/node_modules`), `packages/shared/{package.json,dist}`, `apps/server/{package.json,dist}`, `apps/web/dist`. Pure JavaScript, no native build needed. CI unpacks every tarball outside the checkout and starts it (`scripts/ci/smoke-release.sh`) so a missing dependency fails the release.

**The sha256 check is integrity only.** The `.sha256` file comes from the same GitHub release as the tarball, so it catches corrupted or truncated downloads, not a tampered release. Authenticity relies on HTTPS and the GitHub account; releases are not signed.

systemd example:

```ini
[Service]
EnvironmentFile=-/etc/chirp/chirp.env
WorkingDirectory=/opt/chirp
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=on-failure
```

## Updating the Proxmox container

Run `update` inside the container (`pct exec <CTID> -- update`). It downloads the release, checks the sha256, unpacks it into `/opt/chirp/releases/<version>`, switches `/opt/chirp/current` atomically and waits for `/health`:

- it never touches the data directory (`/var/lib/chirp`: API key, admin account, instance ID, disk IDs), so Home Assistant keeps working and the admin account survives updates. Upgrading from a release without accounts keeps the existing API key; open the dashboard afterwards and create the admin account;
- the probe uses `CHIRP_HOST`/`CHIRP_PORT` from `/etc/chirp/chirp.env` (`127.0.0.1` for `0.0.0.0`/`::`, otherwise the configured address), selects `https` when TLS is configured, and uses `curl -kfsS` for loopback certificate tolerance;
- if the health check fails, the previous release is restored; on a first install (nothing to roll back to) the service is stopped and the `current` link is removed instead of being left dangling.

## Environment variables

See [`.env.example`](../.env.example). Key ones: `CHIRP_HOST` (bind address, default `0.0.0.0`; set `127.0.0.1` when behind a local proxy), `CHIRP_SETUP_TOKEN` (one-time setup token for initial admin registration; generated during Proxmox install), `CHIRP_TLS_CERT` and `CHIRP_TLS_KEY` (built-in TLS certificate and key paths; both or neither), `CHIRP_API_KEY` (wins, at least 16 characters, read-only in the dashboard) / `CHIRP_API_KEY_FILE`, `CHIRP_PRINT_KEY`, `CHIRP_ADMIN_USER` + `CHIRP_ADMIN_PASSWORD` (seed the admin), `CHIRP_COOKIE_SECURE` (`auto`/`true`/`false`), `CHIRP_DATA_DIR`, `CHIRP_DEVICES`, `CHIRP_DEVICE_TYPES`, `CHIRP_SCAN_MODE`, `CHIRP_RESCAN_INTERVAL`, `CHIRP_SMART_INTERVAL`, `CHIRP_SENSOR_INTERVAL`, `CHIRP_TEMP_WARN_{HDD,SSD,NVME}`, `CHIRP_SYSFS_ROOT`, `CHIRP_HOST_PROC`, `CHIRP_HOST_SYS`, `CHIRP_NET_INCLUDE`, `CHIRP_NET_EXCLUDE`, `CHIRP_WEB_DIR`, `CHIRP_TRUST_PROXY` (`false`, proxy IPs/CIDRs (recommended), a hop count such as `1`, or `true`; see Security), `CHIRP_LOGIN_DAILY_BUDGET` (default 1000), `CHIRP_CORS_ORIGINS`. Invalid values stop the server with a message such as `chirp: invalid configuration: CHIRP_PORT must be an integer between 1 and 65535 (got "80a")`.


Host roots:

| Variable | Default | Used for |
|---|---|---|
| `CHIRP_HOST_SNAPSHOT` | `/run/chirp/host.json` | Path to atomic host snapshot file generated by host-side `chirp-collector` (for unprivileged LXC). Set to `none`, `0`, or `false` to disable snapshot mode and force direct sysfs/smartctl reading |
| `CHIRP_SYSFS_ROOT` | `/sys` | hwmon (CPU temperature, fans, voltages, hwmon power), RAPL powercap and sysfs disk IDs. Only this root; no fallback |
| `CHIRP_HOST_SYS` | `/host/sys` if it exists, else `/sys` | network interfaces (`/sys/class/net`); read first, then the local `/sys` (`scope` tells which) |
| `CHIRP_HOST_PROC` | `/host/proc` if it exists, else `/proc` | `/proc/meminfo`, `/proc/stat`, `/proc/loadavg` (and `1/net/dev`); read first, then the local `/proc` |

Proxmox LXC: keep the defaults (the installer mounts `/host/proc` and `/host/sys`). Docker: mount the host's `/sys` at `/host/sys` and set `CHIRP_SYSFS_ROOT=/host/sys` so one mount serves both roles, plus the three `/proc` files under `/host/proc` (see the Docker example). Bare-metal installs need none of them.

## Release procedure

1. Set the same `version` in the root, `packages/shared`, `apps/server` and `apps/web` `package.json` files (`release.yml` checks this).
2. Publish a GitHub Release tagged `v<version>`.
3. `release.yml` checks tag/version, builds, packages and smoke-tests the tarball, then uploads it with its sha256; `docker-release.yml` pushes semver/latest tags to `ghcr.io/eigger/chirp`.

## Security

- **First-run registration window.** With the Proxmox installer, initial admin account creation requires the random one-time `CHIRP_SETUP_TOKEN` written to `/etc/chirp/chirp.env` (`0600`). The server attempts best-effort removal from the env file upon registration. Under systemd's strict sandbox (`ProtectSystem=strict`), `/etc/chirp/chirp.env` is read-only and the token may remain in the file; once an admin account exists, `POST /bootstrap/admin` returns 409 conflict and the setup token is inert. If lost before registration, inspect it with `pct exec <CTID> -- grep -E '^CHIRP_SETUP_TOKEN=' /etc/chirp/chirp.env`. When `CHIRP_SETUP_TOKEN` is unset (Docker, manual installs), whoever opens the dashboard first can create the account. Create it right after installing, or seed it with `CHIRP_ADMIN_USER`/`CHIRP_ADMIN_PASSWORD`. The server log warns on every start while no admin exists.
- **TLS and transport.** Without TLS the admin password (at login), the session cookie and the API key cross the network in clear text.
  - **Built-in TLS:** Configure `CHIRP_TLS_CERT` and `CHIRP_TLS_KEY` (paths to certificate and private key); Fastify serves HTTPS directly and derives `CHIRP_COOKIE_SECURE=true`. Do not generate or fetch certificates in the server itself.
  - **Reverse proxy / Tailscale:** For production use, placing chirp behind a TLS reverse proxy (Caddy, nginx, Traefik) or Tailscale remains the recommended approach. Force the cookie's `Secure` flag with `CHIRP_COOKIE_SECURE=true` if chirp cannot tell the request came over HTTPS.
  - **Bind control:** `CHIRP_HOST` controls the listening address (default `0.0.0.0`). When running behind a local reverse proxy on the same host, bind to `CHIRP_HOST=127.0.0.1`.
- **Behind a reverse proxy, configure `CHIRP_TRUST_PROXY`.**
  - Without it chirp sees every client as the proxy's address. The login backoff then treats all users as one source: one attacker's failed logins make everyone wait, up to 15 min, and a "known" source means anyone behind the proxy. The session cookie also gets no automatic `Secure` flag.
  - **Recommended:** the proxy's own address(es), e.g. `CHIRP_TRUST_PROXY=10.0.0.5` or `10.0.0.0/24,fd00::/64`. Then `X-Forwarded-For`/`-Proto` are believed only when the request really comes from the proxy.
  - A **hop count** (`1`) or `true` believes those headers from *any* peer. That is safe only when chirp can be reached **only through the proxy**: bind it to loopback (`CHIRP_HOST=127.0.0.1` with the proxy on the same host) or firewall the port. Otherwise anyone who connects directly can forge `X-Forwarded-For` (a fresh address per request dodges the per-source backoff) and `X-Forwarded-Proto`. `true` is additionally unsafe unless the proxy *overwrites* `X-Forwarded-For` (nginx `proxy_set_header X-Forwarded-For $remote_addr;`). chirp logs a warning when a hop count or `true` is used with a wildcard bind.
- **Login limits.** Each source (IPv4 address or IPv6 /64) backs off up to 15 min. The username backs off up to 5 s, but only for sources that already failed and never signed in. At most 1000 failed attempts per username per 24 h are allowed (`CHIRP_LOGIN_DAILY_BUDGET`); after that only addresses that signed in before may try. A sustained attack can therefore slow logins from new addresses, and after the budget is spent block them for up to 24 h, but it never affects an address you signed in from before, open sessions, Home Assistant or the CLI. Recovery: `cli.js admin reset-password` (also resets the budget) or restart the service. Details: [`api.md`](api.md#login-rate-limiting).
- **`CHIRP_ADMIN_PASSWORD` stays readable in plain text** in the environment (`docker inspect`, compose files, `/proc/<pid>/environ`) even after the account exists. After the first start remove `CHIRP_ADMIN_USER`/`CHIRP_ADMIN_PASSWORD` and change the password in the dashboard (Settings -> Change password).
- **The CLI reads the service settings.** `cli.js` loads `/etc/chirp/chirp.env` when it exists (or `--env-file <path>` / `CHIRP_ENV_FILE`), so `pct exec <CTID> -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password` uses the same data directory as the service.
- Sessions: HttpOnly + SameSite=Strict cookie, 12 h idle / 7 days max, kept in memory (a restart signs everyone out), all ended by a password change. Passwords must be 10-256 characters and not a common/guessable one.
- A privileged container is assumed; its root is effectively host root (see above).

## Optional filesystem and ZFS monitoring

Set `CHIRP_FILESYSTEM_PATHS=/,/data` to monitor selected filesystem paths (maximum 32), and optionally `CHIRP_ZFS_ENABLED=true` for read-only ZFS pool health/capacity. Both are off by default and sampled asynchronously once a minute. ZFS needs `zpool` and existing device access; Chirp does not install tools, add privileges or modify pools.

In a container these paths describe its own mounts. In an unprivileged container with the host collector (`var_unprivileged=1`), configure `CHIRP_FILESYSTEM_PATHS` and `CHIRP_ZFS_ENABLED` in `/etc/chirp/chirp.env` on the Proxmox host; `chirp-collector` queries them directly on the host and includes them in the snapshot with `scope: "host"`. In a privileged container, for host filesystems explicitly mount the host root read-only at `/host/root` and set `CHIRP_HOST_ROOT=/host/root`; `/data` then means `/host/root/data`, with no fallback if it cannot be read. See [API semantics](api.md#additional-host-and-storage-metrics).
