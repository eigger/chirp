#!/usr/bin/env bash
# Smoke-test an unpacked release tree (or tarball): every runtime import must
# resolve from the tree alone, the server must start and answer /health, and
# the CLI must work. Usage: scripts/ci/smoke-release.sh <dir|chirp-x.tar.gz>
set -euo pipefail

SRC="${1:?usage: scripts/ci/smoke-release.sh <dir|tarball>}"
WORK="$(mktemp -d)"
PID=""
cleanup() {
  if [[ -n "$PID" ]]; then kill "$PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

if [[ -f "$SRC" ]]; then
  mkdir -p "$WORK/app"
  tar -xzf "$SRC" -C "$WORK/app"
  APP="$WORK/app"
else
  APP="$(cd "$SRC" && pwd)"
fi

# Run from outside the repository so nothing resolves through a parent node_modules.
cd "$WORK"
echo "[smoke] import every server module"
for m in "$APP"/apps/server/dist/*.js; do
  case "$(basename "$m")" in index.js|cli.js|healthcheck.js) continue ;; esac
  node --input-type=module -e "await import(process.argv[1])" "$m"
done

export CHIRP_DATA_DIR="$WORK/data" CHIRP_HOST=127.0.0.1 CHIRP_SMARTCTL=/nonexistent-smartctl
PORT="${SMOKE_PORT:-18080}"
export CHIRP_PORT="$PORT"

SETUP_TOKEN="smoke-token-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
export CHIRP_SETUP_TOKEN="$SETUP_TOKEN"
ENV_FILE="$WORK/chirp.env"
echo "CHIRP_PORT=$PORT" >"$ENV_FILE"
echo "CHIRP_SETUP_TOKEN=$SETUP_TOKEN" >>"$ENV_FILE"
export CHIRP_ENV_FILE="$ENV_FILE"

echo "[smoke] start server on 127.0.0.1:${PORT}"
node "$APP/apps/server/dist/index.js" >"$WORK/server.log" 2>&1 &
PID=$!
ok=0
for _ in $(seq 1 50); do
  if node "$APP/apps/server/dist/healthcheck.js"; then ok=1; break; fi
  sleep 0.2
done
if [[ "$ok" -ne 1 ]]; then
  echo "[smoke] /health did not answer" >&2
  cat "$WORK/server.log" >&2
  exit 1
fi
echo "[smoke] cli key show (the server generated the key on first start)"
KEY="$(node "$APP/apps/server/dist/cli.js" key show)"
[[ "$KEY" == chp_* ]] || { echo "[smoke] unexpected key output" >&2; exit 1; }

echo "[smoke] bootstrap -> login -> read key -> /status -> regenerate -> old key 401"
PASSWORD="smoke-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(9).toString("hex"))')"
cat >"$WORK/flow.mjs" <<'EOF2'
const [base, oldKey, password, setupToken] = process.argv.slice(2);
const csrf = { "x-chirp-csrf": "1", "content-type": "application/json" };
const fail = (msg) => { console.error(`[smoke] ${msg}`); process.exit(1); };
const expect = (res, status, what) => { if (res.status !== status) fail(`${what}: expected ${status}, got ${res.status}`); };
const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const status = (key) => fetch(`${base}/api/v1/status`, { headers: { authorization: `Bearer ${key}` } });

let res = await fetch(`${base}/api/v1/bootstrap/status`);
expect(res, 200, "bootstrap status");
const statusData = await res.json();
if (statusData.needsBootstrap !== true) fail("a fresh server should need bootstrap");
if (statusData.setupTokenRequired !== true) fail("a server with CHIRP_SETUP_TOKEN must report setupTokenRequired: true");

// 1. Missing setup token -> 403 unauthorized
res = await fetch(`${base}/api/v1/bootstrap/admin`, {
  method: "POST", headers: csrf, body: JSON.stringify({ username: "admin", password, passwordConfirm: password }),
});
expect(res, 403, "bootstrap without setup token");
if ((await res.json()).error !== "unauthorized") fail("missing token must answer unauthorized");

// 2. Wrong setup token -> 403 unauthorized
res = await fetch(`${base}/api/v1/bootstrap/admin`, {
  method: "POST", headers: csrf, body: JSON.stringify({ username: "admin", password, passwordConfirm: password, setupToken: "wrong" }),
});
expect(res, 403, "bootstrap with wrong setup token");
if ((await res.json()).error !== "unauthorized") fail("wrong token must answer unauthorized");

// 3. Mismatched confirmation with correct token -> 400 password_mismatch
res = await fetch(`${base}/api/v1/bootstrap/admin`, {
  method: "POST", headers: csrf, body: JSON.stringify({ username: "admin", password, passwordConfirm: password + "x", setupToken }),
});
expect(res, 400, "bootstrap with a mismatched confirmation");
if ((await res.json()).error !== "password_mismatch") fail("mismatched confirmation must be error=password_mismatch");

// 4. Correct setup token -> 201 created
res = await fetch(`${base}/api/v1/bootstrap/admin`, {
  method: "POST", headers: csrf, body: JSON.stringify({ username: "admin", password, passwordConfirm: password, setupToken }),
});
expect(res, 201, "bootstrap");

// 5. Subsequent attempt -> 409 conflict
res = await fetch(`${base}/api/v1/bootstrap/admin`, {
  method: "POST", headers: csrf, body: JSON.stringify({ username: "mallory", password, passwordConfirm: password, setupToken }),
});
expect(res, 409, "second bootstrap");
res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: csrf, body: JSON.stringify({ username: "admin", password }) });
expect(res, 200, "login");
const cookie = cookieOf(res);
if (!cookie.startsWith("chirp_session=")) fail("login set no session cookie");
res = await fetch(`${base}/api/v1/admin/api-key`, { headers: { cookie } });
expect(res, 200, "read key");
const shown = await res.json();
if (shown.key !== oldKey || shown.source !== "file") fail("dashboard key differs from cli key show");
expect(await fetch(`${base}/api/v1/admin/api-key`, { headers: { authorization: `Bearer ${oldKey}` } }), 403, "key endpoint with Bearer");
expect(await status(oldKey), 200, "/status with the key");
expect(await fetch(`${base}/api/v1/status`, { headers: { cookie } }), 200, "/status with the session");
expect(await fetch(`${base}/api/v1/admin/api-key/regenerate`, { method: "POST", headers: { cookie } }), 403, "regenerate without CSRF header");
res = await fetch(`${base}/api/v1/admin/api-key/regenerate`, { method: "POST", headers: { cookie, "x-chirp-csrf": "1" } });
expect(res, 200, "regenerate");
const { key: newKey } = await res.json();
expect(await status(oldKey), 401, "/status with the old key");
expect(await status(newKey), 200, "/status with the new key");
res = await fetch(`${base}/api/v1/auth/logout`, { method: "POST", headers: { cookie, "x-chirp-csrf": "1" } });
expect(res, 204, "logout");
expect(await fetch(`${base}/api/v1/auth/me`, { headers: { cookie } }), 401, "session after logout");
console.log(newKey);
EOF2
NEW_KEY="$(node "$WORK/flow.mjs" "http://127.0.0.1:${PORT}" "$KEY" "$PASSWORD" "$SETUP_TOKEN")"
[[ "$NEW_KEY" == chp_* ]] || { echo "[smoke] regenerate returned no key" >&2; exit 1; }
[[ "$(node "$APP/apps/server/dist/cli.js" key show)" == "$NEW_KEY" ]] || { echo "[smoke] cli key show does not see the regenerated key" >&2; exit 1; }
[[ "$(node "$APP/apps/server/dist/cli.js" admin show-user)" == admin ]] || { echo "[smoke] cli admin show-user" >&2; exit 1; }

if grep -q "CHIRP_SETUP_TOKEN" "$ENV_FILE"; then
  echo "[smoke] CHIRP_SETUP_TOKEN was not removed from chirp.env after bootstrap" >&2
  exit 1
fi

for secret in "$KEY" "$NEW_KEY" "$PASSWORD" "$SETUP_TOKEN"; do
  if grep -qF "$secret" "$WORK/server.log"; then
    echo "[smoke] a key or password leaked into the log" >&2
    exit 1
  fi
done

# Stop the HTTP server before running the TLS server
kill "$PID" 2>/dev/null || true
PID=""

PORT_TLS=$((PORT + 1))
echo "[smoke] TLS server on https://127.0.0.1:${PORT_TLS}"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -days 1 -subj "/CN=localhost" 2>/dev/null
CHIRP_PORT="$PORT_TLS" CHIRP_TLS_CERT="$WORK/cert.pem" CHIRP_TLS_KEY="$WORK/key.pem" node "$APP/apps/server/dist/index.js" >"$WORK/tls-server.log" 2>&1 &
PID="$!"

ok=0
for _ in $(seq 1 50); do
  if CHIRP_PORT="$PORT_TLS" CHIRP_TLS_CERT="$WORK/cert.pem" CHIRP_TLS_KEY="$WORK/key.pem" node "$APP/apps/server/dist/healthcheck.js"; then ok=1; break; fi
  sleep 0.2
done
if [[ "$ok" -ne 1 ]]; then
  echo "[smoke] TLS /health did not answer" >&2
  cat "$WORK/tls-server.log" >&2
  exit 1
fi

kill "$PID" 2>/dev/null || true
PID=""

echo "[smoke] OK"
