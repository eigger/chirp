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

Creates a privileged LXC, installs the release tarball, passes the selected disks through and prints the dashboard URL and API key (read with `cli.js key show` inside the container). Script details are in `proxmox/`.

### Disk passthrough and its permissions

`proxmox/install/chirp-passthrough.sh` (run on the host; re-run after adding or replacing disks) bind-mounts each selected disk's `/dev/disk/by-id/...` node into the container and adds one cgroup rule per device major:

```
lxc.cgroup2.devices.allow: b 8:* rw
lxc.mount.entry: /dev/disk/by-id/wwn-0x5000c500a1b2c3d4 dev/disk/by-id/wwn-0x5000c500a1b2c3d4 none bind,optional,create=file
```

- **`rw`, not `rwm`.** The disks are bind-mounted, so the container never needs `mknod`; smartctl opens SCSI/SAT devices read-write for SG_IO, so `r` alone is not enough. Override with `CHIRP_DEV_PERM` (e.g. `CHIRP_DEV_PERM=rwm`).
- **Major wildcard (`8:*`), not exact `major:minor`.** `sd` minors follow probe order and NVMe namespaces (major 259) get dynamic minors, so a rule for an exact minor would point at the wrong disk, or none, after a host reboot or hotplug. The by-id bind mounts are re-resolved on every container start; static cgroup rules are not, and Proxmox offers no hook that can rewrite them before the container starts.
- **Risk:** root in the container can reach other block devices with the same major, including the host's boot disk if it is also `sd*`/NVMe. That is no worse than a privileged container already is (its root is effectively host root), but keep the container on a trusted network and do not run anything else in it.

### Host metrics (memory, load, network)

Inside the container `/proc/meminfo`, `/proc/stat` and `/proc/loadavg` can be lxcfs views of the container (e.g. 512 MB of RAM instead of the host's 64 GB), and the network namespace only has the container's `eth0`. The same script therefore also writes read-only mounts of the host's files into the marker block. Choose with `CHIRP_HOST_MOUNTS`:

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

Re-run the script to add the mounts to an existing install or to switch modes (e.g. `CHIRP_HOST_MOUNTS=proc CHIRP_DISKS=<your current disks> bash -c "$(curl ...)" _ <CTID>`); the block is rewritten, never duplicated. **The disk selection of a re-run replaces the current one**: in the checklist keep every disk you want, and non-interactively pass the same `CHIRP_DISKS` as before (a run without a terminal defaults to `all`; `none` removes every passed-through disk).

chirp reads `/host/proc` and `/host/sys` first and reports `scope: "host"`; without them it falls back to the container's own files and reports `scope: "container"`, and the dashboard shows "container view — host mounts missing". `optional` means a mount that fails never stops the container from starting. `/proc/net/dev` is deliberately not mounted: `/proc/net` follows the reader's network namespace.

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
  -v /sys:/sys:ro -v chirp-data:/var/lib/chirp \
  -v /proc/meminfo:/host/proc/meminfo:ro -v /proc/stat:/host/proc/stat:ro \
  -v /proc/loadavg:/host/proc/loadavg:ro -v /sys:/host/sys:ro \
  --device /dev/sda --device /dev/nvme0 \
  -e CHIRP_DEVICES=/dev/sda,/dev/nvme0 \
  ghcr.io/eigger/chirp:latest
```

- Instead of `--privileged` you can combine `--cap-add SYS_RAWIO --cap-add SYS_ADMIN` with `--device`.
- Mount `/sys` read-only so the host's CPU sensors (hwmon) are visible; it also lets chirp derive stable disk IDs from sysfs without waking disks.
- The three `/proc` file mounts give the host's memory and load with `scope: "host"` (only these files are needed; mounting all of `/proc` at `/host/proc` also works, and then the host's network counters are read from PID 1's `/host/proc/1/net/dev`). `-v /sys:/host/sys:ro` gives the host's network interfaces (a container's own `/sys/class/net` only shows its network namespace); it has the same caveat as `all` above (the whole host sysfs, read-only, visible to a privileged container). Leave it out if you do not need the network section, or run with `--network host`, where the container already sees the host's interfaces but chirp reports them as `scope: "container"` because it cannot tell. Without the `/proc` mounts memory/load are reported as `scope: "container"` (Docker does not virtualise `/proc/meminfo`, so the values are usually the host's anyway).
- The `chirp-data` volume stores the API key (`api-key`), `instance-id` and `disk-ids.json` (pinned disk IDs). Losing the volume changes the key and instance ID, so Home Assistant creates new entities.
- **API key:** it is not printed to the container log. Read it with
  `docker exec chirp node apps/server/dist/cli.js key show`
  (or start once with `-e CHIRP_PRINT_KEY=true` if you really want it in the log).
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

- the probe uses `CHIRP_HOST`/`CHIRP_PORT` from `/etc/chirp/chirp.env` (`127.0.0.1` for `0.0.0.0`/`::`, otherwise the configured address);
- if the health check fails, the previous release is restored; on a first install (nothing to roll back to) the service is stopped and the `current` link is removed instead of being left dangling.

## Environment variables

See [`.env.example`](../.env.example). Key ones: `CHIRP_API_KEY` (wins, at least 16 characters) / `CHIRP_API_KEY_FILE`, `CHIRP_PRINT_KEY`, `CHIRP_DATA_DIR`, `CHIRP_DEVICES`, `CHIRP_DEVICE_TYPES`, `CHIRP_SCAN_MODE`, `CHIRP_RESCAN_INTERVAL`, `CHIRP_SMART_INTERVAL`, `CHIRP_SENSOR_INTERVAL`, `CHIRP_TEMP_WARN_{HDD,SSD,NVME}`, `CHIRP_HOST_PROC`, `CHIRP_HOST_SYS`, `CHIRP_NET_INCLUDE`, `CHIRP_NET_EXCLUDE`, `CHIRP_WEB_DIR`, `CHIRP_TRUST_PROXY`, `CHIRP_CORS_ORIGINS`. Invalid values stop the server with a message such as `chirp: invalid configuration: CHIRP_PORT must be an integer between 1 and 65535 (got "80a")`.

## Release procedure

1. Set the same `version` in the root, `packages/shared`, `apps/server` and `apps/web` `package.json` files (`release.yml` checks this).
2. Publish a GitHub Release tagged `v<version>`.
3. `release.yml` checks tag/version, builds, packages and smoke-tests the tarball, then uploads it with its sha256; `docker-release.yml` pushes semver/latest tags to `ghcr.io/eigger/chirp`.

## Security

Plain HTTP and a privileged container are assumed. On untrusted networks put chirp behind a TLS reverse proxy or Tailscale.
