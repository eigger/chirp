# chirp — agent guide

Monitoring server that collects the CPU temperature, disk SMART data and host metrics (memory, load, network, power, fans, voltages) of a Proxmox host and serves them as a REST API and a dashboard.

## Read first

| Document | Contents |
|---|---|
| [`packages/shared/src/schema.ts`](packages/shared/src/schema.ts) | **Single source of truth for the API contract (zod).** Server, web and hass-chirp all follow it |
| [`docs/PROJECT.md`](docs/PROJECT.md) | Structure and decisions |
| [`docs/api.md`](docs/api.md) | Endpoint reference |
| [`docs/deploy.md`](docs/deploy.md) | Proxmox / Docker / tarball deployment |

## Layout

```
packages/shared   zod schema (the contract)
apps/server       Fastify 5 server (@chirp/server): collection, scheduler, API, static serving
apps/web          dashboard (static build, served by the server)
proxmox/          LXC install/update scripts
scripts/          release packaging; scripts/ci = CI checks
```

## Conventions

- Node 24, TypeScript ESM, Fastify 5, zod 4, vitest 4, eslint 9. No database.
- **Schema first.** Change `schema.ts` before changing any response field. Adding fields is compatible; removing a field or changing its meaning bumps `API_VERSION`.
- **Disk health is decided only in `apps/server/src/health.ts`.** Clients (web, Home Assistant) never re-derive it.
- **Never wake a disk.** `smartctl -n standby` always; a disk in standby keeps its last values. Device discovery uses `smartctl --scan` (does not open devices) and is cached.
- `disk.id` is WWN first (`wwn_<hex>`), else a model+serial slug, and never changes once assigned (`diskIdentity.ts` derives it without waking the disk and pins it in `<dataDir>/disk-ids.json`). `/dev/sdX` is never an ID; `dev_<name>` is only a provisional placeholder.
- GET never triggers collection; it returns the cache. Collection runs only from the scheduler (sensors + host metrics 10 s, SMART 300 s) and `POST /refresh` (30 s cooldown).
- **Host metrics are optional fields** (`memory`, `load`, `network`, `power`, `fans`, `voltages`): absent on older servers, a section that cannot be read is `null`. `/proc` reads go through `hostPaths.ts` (`CHIRP_HOST_PROC`/`CHIRP_HOST_SYS`, host root first) and carry `scope: "host" | "container"`; never read `/proc` or `/sys/class/net` directly for host values. Parsers take a root path so tests use fake trees. Each section fails in isolation (logged once).
- History points are `[epochMs, value]`.
- Pure JavaScript dependencies only (the release tarball must run without native builds).
- Every response must pass the `@chirp/shared` schema; tests check this with `parse`. Error bodies are `{"error": <code>}` (`ErrorResponse`).
- **Auth rules.** Data routes (`/status`, `/disks`, `/history`, `/refresh`) take the Bearer API key *or* the session cookie; everything under `/auth/me`, `/auth/password`, `/admin/*` is session-only and answers `403` to any `Authorization` header. Every non-GET request that is not Bearer-authenticated needs `X-Chirp-Csrf: 1`. Mark routes with `config: { auth: "public" | "data" | "session" }` (`auth.ts`); the default is `data`. Never log a password, session token or API key (the key only with `CHIRP_PRINT_KEY=true`). Credential files (`admin.json`, `api-key`) are 0600 and written atomically (`secureFile.ts`); the admin is created exclusively and only while none exists. Password + confirmation are checked by the shared zod schemas (`password_mismatch`) and again in the dashboard.
- English everywhere (code, comments, logs, scripts, docs). Korean lives only in `README.ko.md`, `docs/ko/` and the dashboard's `ko` dictionary in `apps/web/src/i18n.ts`.

## Commands

```bash
npm install
npm run build:shared
npm run build -w @chirp/server
npm test -w @chirp/server
npm run lint -w @chirp/server
bash scripts/ci/check-proxmox.sh          # shell scripts: syntax, shellcheck, passthrough + update.sh tests
node apps/server/dist/cli.js key show|rotate
node apps/server/dist/cli.js admin reset-password|show-user
SMOKE_PORT=18090 bash scripts/ci/smoke-release.sh .   # after npm run build: real server, bootstrap/login/key flow
```

## Commits

Prefixes `feat:` / `fix:` / `chore:` / `docs:`. `git pull` before you start.
