#!/usr/bin/env bash
# chirp LXC update: download the latest release tarball, verify its sha256,
# unpack it into releases/<ver> and swap the `current` link atomically. If
# /health does not answer, roll back to the previous release.
#
# Integrity only: the .sha256 asset comes from the same GitHub release as the
# tarball, so it detects corrupted/truncated downloads, not a tampered release.
# Authenticity rests on HTTPS + GitHub; there is no signature verification.
env_value() {
  # Last NAME=value in the env file, without surrounding quotes/whitespace.
  local v
  v="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  if [[ "$v" != \"* && "$v" != \'* ]]; then v="${v%%#*}"; fi
  v="${v//\"/}"; v="${v//\'/}"
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

collector_notice() {
  local snapshot
  if grep -qE '^[[:space:]]*CHIRP_HOST_SNAPSHOT=' "$ENV_FILE"; then
    snapshot="$(env_value CHIRP_HOST_SNAPSHOT)"
    case "$(printf '%s' "$snapshot" | tr '[:upper:]' '[:lower:]')" in
      ""|none|0|false) return ;;
    esac
  elif [[ ! -d "$1" ]]; then
    return
  fi
  echo "[update] Host collector version cannot be checked from this container."
  echo "[update] On the Proxmox host, re-run chirp-passthrough.sh for this CT to update the collector."
}


# Allow tests to source the helpers without running an update.
if [[ "${CHIRP_UPDATE_LIB:-0}" == "1" ]]; then return 0; fi

set -euo pipefail

CHIRP_DIR="${CHIRP_DIR:-/opt/chirp}"
CHIRP_REPO="${CHIRP_REPO:-eigger/chirp}"
ENV_FILE="${CHIRP_ENV_FILE:-/etc/chirp/chirp.env}"
RELEASES_DIR="${CHIRP_DIR}/releases"
CURRENT_LINK="${CHIRP_DIR}/current"
UPDATE_BIN="${UPDATE_BIN:-/usr/bin/update}"
SERVICE="${CHIRP_SERVICE:-chirp}"
KEEP_RELEASES=2
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-30}"
FORCE=0

set -a
# shellcheck disable=SC1091
[ -f /etc/profile.d/90-http-proxy.sh ] && . /etc/profile.d/90-http-proxy.sh
set +a

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      echo "Usage: update [--force]"
      echo "  --force  re-download and re-apply even if already up to date"
      echo "  CHIRP_REF=v1.2.3 update  # install a specific release tag instead of the latest"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No chirp installation found (missing ${ENV_FILE})" >&2
  exit 1
fi

TMPDIR_UPD="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_UPD"' EXIT

# --- resolve the release ---
if [[ -n "${CHIRP_REF:-}" ]]; then
  API_URL="https://api.github.com/repos/${CHIRP_REPO}/releases/tags/${CHIRP_REF}"
else
  API_URL="https://api.github.com/repos/${CHIRP_REPO}/releases/latest"
fi
if ! curl -fsSL "$API_URL" -o "${TMPDIR_UPD}/release.json"; then
  echo "[update] Could not fetch release info: ${API_URL}" >&2
  echo "         CHIRP_REF must be a release tag (tarballs only exist on releases)." >&2
  exit 1
fi

TAG="$(jq -r .tag_name "${TMPDIR_UPD}/release.json")"
TAR_NAME="$(jq -r '[.assets[].name | select(test("^chirp-.+\\.tar\\.gz$"))][0] // empty' "${TMPDIR_UPD}/release.json")"
if [[ -z "$TAG" || "$TAG" == "null" || -z "$TAR_NAME" ]]; then
  echo "[update] No chirp-<version>.tar.gz asset found in the release." >&2
  exit 1
fi
SHA_NAME="${TAR_NAME}.sha256"
TAR_URL="$(jq -r --arg n "$TAR_NAME" '.assets[] | select(.name==$n) | .browser_download_url' "${TMPDIR_UPD}/release.json")"
SHA_URL="$(jq -r --arg n "$SHA_NAME" '.assets[] | select(.name==$n) | .browser_download_url' "${TMPDIR_UPD}/release.json")"
if [[ -z "$SHA_URL" ]]; then
  echo "[update] ${SHA_NAME} asset is missing; cannot verify integrity. Aborting." >&2
  exit 1
