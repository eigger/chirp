#!/usr/bin/env bash
# Exercise proxmox/install/update.sh end to end with stubbed curl/systemctl:
# first install, failed first install (no dangling `current` link), failed
# upgrade (rollback), sha256 mismatch, and the CHIRP_HOST-aware health probe.
# Needs GNU coreutils/findutils (Linux; on macOS: brew install coreutils findutils).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UPDATE_SH="$REPO_ROOT/proxmox/install/update.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"

# GNU tools: use g-prefixed ones on macOS.
if ! mv --version >/dev/null 2>&1; then
  for t in mv find sha256sum readlink stat date ln install; do
    if command -v "g$t" >/dev/null 2>&1; then ln -s "$(command -v "g$t")" "$BIN/$t"; fi
  done
  if [[ ! -e "$BIN/mv" || ! -e "$BIN/find" || ! -e "$BIN/sha256sum" ]]; then
    echo "SKIP: GNU coreutils/findutils not available"
    exit 0
  fi
fi

PASS=0; FAILS=0
eq() { # name expected actual
  if [[ "$2" == "$3" ]]; then PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"
  else FAILS=$((FAILS + 1)); printf '  FAIL %s\n    expected: %q\n    actual:   %q\n' "$1" "$2" "$3"; fi
}

# --- stubs -------------------------------------------------------------------
cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
# Minimal curl: serves files from $STUB_DIR, logs every URL, fakes /health.
out=""; url=""
while (($#)); do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >>"$STUB_DIR/curl.log"
case "$url" in
  */health) [[ "$STUB_HEALTH" == ok ]] && { echo '{"status":"ok"}'; exit 0; }; exit 7 ;;
  *api.github.com*) src="$STUB_DIR/release.json" ;;
  */chirp-*.tar.gz.sha256) src="$STUB_DIR/$(basename "$url")" ;;
  */chirp-*.tar.gz) src="$STUB_DIR/$(basename "$url")" ;;
  *) exit 22 ;;
esac
[[ -f "$src" ]] || exit 22
if [[ -n "$out" ]]; then cp "$src" "$out"; else cat "$src"; fi
EOF
cat >"$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/systemctl.log"
EOF
if ! command -v jq >/dev/null 2>&1; then
  NODE_BIN="$(command -v node || echo node)"
  cat >"$BIN/jq" <<EOF
#!/usr/bin/env bash
"$NODE_BIN" -e '
const fs = require("fs");
const args = process.argv.slice(1);
const file = args[args.length - 1];
const filter = args.find(a => a.startsWith(".") || a.startsWith("["));
const json = JSON.parse(fs.readFileSync(file, "utf8"));
if (filter === ".tag_name") {
  console.log(json.tag_name || "");
} else if (filter && filter.includes("^chirp-")) {
  const a = (json.assets || []).find(x => /^chirp-.+\\.tar\\.gz\$/.test(x.name));
  console.log(a ? a.name : "");
} else if (filter && filter.includes(".browser_download_url")) {
  const nIdx = args.indexOf("--arg");
  const name = nIdx !== -1 ? args[nIdx + 2] : "";
  const a = (json.assets || []).find(x => x.name === name);
  console.log(a ? a.browser_download_url : "");
}
' -- "\$@"
EOF
  chmod +x "$BIN/jq"
fi
chmod +x "$BIN/curl" "$BIN/systemctl"

export STUB_DIR="$WORK/stub"
mkdir -p "$STUB_DIR"

make_release() { # version [corrupt-sha]
  local ver="$1" tree="$WORK/tree-$1"
  mkdir -p "$tree/apps/server/dist" "$tree/apps/web/dist" "$tree/node_modules"
  echo "// $ver" >"$tree/apps/server/dist/index.js"
  tar -czf "$STUB_DIR/chirp-${ver}.tar.gz" -C "$tree" .
  if [[ "${2:-}" == corrupt ]]; then
    echo "0000000000000000000000000000000000000000000000000000000000000000  chirp-${ver}.tar.gz" >"$STUB_DIR/chirp-${ver}.tar.gz.sha256"
  else
    (cd "$STUB_DIR" && sha256sum "chirp-${ver}.tar.gz" >"chirp-${ver}.tar.gz.sha256")
  fi
  cat >"$STUB_DIR/release.json" <<JSON
{"tag_name":"v${ver}","assets":[
 {"name":"chirp-${ver}.tar.gz","browser_download_url":"https://example.invalid/chirp-${ver}.tar.gz"},
 {"name":"chirp-${ver}.tar.gz.sha256","browser_download_url":"https://example.invalid/chirp-${ver}.tar.gz.sha256"}]}
JSON
}

