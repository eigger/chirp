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
STATUS="$(node -e 'fetch(process.argv[1],{headers:{authorization:"Bearer "+process.argv[2]}}).then(r=>console.log(r.status))' \
  "http://127.0.0.1:${PORT}/api/v1/status" "$KEY")"
[[ "$STATUS" == 200 ]] || { echo "[smoke] /api/v1/status returned $STATUS" >&2; exit 1; }
if grep -q "$KEY" "$WORK/server.log"; then
  echo "[smoke] the API key leaked into the log" >&2
  exit 1
fi
echo "[smoke] OK"
