#!/usr/bin/env bash

# The community-scripts engine lives in community-scripts/core. The ct/ and install/
# scripts are resolved against COMMUNITY_SCRIPTS_URL, so point that at this repository's
# proxmox/ directory: install/chirp-install.sh is then fetched from here, not upstream.
export COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/eigger/chirp/master/proxmox}"
COMMUNITY_SCRIPTS_CORE_URL="${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/main}"
export COMMUNITY_SCRIPTS_CORE_URL

# `source <(curl ...)` would ignore a failed download and keep going with every function
# undefined, so fetch first and stop on failure.
if ! _chirp_build_func="$(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL}/core/build.func")" || [[ -z "$_chirp_build_func" ]]; then
  echo "chirp: could not download the community-scripts engine from ${COMMUNITY_SCRIPTS_CORE_URL}/core/build.func" >&2
  exit 1
fi
# Source through a pipe like upstream does: the engine treats a regular-file BASH_SOURCE as a
# local checkout.
# shellcheck source=/dev/null
source <(printf '%s\n' "$_chirp_build_func")
unset _chirp_build_func

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

if [[ -z "${CTID:-}" ]]; then
  msg_error "The container was not created (CTID is empty); aborting."
  exit 1
fi

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
echo -e "${INFO}${YW}Open http://${IP:-<container IP>}/ right away and create the admin account.${CL}"
echo -e "${INFO}${YW}A setup token is required. Retrieve it with:${CL}"
echo -e "  pct exec ${CTID} -- grep -E '^CHIRP_SETUP_TOKEN=' /etc/chirp/chirp.env"
echo -e "${INFO}${YW}Then Settings -> API key -> Copy, and paste it into Home Assistant (hass-chirp).${CL}"