run_update() { # health(ok|fail) [args...]
  local health="$1"; shift
  : >"$STUB_DIR/curl.log"; : >"$STUB_DIR/systemctl.log"
  STUB_HEALTH="$health" PATH="$BIN:$PATH" CHIRP_DIR="$CHIRP" CHIRP_ENV_FILE="$ENVF" \
    UPDATE_BIN="$WORK/update-bin" CHIRP_SELF_UPDATED=1 HEALTH_TIMEOUT_SEC=2 \
    bash "$UPDATE_SH" "$@" >"$WORK/out.log" 2>&1
}

CHIRP="$WORK/opt/chirp"
ENVF="$WORK/chirp.env"
cp "$UPDATE_SH" "$WORK/update-bin"

echo "[1] first install fails its health check: no dangling current link"
printf 'CHIRP_PORT=8080\nCHIRP_HOST=0.0.0.0\n' >"$ENVF"
make_release 1.0.0
run_update fail; rc=$?
eq "exit 1" "1" "$rc"
eq "current link removed" "absent" "$([[ -L "$CHIRP/current" || -e "$CHIRP/current" ]] && echo present || echo absent)"
eq "release dir removed" "absent" "$([[ -d "$CHIRP/releases/1.0.0" ]] && echo present || echo absent)"
eq "service stopped" "1" "$(grep -c '^stop chirp$' "$STUB_DIR/systemctl.log")"
eq "wildcard host probes loopback" "1" "$(grep -c '^http://127.0.0.1:8080/health$' "$STUB_DIR/curl.log" | awk '{print ($1>0)}')"

echo "[2] first install succeeds"
run_update ok; rc=$?
eq "exit 0" "0" "$rc"
eq "current -> 1.0.0" "1.0.0" "$(basename "$(readlink -f "$CHIRP/current")")"

echo "[3] specific CHIRP_HOST is probed on that address"
printf 'CHIRP_PORT="9000"\nCHIRP_HOST=192.168.1.5\n' >"$ENVF"
make_release 1.1.0
run_update ok; rc=$?
eq "exit 0" "0" "$rc"
eq "probe url" "http://192.168.1.5:9000/health" "$(grep '/health$' "$STUB_DIR/curl.log" | head -n1)"
printf 'CHIRP_HOST=fd00::5\n' >"$ENVF"
run_update ok --force
eq "ipv6 probe url" "http://[fd00::5]:80/health" "$(grep '/health$' "$STUB_DIR/curl.log" | head -n1)"

echo "[4] failed upgrade rolls back"
printf 'CHIRP_HOST=::\n' >"$ENVF"
BEFORE="$(readlink -f "$CHIRP/current")"
make_release 1.2.0
run_update fail; rc=$?
eq "exit 1" "1" "$rc"
eq "current restored" "$BEFORE" "$(readlink -f "$CHIRP/current")"
eq "failed release removed" "absent" "$([[ -d "$CHIRP/releases/1.2.0" ]] && echo present || echo absent)"
eq "'::' probes loopback" "http://127.0.0.1:80/health" "$(grep '/health$' "$STUB_DIR/curl.log" | head -n1)"

echo "[5] sha256 mismatch aborts before touching anything"
make_release 1.3.0 corrupt
run_update ok; rc=$?
eq "exit 1" "1" "$rc"
eq "mismatch reported" "1" "$(grep -c 'sha256 mismatch' "$WORK/out.log")"
eq "current unchanged" "$BEFORE" "$(readlink -f "$CHIRP/current")"

echo "[6] TLS configuration probes https"
printf 'CHIRP_PORT=8443\nCHIRP_TLS_CERT=/etc/chirp/cert.pem\nCHIRP_TLS_KEY=/etc/chirp/key.pem\n' >"$ENVF"
make_release 1.4.0
run_update ok; rc=$?
eq "exit 0" "0" "$rc"
eq "tls probe url" "https://127.0.0.1:8443/health" "$(grep '/health$' "$STUB_DIR/curl.log" | head -n1)"

echo
echo "passed=${PASS} failed=${FAILS}"
[[ "$FAILS" -eq 0 ]]
