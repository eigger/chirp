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
- **Admin login** for the dashboard (created on first visit) and **one API key** for Home Assistant, shown and regenerated in Settings; no database; pure JavaScript, no native dependencies
- **Home Assistant** integration: [`hass-chirp`](https://github.com/eigger/hass-chirp) (integration domain `chirp`)

## Install

### Proxmox one-liner (recommended)

Run on the Proxmox host shell:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
```

It creates an LXC container, installs the latest release tarball, passes the selected disks through, and prints the dashboard URL. **Open that URL right away and create the admin account** (see [First run](#first-run)).

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

Instead of `--privileged` you can use `--cap-add SYS_RAWIO --cap-add SYS_ADMIN` together with the `--device` flags. The read-only host sysfs at `/host/sys` (`CHIRP_SYSFS_ROOT=/host/sys`) provides the **host's** CPU sensors, power, disk IDs and network interfaces (`scope: "host"`); the `/host/proc/*` files provide the host's memory and load. With `-v /sys:/sys:ro` or `--network host` instead, the network data is the host's but labelled `scope: "container"`. On ZFS hosts the ARC counts as used memory (as in the Proxmox GUI). To create the admin account without the browser, add `-e CHIRP_ADMIN_USER=admin -e CHIRP_ADMIN_PASSWORD=<10+ characters>` (used only while no admin exists; the password then stays visible in `docker inspect`, so remove both variables after the first start and change the password in the dashboard). See [`docs/deploy.md`](docs/deploy.md).

### From the release tarball

```bash
tar -xzf chirp-<version>.tar.gz -C /opt/chirp
cd /opt/chirp && CHIRP_PORT=8080 node apps/server/dist/index.js
```

Requires Node.js 24 and `smartmontools`. The `.sha256` asset verifies download integrity (not authenticity; releases are not signed).

## First run

1. Open `http://<chirp address>/`. While no admin account exists, the dashboard shows **Create the admin account**: pick a username, enter the password twice (at least 10 characters), and provide the one-time setup token (retrievable with `pct exec <CTID> -- grep -E '^CHIRP_SETUP_TOKEN=' /etc/chirp/chirp.env` on Proxmox). You are signed in right away.
   **Do this immediately after installing:** when no setup token is set, *whoever opens the dashboard first* can create the admin. (Docker/automation: set `CHIRP_ADMIN_USER` and `CHIRP_ADMIN_PASSWORD` instead.)
2. Go to **Settings -> API key**, click **Copy** and paste the key into Home Assistant (see below).
3. Forgot the password? Proxmox (on the host): `pct exec <CTID> -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password`; Docker: `docker exec chirp node apps/server/dist/cli.js admin reset-password`. It prints a new random password and signs out every session. (The CLI reads `/etc/chirp/chirp.env` when present; elsewhere pass `--env-file <path>` if your settings live in a file.)

## API key

On the first start a key (`chp_...`) is generated and written to `/var/lib/chirp/api-key` (mode 0600). It is never written to the log unless `CHIRP_PRINT_KEY=true`. Signed in, **Settings -> API key** shows it (show/hide, copy) and **Regenerate** replaces it; the old key stops working immediately, so update Home Assistant afterwards. Clients send `Authorization: Bearer <key>`; the dashboard itself uses its login session.

```bash
node apps/server/dist/cli.js key show     # print the key
node apps/server/dist/cli.js key rotate   # create a new key (takes effect immediately)
```

`CHIRP_API_KEY` overrides the key file (at least 16 characters); such a key is shown read-only and cannot be regenerated in the dashboard. Upgrading from an older release keeps the existing key, so Home Assistant keeps working; just create the admin account on the first visit. The dashboard HTML/JS is public, but all data requires a login or the key.

## Configuration

All settings are environment variables — see [`.env.example`](.env.example). Defaults: port `80`, SMART every `300` s, sensors and host metrics every `10` s, device re-discovery every `3600` s. Host roots: `CHIRP_HOST_PROC` / `CHIRP_HOST_SYS` (default `/host/proc` / `/host/sys` when present). Network interface filter: `CHIRP_NET_INCLUDE` / `CHIRP_NET_EXCLUDE` (comma-separated globs). Invalid values (e.g. `CHIRP_PORT=abc`) stop the server with a clear message.

## Home Assistant

Install [`hass-chirp`](https://github.com/eigger/hass-chirp), add the integration (domain `chirp`) and enter the chirp host, port and the API key from **Settings -> API key** in the chirp dashboard. Entities are keyed by the instance UUID, disk WWN and interface/sensor IDs, so they survive reboots and device renames.

## Security notes

- The Proxmox script creates a **privileged LXC** container so `smartctl` can reach the host's block devices. A compromised privileged container is close to a compromised host — keep it on a trusted network. The device rules allow `rw` on the selected disks' majors (see [`docs/deploy.md`](docs/deploy.md#disk-passthrough-and-its-permissions) for why not exact minors).
- **Create the admin account right after installing.** Until it exists, anyone who can reach the dashboard can create it (first-run registration). The server log warns about this on every start.
- Traffic is **plain HTTP**. The admin password (when signing in), the session cookie and the API key cross the network in clear text; put chirp behind a TLS reverse proxy (or Tailscale) if the network is not trusted.
- Behind a proxy, set `CHIRP_TRUST_PROXY` to the **proxy's IP/CIDR** (e.g. `10.0.0.5`). Without it every client shares the proxy's address for the login limits. A hop count (`1`) or `true` is only safe when chirp is reachable *only* through the proxy (`CHIRP_HOST=127.0.0.1` or a firewall); otherwise direct clients can forge `X-Forwarded-For`. See [`docs/deploy.md`](docs/deploy.md#security).
- `CHIRP_ADMIN_PASSWORD` stays in plain text in the environment after the account exists; remove it after the first start and change the password in the dashboard.
- Sign-in sessions are HttpOnly, SameSite=Strict cookies (12 h idle, 7 days max). Passwords must be 10+ characters and not a common one. Failed logins back off per address (up to 15 min) and per username (up to 5 s), with a daily budget of 1000 failures per username. A sustained attack can delay or, after the budget is spent, block sign-ins from *new* addresses, but never an address you signed in from before, open sessions or Home Assistant; `admin reset-password` or a restart clears it ([details](docs/api.md#login-rate-limiting)). The API key cannot be used to read or change the key or the account.
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
