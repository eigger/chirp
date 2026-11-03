#!/usr/bin/env bash
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)

# 설치 스크립트 다운로드를 community-scripts 대신 chirp 저장소로 돌린다.
function curl() {
  if [[ "$*" == *"community-scripts/ProxmoxVE/main/install/chirp-install.sh"* ]]; then
    command curl -fsSL "https://raw.githubusercontent.com/eigger/chirp/master/proxmox/install/chirp-install.sh"
  else
    command curl "$@"
  fi
}
export -f curl

# chirp — Proxmox VE 원클릭 LXC 설치 (호스트의 root 셸에서):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
#
# 비대화형 디스크 선택: CHIRP_DISKS=all|none|<by-id,...> 를 앞에 붙인다.
#
# 주의:
#  - privileged LXC의 root는 사실상 호스트 root다. 신뢰 가능한 네트워크에서만 쓴다.
#  - 클러스터 HA 마이그레이션 대상 CT에는 쓰지 말 것 (디스크가 노드에 묶여 있다).
#  - USB/HBA 뒤 디스크는 컨테이너 안 /etc/chirp/chirp.env 에 CHIRP_DEVICE_TYPES 설정이 필요하다.
#
# Copyright (c) 2021-2026 community-scripts ORG
# License: MIT | https://github.com/community-scripts/ProxmoxVE/raw/main/LICENSE
# Chassis derived from https://github.com/eigger/kibble

APP="chirp"
var_tags="${var_tags:-monitoring;smart;chirp}"
var_cpu="${var_cpu:-1}"
var_ram="${var_ram:-512}"
var_disk="${var_disk:-4}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_arm64="${var_arm64:-no}"
var_unprivileged="${var_unprivileged:-0}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources
  if [[ ! -d /opt/chirp ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  msg_info "Updating ${APP}"
  if command -v update >/dev/null 2>&1; then
    update || exit $?
  else
    msg_error "'update' 명령이 없습니다. 설치가 불완전합니다."
    exit 1
  fi
  msg_ok "Updated successfully!"
  exit
}

start
build_container
description

# --- 호스트 쪽 후처리: 디스크 passthrough (build_container 이후, CT가 실행 중일 때) ---
CHIRP_RAW_BASE="${CHIRP_RAW_BASE:-https://raw.githubusercontent.com/eigger/chirp/master}"
PASSTHROUGH_TMP="$(mktemp)"
if command curl -fsSL "${CHIRP_RAW_BASE}/proxmox/install/chirp-passthrough.sh" -o "$PASSTHROUGH_TMP" \
  && bash -n "$PASSTHROUGH_TMP"; then
  export CHIRP_PASSTHROUGH_LIB=1
  # shellcheck disable=SC1090
  source "$PASSTHROUGH_TMP"
  if ! chirp_passthrough_run "$CTID"; then
    msg_error "디스크 passthrough 단계가 실패했습니다. 컨테이너는 설치되어 있습니다."
    echo -e "${INFO}${YW}나중에 다시 실행: bash -c \"\$(curl -fsSL ${CHIRP_RAW_BASE}/proxmox/install/chirp-passthrough.sh)\" _ ${CTID}${CL}"
  fi
else
  msg_error "chirp-passthrough.sh 를 받지 못했습니다. 디스크 passthrough를 건너뜁니다."
fi
rm -f "$PASSTHROUGH_TMP"

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
