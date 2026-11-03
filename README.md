# chirp

[![CI](https://github.com/eigger/chirp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/eigger/chirp/actions/workflows/ci.yml)
[![Docker Release](https://github.com/eigger/chirp/actions/workflows/docker-release.yml/badge.svg)](https://github.com/eigger/chirp/actions/workflows/docker-release.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/eigger/chirp)](https://github.com/eigger/chirp/blob/master/LICENSE)
[![Self-hosted](https://img.shields.io/badge/hosting-self--hosted-2563EB)](proxmox/ct/chirp.sh)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Feigger%2Fchirp-2496ED?logo=docker&logoColor=white)](https://github.com/eigger/chirp/pkgs/container/chirp)

**[한국어 README](./README.ko.md)**

A tiny monitoring server for your **Proxmox host** — CPU temperature, disk SMART health, memory, load, network and power, exposed as a REST API and a built-in dashboard. Like a canary in a coal mine, it chirps before a disk dies.

Docs: [`docs/PROJECT.md`](docs/PROJECT.md) · [`docs/api.md`](docs/api.md) · [`docs/deploy.md`](docs/deploy.md)

---

## Features

- **CPU temperature** from `/sys/class/hwmon` (coretemp, k10temp, zenpower, cpu_thermal): package, per-core, high/critical limits, other sensors
- **Disk SMART** via `smartctl -j` for SATA HDD/SSD and NVMe: temperature, power-on hours, reallocated/pending sectors, wear, bytes written
- **Never wakes sleeping disks** — `smartctl -n standby`, and device discovery with the non-opening `smartctl --scan`; a spun-down disk keeps its last known values and is flagged `standby`
- **Host metrics** — memory and swap, load average and CPU usage, per-interface network throughput (physical NICs, bonds, `vmbr*` bridges, VLANs; guest `veth`/`tap`/`fw*` devices hidden), CPU package power (RAPL or hwmon), fans and voltages. Each `/proc`-based section says whether it shows the **host** or only the **container** view (`scope`)
- **One health verdict** (`ok` / `warning` / `failing` / `unknown`) with machine-readable reasons, decided in one place on the server
- **Stable disk IDs** (WWN, else model + serial) — never `/dev/sdX`; derived without waking the disk and pinned across restarts
- **24 h history** of temperatures, memory, CPU usage, load, network throughput and package power (1-minute resolution, in memory) and a web dashboard served by the same process
- **REST API with a bearer API key**; no database; pure JavaScript, no native dependencies
- **Home Assistant** integration: [`hass-chirp`](https://github.com/eigger/hass-chirp) (integration domain `chirp`)

## Install

### Proxmox one-liner (recommended)

Run on the Proxmox host shell:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
```

It creates an LXC container, installs the latest release tarball, passes the selected disks through, and prints the dashboard URL and API key.

**Host values from inside the LXC.** In a container `/proc/meminfo`, `/proc/stat` and `/proc/loadavg` can show the container's limits (lxcfs) and only the container's `eth0` is visible. The passthrough step therefore also bind-mounts the host's `/proc/meminfo`, `/proc/stat`, `/proc/loadavg` and `/sys` read-only under `/host/...` (re-run `chirp-passthrough.sh` to add them to an existing install; the disk selection of a re-run replaces the current one, so keep every disk you want, or pass the same `CHIRP_DISKS`). `CHIRP_HOST_MOUNTS=proc` mounts only the `/proc` files (no host sysfs in the container; network then shows the container view), `CHIRP_HOST_MOUNTS=0` none — see the exposure notes in [`docs/deploy.md`](docs/deploy.md#host-metrics-memory-load-network). chirp reads those first and reports `scope: "host"`; without them the dashboard says "container view" (its tooltip explains that the values come from the container, not the host). These mounts are new and not verified on every Proxmox setup — the installer compares them with the host, and [`docs/deploy.md`](docs/deploy.md#host-metrics-memory-load-network) shows how to check (`free` / `/proc/meminfo` on the host vs. `/host/proc/meminfo` in the container).

### Docker

```bash
docker run -d --name chirp \
  --privileged \
  -p 80:80 \
  -v /sys:/host/sys:ro -e CHIRP_SYSFS_ROOT=/host/sys \
  -v /proc/meminfo:/host/proc/meminfo:ro -v /proc/stat:/host/proc/stat:ro \
  -v /proc/loadavg:/host/proc/loadavg:ro \
  -v chirp-data:/var/lib/chirp \
  --device /dev/sda --device /dev/sdb --device /dev/nvme0 \
  -e CHIRP_DEVICES=/dev/sda,/dev/sdb,/dev/nvme0 \
  ghcr.io/eigger/chirp:latest
```

Instead of `--privileged` you can use `--cap-add SYS_RAWIO --cap-add SYS_ADMIN` together with the `--device` flags. The read-only host sysfs at `/host/sys` (`CHIRP_SYSFS_ROOT=/host/sys`) provides the **host's** CPU sensors, power, disk IDs and network interfaces (`scope: "host"`); the `/host/proc/*` files provide the host's memory and load. With `-v /sys:/sys:ro` or `--network host` instead, the network data is the host's but labelled `scope: "container"`. On ZFS hosts the ARC counts as used memory (as in the Proxmox GUI). Get the API key with `docker exec chirp node apps/server/dist/cli.js key show`. See [`docs/deploy.md`](docs/deploy.md).

### From the release tarball

```bash
tar -xzf chirp-<version>.tar.gz -C /opt/chirp
cd /opt/chirp && CHIRP_PORT=8080 node apps/server/dist/index.js
```

Requires Node.js 24 and `smartmontools`. The `.sha256` asset verifies download integrity (not authenticity; releases are not signed).

## API key

On the first start a key (`chp_...`) is generated and written to `/var/lib/chirp/api-key` (mode 0600). The log only names the file and the command below; the key itself is printed only with `CHIRP_PRINT_KEY=true`. Every `/api/v1/*` request needs `Authorization: Bearer <key>`.

```bash
node apps/server/dist/cli.js key show     # print the key
node apps/server/dist/cli.js key rotate   # create a new key (takes effect immediately)
```

`CHIRP_API_KEY` overrides the key file (at least 16 characters). The dashboard HTML/JS is public, but all data requires the key.

## Configuration

All settings are environment variables — see [`.env.example`](.env.example). Defaults: port `80`, SMART every `300` s, sensors and host metrics every `10` s, device re-discovery every `3600` s. Host roots: `CHIRP_HOST_PROC` / `CHIRP_HOST_SYS` (default `/host/proc` / `/host/sys` when present). Network interface filter: `CHIRP_NET_INCLUDE` / `CHIRP_NET_EXCLUDE` (comma-separated globs). Invalid values (e.g. `CHIRP_PORT=abc`) stop the server with a clear message.

## Home Assistant

Install [`hass-chirp`](https://github.com/eigger/hass-chirp), add the integration (domain `chirp`) and enter the chirp URL and API key. Entities are keyed by the instance UUID, disk WWN and interface/sensor IDs, so they survive reboots and device renames.

## Security notes

- The Proxmox script creates a **privileged LXC** container so `smartctl` can reach the host's block devices. A compromised privileged container is close to a compromised host — keep it on a trusted network. The device rules allow `rw` on the selected disks' majors (see [`docs/deploy.md`](docs/deploy.md#disk-passthrough-and-its-permissions) for why not exact minors).
- Traffic is **plain HTTP**. The API key is sent in clear text; put chirp behind a TLS reverse proxy (or Tailscale) if the network is not trusted, and set `CHIRP_TRUST_PROXY=true` only behind a proxy you control.
- `POST /api/v1/refresh` has a 30 s cooldown; the server never spins up sleeping disks.

## Development

```bash
npm install
npm run build:shared
npm run dev:server    # tsx watch
npm test
npm run lint
```

## License

MIT — see [`LICENSE`](LICENSE).
