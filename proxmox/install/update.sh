#!/usr/bin/env bash
# chirp LXC 업데이트 — 최신 릴리스 tarball 을 sha256 검증 후 releases/<ver> 에 풀고
# current 링크를 원자적으로 교체한다. /health 가 응답하지 않으면 이전 릴리스로 롤백한다.
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
      echo "  --force  이미 최신 버전이어도 다시 내려받아 적용한다"
      echo "  CHIRP_REF=v1.2.3 update  # 최신 대신 특정 릴리스 태그를 설치"
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

# --- 릴리스 확인 ---
if [[ -n "${CHIRP_REF:-}" ]]; then
  API_URL="https://api.github.com/repos/${CHIRP_REPO}/releases/tags/${CHIRP_REF}"
else
  API_URL="https://api.github.com/repos/${CHIRP_REPO}/releases/latest"
fi
if ! curl -fsSL "$API_URL" -o "${TMPDIR_UPD}/release.json"; then
  echo "[update] 릴리스 정보를 가져오지 못했습니다: ${API_URL}" >&2
  echo "         CHIRP_REF 는 릴리스 태그여야 합니다 (tarball 은 릴리스에만 있음)." >&2
  exit 1
fi

TAG="$(jq -r .tag_name "${TMPDIR_UPD}/release.json")"
TAR_NAME="$(jq -r '[.assets[].name | select(test("^chirp-.+\\.tar\\.gz$"))][0] // empty' "${TMPDIR_UPD}/release.json")"
if [[ -z "$TAG" || "$TAG" == "null" || -z "$TAR_NAME" ]]; then
  echo "[update] 릴리스에서 chirp-<version>.tar.gz 자산을 찾지 못했습니다." >&2
  exit 1
fi
SHA_NAME="${TAR_NAME}.sha256"
TAR_URL="$(jq -r --arg n "$TAR_NAME" '.assets[] | select(.name==$n) | .browser_download_url' "${TMPDIR_UPD}/release.json")"
SHA_URL="$(jq -r --arg n "$SHA_NAME" '.assets[] | select(.name==$n) | .browser_download_url' "${TMPDIR_UPD}/release.json")"
if [[ -z "$SHA_URL" ]]; then
  echo "[update] ${SHA_NAME} 자산이 없어 무결성을 검증할 수 없습니다. 중단합니다." >&2
  exit 1
fi