fi

NEW_VER="${TAR_NAME#chirp-}"
NEW_VER="${NEW_VER%.tar.gz}"
if [[ ! "$NEW_VER" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; then
  echo "[update] Refusing unexpected version string: ${NEW_VER}" >&2
  exit 1
fi

# --- self-update update.sh (from the release tag) ---
if [[ -z "${CHIRP_SELF_UPDATED:-}" ]]; then
  SELF_URL="https://raw.githubusercontent.com/${CHIRP_REPO}/${TAG}/proxmox/install/update.sh"
  if curl -fsSL "$SELF_URL" -o "${TMPDIR_UPD}/update.sh.new" \
    && [[ -s "${TMPDIR_UPD}/update.sh.new" ]] \
    && bash -n "${TMPDIR_UPD}/update.sh.new"; then
    if ! cmp -s "${TMPDIR_UPD}/update.sh.new" "$UPDATE_BIN"; then
      echo "[update] Updating update.sh to ${TAG} and re-running it."
      install -m 0755 "${TMPDIR_UPD}/update.sh.new" "$UPDATE_BIN"
      # exec does not run the EXIT trap, so remove the temp dir first.
      rm -rf "$TMPDIR_UPD"
      trap - EXIT
      CHIRP_SELF_UPDATED=1 exec "$UPDATE_BIN" "$@"
    fi
  else
    echo "[update] Skipping update.sh self-update (download or syntax check failed)." >&2
  fi
fi


PREV_TARGET=""
PREV_VER=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREV_TARGET="$(readlink -f "$CURRENT_LINK")"
  PREV_VER="$(basename "$PREV_TARGET")"
  # A --force reinstall (<ver>.r<epoch>) counts as the same version; otherwise every run reinstalls.
  if [[ "$PREV_VER" =~ ^(.+)\.r[0-9]+$ ]]; then
    PREV_VER="${BASH_REMATCH[1]}"
  fi
fi

if [[ "$PREV_VER" == "$NEW_VER" && "$FORCE" -ne 1 ]]; then
  echo "chirp ${NEW_VER} is already up to date. (use --force to reinstall)"
  exit 0
fi

# --- download + sha256 check (integrity, not authenticity) ---
echo "[update] Downloading ${TAR_NAME}"
curl -fsSL "$TAR_URL" -o "${TMPDIR_UPD}/${TAR_NAME}"
curl -fsSL "$SHA_URL" -o "${TMPDIR_UPD}/${SHA_NAME}"
EXPECTED="$(awk '{print $1; exit}' "${TMPDIR_UPD}/${SHA_NAME}")"
ACTUAL="$(sha256sum "${TMPDIR_UPD}/${TAR_NAME}" | awk '{print $1}')"
if [[ -z "$EXPECTED" || "$EXPECTED" != "$ACTUAL" ]]; then
  echo "[update] sha256 mismatch, aborting. (expected=${EXPECTED:-none} actual=${ACTUAL})" >&2
  exit 1
fi
echo "[update] sha256 OK"

# --- unpack (staging dir, then rename) ---
mkdir -p "$RELEASES_DIR"
STAGE="${RELEASES_DIR}/.${NEW_VER}.tmp"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "${TMPDIR_UPD}/${TAR_NAME}" -C "$STAGE"
if [[ ! -f "${STAGE}/apps/server/dist/index.js" || ! -d "${STAGE}/apps/web/dist" || ! -d "${STAGE}/node_modules" ]]; then
  echo "[update] Unexpected tarball layout (needs apps/server/dist, apps/web/dist, node_modules)." >&2
  rm -rf "$STAGE"
  exit 1
fi
NEW_DIR="${RELEASES_DIR}/${NEW_VER}"
if [[ "$NEW_DIR" == "$PREV_TARGET" ]]; then
  # --force reinstall of the running version: keep the live directory, use a new name
  NEW_DIR="${RELEASES_DIR}/${NEW_VER}.r$(date +%s)"
else
  rm -rf "$NEW_DIR"
fi
mv "$STAGE" "$NEW_DIR"
touch "$NEW_DIR"   # retention is by mtime (do not keep the old mtime tar restored)

swap_link() {
  # Replace the `current` symlink atomically (temp link + rename).
  ln -sfn "$1" "${CHIRP_DIR}/.current.new"
  mv -Tf "${CHIRP_DIR}/.current.new" "$CURRENT_LINK"
}

health_scheme() {
  local cert key
  cert="$(env_value CHIRP_TLS_CERT)"
  key="$(env_value CHIRP_TLS_KEY)"
  if [[ -n "$cert" && -n "$key" ]]; then
    echo "https"
  else
    echo "http"
  fi
}

health_port() {
  local p
  p="$(env_value CHIRP_PORT)"
  echo "${p:-80}"
}

# Address to probe: a wildcard bind (0.0.0.0, ::) answers on loopback; a
# specific CHIRP_HOST must be probed on that address (IPv6 in brackets).
health_host() {
  local h
  h="$(env_value CHIRP_HOST)"
  h="${h#[}"; h="${h%]}"
  case "$h" in
    ""|0.0.0.0|::|"*") echo "127.0.0.1" ;;
    *:*) echo "[${h}]" ;;
    *) echo "$h" ;;
  esac
}

