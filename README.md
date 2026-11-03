# chirp

[![CI](https://github.com/eigger/chirp/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/eigger/chirp/actions/workflows/ci.yml)
[![Docker Release](https://github.com/eigger/chirp/actions/workflows/docker-release.yml/badge.svg)](https://github.com/eigger/chirp/actions/workflows/docker-release.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/eigger/chirp)](https://github.com/eigger/chirp/blob/master/LICENSE)
[![Self-hosted](https://img.shields.io/badge/hosting-self--hosted-2563EB)](proxmox/ct/chirp.sh)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Feigger%2Fchirp-2496ED?logo=docker&logoColor=white)](https://github.com/eigger/chirp/pkgs/container/chirp)

**[한국어 README](./README.ko.md)**

A tiny monitoring server for your **Proxmox host** — CPU temperature and disk SMART health, exposed as a REST API and a built-in dashboard. Like a canary in a coal mine, it chirps before a disk dies.

Docs: [`docs/PROJECT.md`](docs/PROJECT.md) · [`docs/api.md`](docs/api.md) · [`docs/deploy.md`](docs/deploy.md)

---

## Features

- **CPU temperature** from `/sys/class/hwmon` (coretemp, k10temp, zenpower, cpu_thermal): package, per-core, high/critical limits, other sensors
- **Disk SMART** via `smartctl -j` for SATA HDD/SSD and NVMe: temperature, power-on hours, reallocated/pending sectors, wear, bytes written
- **Never wakes sleeping disks** — `smartctl -n standby`; a spun-down disk keeps its last known values and is flagged `standby`
- **One health verdict** (`ok` / `warning` / `failing` / `unknown`) with machine-readable reasons, decided in one place on the server
- **Stable disk IDs** (WWN, else model + serial) — never `/dev/sdX`
- **24 h temperature history** (1-minute resolution, in memory) and a web dashboard served by the same process
- **REST API with a bearer API key**; no database; pure JavaScript, no native dependencies
- **Home Assistant** integration: [`hass-chirp`](https://github.com/eigger/hass-chirp) (integration domain `chirp`)

## Install

### Proxmox one-liner (recommended)

Run on the Proxmox host shell:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
```

It creates an LXC container, installs the latest release tarball, and prints the dashboard URL and API key.

### Docker

```bash
docker run -d --name chirp \
  --privileged \
  -p 80:80 \
  -v /sys:/sys:ro \
  -v chirp-data:/var/lib/chirp \
  --device /dev/sda --device /dev/sdb --device /dev/nvme0 \
  -e CHIRP_DEVICES=/dev/sda,/dev/sdb,/dev/nvme0 \
  ghcr.io/eigger/chirp:latest
```

Instead of `--privileged` you can use `--cap-add SYS_RAWIO --cap-add SYS_ADMIN` together with the `--device` flags. Mount `/sys` read-only so the CPU sensors of the **host** are visible. See [`docs/deploy.md`](docs/deploy.md).

### From the release tarball

```bash
tar -xzf chirp-<version>.tar.gz -C /opt/chirp
cd /opt/chirp && CHIRP_PORT=8080 node apps/server/dist/index.js
```

Requires Node.js 24 and `smartmontools`.

## API key

On the first start a key (`chp_...`) is generated and written to `/var/lib/chirp/api-key` (mode 0600); it is also printed once in the log. Every `/api/v1/*` request needs `Authorization: Bearer <key>`.

```bash
node apps/server/dist/cli.js key show     # print the key
node apps/server/dist/cli.js key rotate   # create a new key (takes effect immediately)
```

`CHIRP_API_KEY` overrides the key file. The dashboard HTML/JS is public, but all data requires the key.

## Configuration

All settings are environment variables — see [`.env.example`](.env.example). Defaults: port `80`, SMART every `300` s, sensors every `10` s.

## Home Assistant

Install [`hass-chirp`](https://github.com/eigger/hass-chirp), add the integration (domain `chirp`) and enter the chirp URL and API key. Entities are keyed by the instance UUID and disk WWN, so they survive reboots and device renames.

## Security notes

- The Proxmox script creates a **privileged LXC** container so `smartctl` can reach the host's block devices. A compromised privileged container is close to a compromised host — keep it on a trusted network.
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
