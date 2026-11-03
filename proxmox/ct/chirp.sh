#!/usr/bin/env bash
# shellcheck source=/dev/null
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)

# Redirect the install-script download from community-scripts to the chirp repository.
function curl() {
  if [[ "$*" == *"community-scripts/ProxmoxVE/main/install/chirp-install.sh"* ]]; then
    command curl -fsSL "https://raw.githubusercontent.com/eigger/chirp/master/proxmox/install/chirp-install.sh"
  else
    command curl "$@"
  fi
}
export -f curl

# chirp: one-shot Proxmox VE LXC install (from the host's root shell):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
#
# Non-interactive disk selection: prefix with CHIRP_DISKS=all|none|<by-id,...>
#
# Notes:
#  - root in a privileged LXC is effectively host root. Use it on trusted networks only.
#  - Do not use it for CTs managed by cluster HA (the disks are tied to one node).
#  - Disks behind USB bridges/HBAs need CHIRP_DEVICE_TYPES in the container's /etc/chirp/chirp.env.
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
    msg_error "The 'update' command is missing; the installation is incomplete."
    exit 1
  fi
  msg_ok "Updated successfully!"
  exit
}

start
build_container
description

# --- Host-side post-install: disk passthrough (after build_container, while the CT runs) ---
CHIRP_RAW_BASE="${CHIRP_RAW_BASE:-https://raw.githubusercontent.com/eigger/chirp/master}"
PASSTHROUGH_TMP="$(mktemp)"
if command curl -fsSL "${CHIRP_RAW_BASE}/proxmox/install/chirp-passthrough.sh" -o "$PASSTHROUGH_TMP" \
  && bash -n "$PASSTHROUGH_TMP"; then
  export CHIRP_PASSTHROUGH_LIB=1
  # shellcheck disable=SC1090
  source "$PASSTHROUGH_TMP"
  if ! chirp_passthrough_run "$CTID"; then
    msg_error "The disk passthrough step failed. The container itself is installed."
    echo -e "${INFO}${YW}Re-run later: bash -c \"\$(curl -fsSL ${CHIRP_RAW_BASE}/proxmox/install/chirp-passthrough.sh)\" _ ${CTID}${CL}"
  fi
else
  msg_error "Could not download chirp-passthrough.sh; skipping disk passthrough."
fi
rm -f "$PASSTHROUGH_TMP"

msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
