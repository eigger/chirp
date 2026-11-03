# chirp deployment guide

[한국어](ko/deploy.md)

## Requirements

- Linux host (Proxmox VE recommended), Node.js 24, `smartmontools`
- Port 80 (change with `CHIRP_PORT`, an integer 1-65535)
- Access to the host's block devices and `/sys`

## 1. Proxmox one-liner

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
```

Creates a privileged LXC, installs the release tarball, passes the selected disks through and prints the dashboard URL. Script details are in `proxmox/`.

**Right after installing, open `http://<container IP>/` and create the admin account** (username, password twice). Until an admin exists, the dashboard offers this first-run registration to *anyone* who can reach it, so do it immediately (or keep the container unreachable until you have). Then copy the API key from **Settings -> API key** into Home Assistant. Forgot the password: `pct exec <CTID> -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password` (prints a new random password and signs out every session).

### Disk passthrough and its permissions

`proxmox/install/chirp-passthrough.sh` (run on the host; re-run after adding or replacing disks) bind-mounts each selected disk's `/dev/disk/by-id/...` node into the container and adds one cgroup rule per device major:

```
lxc.cgroup2.devices.allow: b 8:* rw
lxc.mount.entry: /dev/disk/by-id/wwn-0x5000c500a1b2c3d4 dev/disk/by-id/wwn-0x5000c500a1b2c3d4 none bind,optional,create=file
```

- **`rw`, not `rwm`.** The disks are bind-mounted, so the container never needs `mknod`; smartctl opens SCSI/SAT devices read-write for SG_IO, so `r` alone is not enough. Override with `CHIRP_DEV_PERM` (e.g. `CHIRP_DEV_PERM=rwm`).
- **Major wildcard (`8:*`), not exact `major:minor`.** `sd` minors follow probe order and NVMe namespaces (major 259) get dynamic minors, so a rule for an exact minor would point at the wrong disk, or none, after a host reboot or hotplug. The by-id bind mounts are re-resolved on every container start; static cgroup rules are not, and Proxmox offers no hook that can rewrite them before the container starts.
- **Risk:** root in the container can reach other block devices with the same major, including the host's boot disk if it is also `sd*`/NVMe. That is no worse than a privileged container already is (its root is effectively host root), but keep the container on a trusted network and do not run anything else in it.

## 2. Docker

```bash
docker run -d --name chirp \
  --privileged -p 80:80 \
  -v /sys:/sys:ro -v chirp-data:/var/lib/chirp \
  --device /dev/sda --device /dev/nvme0 \
  -e CHIRP_DEVICES=/dev/sda,/dev/nvme0 \
  ghcr.io/eigger/chirp:latest
```

- **Admin account:** open `http://<host>/` right after the first start and create it (until then anyone who can reach the port can). For unattended setups add `-e CHIRP_ADMIN_USER=admin -e CHIRP_ADMIN_PASSWORD=<10+ characters>`: the account is created on start when none exists (the variables are ignored afterwards and never overwrite a changed password). Reset: `docker exec chirp node apps/server/dist/cli.js admin reset-password`.
- **`CHIRP_ADMIN_PASSWORD` stays visible** in `docker inspect` and your compose file after the account exists: remove both variables after the first start and change the password in the dashboard.
- Instead of `--privileged` you can combine `--cap-add SYS_RAWIO --cap-add SYS_ADMIN` with `--device`.
- Mount `/sys` read-only so the host's CPU sensors (hwmon) are visible; it also lets chirp derive stable disk IDs from sysfs without waking disks.
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
- the probe uses `CHIRP_HOST`/`CHIRP_PORT` from `/etc/chirp/chirp.env` (`127.0.0.1` for `0.0.0.0`/`::`, otherwise the configured address);
- if the health check fails, the previous release is restored; on a first install (nothing to roll back to) the service is stopped and the `current` link is removed instead of being left dangling.

## Environment variables