NEW_VER="${TAR_NAME#chirp-}"
NEW_VER="${NEW_VER%.tar.gz}"
if [[ ! "$NEW_VER" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; then
  echo "[update] 허용되지 않는 버전 문자열: ${NEW_VER}" >&2
  exit 1
fi

# --- update.sh 자기 갱신 (릴리스 태그 기준) ---
if [[ -z "${CHIRP_SELF_UPDATED:-}" ]]; then
  SELF_URL="https://raw.githubusercontent.com/${CHIRP_REPO}/${TAG}/proxmox/install/update.sh"
  if curl -fsSL "$SELF_URL" -o "${TMPDIR_UPD}/update.sh.new" \
    && [[ -s "${TMPDIR_UPD}/update.sh.new" ]] \
    && bash -n "${TMPDIR_UPD}/update.sh.new"; then
    if ! cmp -s "${TMPDIR_UPD}/update.sh.new" "$UPDATE_BIN"; then
      echo "[update] update.sh 를 ${TAG} 버전으로 갱신하고 다시 실행합니다."
      install -m 0755 "${TMPDIR_UPD}/update.sh.new" "$UPDATE_BIN"
      # exec 는 EXIT trap 을 실행하지 않으므로 임시 디렉터리를 먼저 지운다.
      rm -rf "$TMPDIR_UPD"
      trap - EXIT
      CHIRP_SELF_UPDATED=1 exec "$UPDATE_BIN" "$@"
    fi
  else
    echo "[update] update.sh 자기 갱신을 건너뜁니다 (받기/구문 검사 실패)." >&2
  fi
fi

PREV_TARGET=""
PREV_VER=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREV_TARGET="$(readlink -f "$CURRENT_LINK")"
  PREV_VER="$(basename "$PREV_TARGET")"
  # --force 재설치본(<ver>.r<epoch>)도 같은 버전으로 본다 — 안 그러면 매번 재설치한다.
  if [[ "$PREV_VER" =~ ^(.+)\.r[0-9]+$ ]]; then
    PREV_VER="${BASH_REMATCH[1]}"
  fi
fi

if [[ "$PREV_VER" == "$NEW_VER" && "$FORCE" -ne 1 ]]; then
  echo "chirp ${NEW_VER} 는 이미 최신입니다. (--force 로 재설치)"
  exit 0
fi

# --- 다운로드 + sha256 검증 ---
echo "[update] Downloading ${TAR_NAME}"
curl -fsSL "$TAR_URL" -o "${TMPDIR_UPD}/${TAR_NAME}"
curl -fsSL "$SHA_URL" -o "${TMPDIR_UPD}/${SHA_NAME}"
EXPECTED="$(awk '{print $1; exit}' "${TMPDIR_UPD}/${SHA_NAME}")"
ACTUAL="$(sha256sum "${TMPDIR_UPD}/${TAR_NAME}" | awk '{print $1}')"
if [[ -z "$EXPECTED" || "$EXPECTED" != "$ACTUAL" ]]; then
  echo "[update] sha256 불일치 — 중단합니다. (expected=${EXPECTED:-none} actual=${ACTUAL})" >&2
  exit 1
fi
echo "[update] sha256 OK"

# --- 압축 해제 (임시 디렉터리 → 이름 변경) ---
mkdir -p "$RELEASES_DIR"
STAGE="${RELEASES_DIR}/.${NEW_VER}.tmp"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "${TMPDIR_UPD}/${TAR_NAME}" -C "$STAGE"
if [[ ! -f "${STAGE}/apps/server/dist/index.js" || ! -d "${STAGE}/apps/web/dist" || ! -d "${STAGE}/node_modules" ]]; then
  echo "[update] tarball 레이아웃이 올바르지 않습니다 (apps/server/dist, apps/web/dist, node_modules 필요)." >&2
  rm -rf "$STAGE"
  exit 1
fi
NEW_DIR="${RELEASES_DIR}/${NEW_VER}"
if [[ "$NEW_DIR" == "$PREV_TARGET" ]]; then
  # --force 로 현재 버전을 다시 설치하는 경우: 사용 중인 디렉터리를 건드리지 않고 별도 이름으로 배치
  NEW_DIR="${RELEASES_DIR}/${NEW_VER}.r$(date +%s)"
else
  rm -rf "$NEW_DIR"
fi
mv "$STAGE" "$NEW_DIR"
touch "$NEW_DIR"   # 보관 순서는 mtime 기준 (tar 가 복원한 오래된 mtime 방지)

swap_link() {
  # current 심볼릭 링크를 원자적으로 교체한다 (임시 링크 + rename).
  ln -sfn "$1" "${CHIRP_DIR}/.current.new"
  mv -Tf "${CHIRP_DIR}/.current.new" "$CURRENT_LINK"
}

health_port() {
  local p
  p="$(grep -E '^CHIRP_PORT=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '"' || true)"
  echo "${p:-80}"
}

wait_healthy() {
  local port deadline
  port="$(health_port)"
  deadline=$((SECONDS + HEALTH_TIMEOUT_SEC))
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "[update] Switching ${CURRENT_LINK} -> ${NEW_DIR}"
swap_link "$NEW_DIR"
# 재시작 실패도 롤백 경로로 보낸다 (set -e 로 바로 종료하면 새 릴리스에 묶인 채 남는다).
systemctl daemon-reload || true
systemctl restart "$SERVICE" || echo "[update] systemctl restart ${SERVICE} 실패" >&2

echo "[update] Waiting for /health (up to ${HEALTH_TIMEOUT_SEC}s)..."
if wait_healthy; then
  # 오래된 릴리스 정리: 최신 KEEP_RELEASES 개 + 현재 대상만 남긴다.
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
  exit 0
fi

echo "[update] Health check failed — rolling back" >&2
if [[ -n "$PREV_TARGET" && -d "$PREV_TARGET" ]]; then
  swap_link "$PREV_TARGET"
  systemctl restart "$SERVICE" || true
  echo "[update] Rolled back to ${PREV_VER}. Inspect: journalctl -u ${SERVICE} -n 80" >&2
else
  echo "[update] 이전 릴리스가 없어 롤백할 수 없습니다. Inspect: journalctl -u ${SERVICE} -n 80" >&2
fi
rm -rf "$NEW_DIR"
exit 1
