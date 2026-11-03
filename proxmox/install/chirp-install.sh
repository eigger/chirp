#!/usr/bin/env bash
set -euo pipefail

# Copyright (c) 2021-2026 community-scripts ORG
# License: MIT | https://github.com/community-scripts/ProxmoxVE/raw/main/LICENSE
# Chassis derived from https://github.com/eigger/kibble
#
# 컨테이너 안에서 실행되는 chirp 설치 스크립트.
# 앱 본체(릴리스 tarball)는 update.sh 가 내려받아 설치한다 (설치와 업데이트가 같은 경로).

export DEBIAN_FRONTEND=noninteractive
APT_QUIET_FLAGS=(-y -qq -o=Dpkg::Use-Pty=0)

CHIRP_DIR=/opt/chirp
CHIRP_REPO="${CHIRP_REPO:-eigger/chirp}"
CHIRP_REF="${CHIRP_REF:-}"

echo "[chirp-install] Updating apt indexes"
apt-get update "${APT_QUIET_FLAGS[@]}"

echo "[chirp-install] Installing dependencies"
apt-get install "${APT_QUIET_FLAGS[@]}" smartmontools nvme-cli lm-sensors curl jq ca-certificates gnupg

echo "[chirp-install] Installing Node.js 24 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]]; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update "${APT_QUIET_FLAGS[@]}"
  apt-get install "${APT_QUIET_FLAGS[@]}" nodejs
fi

echo "[chirp-install] Preparing directories"
mkdir -p "${CHIRP_DIR}/releases" /etc/chirp
install -d -m 0700 /var/lib/chirp

resolve_ref() {
  if [[ -n "$CHIRP_REF" ]]; then
    echo "$CHIRP_REF"
    return
  fi
  local tag
  tag="$(curl -fsSL "https://api.github.com/repos/${CHIRP_REPO}/releases/latest" | jq -r .tag_name)"
  if [[ -n "$tag" && "$tag" != "null" ]]; then
    echo "$tag"
    return
  fi
  echo "master"
}

REF_RESOLVED="$(resolve_ref)"
RAW_BASE="https://raw.githubusercontent.com/${CHIRP_REPO}/${REF_RESOLVED}"
echo "[chirp-install] Fetching deploy files from ${REF_RESOLVED}"

download() {
  local rel="$1" dest="$2"
  curl -fsSL "${RAW_BASE}/${rel}" -o "$dest"
  if [[ ! -s "$dest" ]]; then
    echo "[chirp-install] Empty download: ${rel}" >&2
    exit 1
  fi
}

download proxmox/install/update.sh "${CHIRP_DIR}/update.sh.tmp"
download proxmox/install/chirp.service /etc/systemd/system/chirp.service

if ! bash -n "${CHIRP_DIR}/update.sh.tmp"; then
  echo "[chirp-install] update.sh failed syntax check" >&2
  exit 1
fi
install -m 0755 "${CHIRP_DIR}/update.sh.tmp" /usr/bin/update
rm -f "${CHIRP_DIR}/update.sh.tmp"

if [[ ! -f /etc/chirp/chirp.env ]]; then
  echo "[chirp-install] Writing /etc/chirp/chirp.env"
  cat >/etc/chirp/chirp.env <<'EOF2'
CHIRP_PORT=80
CHIRP_HOST=0.0.0.0
CHIRP_DATA_DIR=/var/lib/chirp
CHIRP_WEB_DIR=/opt/chirp/current/apps/web/dist

# passthrough 된 디스크 (쉼표 구분 /dev/disk/by-id/... 경로).
# 호스트에서 chirp-passthrough.sh 가 자동으로 채운다.
CHIRP_DEVICES=

# USB/HBA 뒤 디스크처럼 자동 판별이 안 되는 경우 smartctl -d 타입을 지정한다.
# 예: /dev/disk/by-id/usb-X=sat,/dev/disk/by-id/scsi-Y=megaraid,0
# CHIRP_DEVICE_TYPES=
# 그 밖의 옵션은 README / .env.example 을 참고해 주석을 해제한다.
# CHIRP_SMART_INTERVAL=300
# CHIRP_SENSOR_INTERVAL=10
EOF2
fi
chmod 0640 /etc/chirp/chirp.env

systemctl daemon-reload
systemctl enable -q chirp.service

echo "[chirp-install] Installing latest release"
# 첫 설치도 update.sh 경로를 탄다: tarball + sha256 검증 → 심볼릭 링크 → 서비스 시작 → /health 확인.
CHIRP_REF="$CHIRP_REF" CHIRP_REPO="$CHIRP_REPO" /usr/bin/update --force

echo "[chirp-install] Setting up console auto-login for root"
for unit in container-getty@1 console-getty; do
  mkdir -p "/etc/systemd/system/${unit}.service.d/"
done
cat <<'EOF2' >/etc/systemd/system/container-getty@1.service.d/override.conf
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud tty%I 115200,38400,9600 $TERM
EOF2
cat <<'EOF2' >/etc/systemd/system/console-getty.service.d/override.conf
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud console 115200,38400,9600 $TERM
EOF2
systemctl daemon-reload
systemctl restart container-getty@1.service || true

IP_ADDR="$(hostname -I | awk '{print $1}')"
echo "[chirp-install] Completed successfully (ref ${REF_RESOLVED})"
echo "Access URL: http://${IP_ADDR}/"
echo "Later updates: run 'update' inside this container"