See [`.env.example`](../.env.example). Key ones: `CHIRP_API_KEY` (wins, at least 16 characters, read-only in the dashboard) / `CHIRP_API_KEY_FILE`, `CHIRP_PRINT_KEY`, `CHIRP_ADMIN_USER` + `CHIRP_ADMIN_PASSWORD` (seed the admin), `CHIRP_COOKIE_SECURE` (`auto`/`true`/`false`), `CHIRP_DATA_DIR`, `CHIRP_DEVICES`, `CHIRP_DEVICE_TYPES`, `CHIRP_SCAN_MODE`, `CHIRP_RESCAN_INTERVAL`, `CHIRP_SMART_INTERVAL`, `CHIRP_SENSOR_INTERVAL`, `CHIRP_TEMP_WARN_{HDD,SSD,NVME}`, `CHIRP_WEB_DIR`, `CHIRP_TRUST_PROXY` (`false`, proxy IPs/CIDRs (recommended), a hop count such as `1`, or `true`; see Security), `CHIRP_LOGIN_DAILY_BUDGET` (default 1000), `CHIRP_CORS_ORIGINS`. Invalid values stop the server with a message such as `chirp: invalid configuration: CHIRP_PORT must be an integer between 1 and 65535 (got "80a")`.

## Release procedure

1. Set the same `version` in the root, `packages/shared`, `apps/server` and `apps/web` `package.json` files (`release.yml` checks this).
2. Publish a GitHub Release tagged `v<version>`.
3. `release.yml` checks tag/version, builds, packages and smoke-tests the tarball, then uploads it with its sha256; `docker-release.yml` pushes semver/latest tags to `ghcr.io/eigger/chirp`.

## Security

- **First-run registration window.** Until the admin account exists, whoever opens the dashboard first can create it. Create it right after installing, or seed it with `CHIRP_ADMIN_USER`/`CHIRP_ADMIN_PASSWORD`. The server log warns on every start while no admin exists.
- **Plain HTTP exposes credentials.** Without TLS the admin password (at login), the session cookie and the API key cross the network in clear text. On anything but a trusted LAN put chirp behind a TLS reverse proxy (Caddy, nginx, Traefik) or Tailscale. Force the cookie's `Secure` flag with `CHIRP_COOKIE_SECURE=true` if chirp cannot tell the request came over HTTPS.
- **Behind a reverse proxy, configure `CHIRP_TRUST_PROXY`.**
  - Without it chirp sees every client as the proxy's address. The login backoff then treats all users as one source: one attacker's failed logins make everyone wait, up to 15 min, and a "known" source means anyone behind the proxy. The session cookie also gets no automatic `Secure` flag.
  - **Recommended:** the proxy's own address(es), e.g. `CHIRP_TRUST_PROXY=10.0.0.5` or `10.0.0.0/24,fd00::/64`. Then `X-Forwarded-For`/`-Proto` are believed only when the request really comes from the proxy.
  - A **hop count** (`1`) or `true` believes those headers from *any* peer. That is safe only when chirp can be reached **only through the proxy**: bind it to loopback (`CHIRP_HOST=127.0.0.1` with the proxy on the same host) or firewall the port. Otherwise anyone who connects directly can forge `X-Forwarded-For` (a fresh address per request dodges the per-source backoff) and `X-Forwarded-Proto`. `true` is additionally unsafe unless the proxy *overwrites* `X-Forwarded-For` (nginx `proxy_set_header X-Forwarded-For $remote_addr;`). chirp logs a warning when a hop count or `true` is used with a wildcard bind.
- **Login limits.** Each source (IPv4 address or IPv6 /64) backs off up to 15 min. The username backs off up to 5 s, but only for sources that already failed and never signed in. At most 1000 failed attempts per username per 24 h are allowed (`CHIRP_LOGIN_DAILY_BUDGET`); after that only addresses that signed in before may try. A sustained attack can therefore slow logins from new addresses, and after the budget is spent block them for up to 24 h, but it never affects an address you signed in from before, open sessions, Home Assistant or the CLI. Recovery: `cli.js admin reset-password` (also resets the budget) or restart the service. Details: [`api.md`](api.md#login-rate-limiting).
- **`CHIRP_ADMIN_PASSWORD` stays readable in plain text** in the environment (`docker inspect`, compose files, `/proc/<pid>/environ`) even after the account exists. After the first start remove `CHIRP_ADMIN_USER`/`CHIRP_ADMIN_PASSWORD` and change the password in the dashboard (Settings -> Change password).
- **The CLI reads the service settings.** `cli.js` loads `/etc/chirp/chirp.env` when it exists (or `--env-file <path>` / `CHIRP_ENV_FILE`), so `pct exec <CTID> -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password` uses the same data directory as the service.
- Sessions: HttpOnly + SameSite=Strict cookie, 12 h idle / 7 days max, kept in memory (a restart signs everyone out), all ended by a password change. Passwords must be 10-256 characters and not a common/guessable one.
- A privileged container is assumed; its root is effectively host root (see above).