wait_healthy() {
  local scheme host port url deadline
  scheme="$(health_scheme)"
  host="$(health_host)"
  port="$(health_port)"
  url="${scheme}://${host}:${port}/health"
  deadline=$((SECONDS + HEALTH_TIMEOUT_SEC))
  while ((SECONDS < deadline)); do
    if curl -kfsS --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "[update] Switching ${CURRENT_LINK} -> ${NEW_DIR}"
swap_link "$NEW_DIR"
# A failed restart also goes down the rollback path (exiting via set -e would leave the new release live).
systemctl daemon-reload || true
systemctl restart "$SERVICE" || echo "[update] systemctl restart ${SERVICE} failed" >&2

echo "[update] Waiting for $(health_scheme)://$(health_host):$(health_port)/health (up to ${HEALTH_TIMEOUT_SEC}s)..."
if wait_healthy; then
  # Prune old releases: keep the newest KEEP_RELEASES plus the current target.
  CUR_REAL="$(readlink -f "$CURRENT_LINK")"
  n=0
  while IFS= read -r d; do
    n=$((n + 1))
    if ((n > KEEP_RELEASES)) && [[ "$d" != "$CUR_REAL" ]]; then
      echo "[update] Removing old release $(basename "$d")"
      rm -rf "$d"
    fi
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -not -name '.*' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
  echo "chirp update completed (version ${NEW_VER})."
  collector_notice /run/chirp
  exit 0
fi

echo "[update] Health check failed — rolling back" >&2
if [[ -n "$PREV_TARGET" && -d "$PREV_TARGET" ]]; then
  swap_link "$PREV_TARGET"
  systemctl restart "$SERVICE" || true
  echo "[update] Rolled back to ${PREV_VER}. Inspect: journalctl -u ${SERVICE} -n 80" >&2
  rm -rf "$NEW_DIR"
else
  # First install: there is nothing to roll back to. Do not leave `current`
  # pointing at a directory that is about to be deleted (a dangling link would
  # make the unit crash-loop); stop the service and remove the link instead.
  echo "[update] No previous release to roll back to. Inspect: journalctl -u ${SERVICE} -n 80" >&2
  systemctl stop "$SERVICE" || true
  if [[ -L "$CURRENT_LINK" && "$(readlink -f "$CURRENT_LINK")" == "$(readlink -f "$NEW_DIR")" ]]; then
    rm -f "$CURRENT_LINK"
    echo "[update] Removed ${CURRENT_LINK} (it pointed at the failed release)." >&2
  fi
  rm -rf "$NEW_DIR"
fi
exit 1
