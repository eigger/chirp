#!/usr/bin/env bash
# chirp disk passthrough (run on the Proxmox host).
#
# One-liner (re-run on the host after adding/replacing disks; idempotent):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/install/chirp-passthrough.sh)" _ <CTID>
#   Non-interactive: prefix with CHIRP_DISKS=all|none|<by-id,by-id,...>
#
# What it does: detect host disks -> pick them in a checklist -> (re)write the
#   `# chirp-passthrough:start` ... `:end` block (disk rules + read-only host metric
#   mounts) in /etc/pve/lxc/<CTID>.conf ->
#   update CHIRP_DEVICES in the container's chirp.env -> pct reboot -> smoke test
#   (smartctl, /health).
#
# Notes (also in docs/deploy.md):
#  - root in a privileged LXC is effectively host root. Use it on trusted hosts only.
#  - Do not use it for CTs managed by cluster HA (by-id disks exist on one node only).
#  - Disks behind USB bridges/HBAs need CHIRP_DEVICE_TYPES in the container's /etc/chirp/chirp.env.
#  - Host metric mounts (always written, opt out with CHIRP_HOST_MOUNTS=0): the host's
#    /proc/meminfo, /proc/stat, /proc/loadavg and /sys are bind-mounted read-only under
#    /host/proc and /host/sys in the container. Inside the container, /proc/meminfo etc. may
#    be lxcfs views of the container's limits and /sys/class/net only shows the container's
#    own network namespace; chirp reads the /host copies first and reports `scope: "host"`
#    for them (`container` when they are missing). /proc/net/dev is not mounted: it is per
#    network namespace, so network counters come from the host's /sys/class/net instead.
#    The smoke test compares MemTotal and the interface list between host and container.
#  - Device cgroup rules: `b <major>:* rw` for the majors of the selected disks.
#    * rw, not rwm: the disks are bind-mounted (no mknod needed), and smartctl
#      opens SCSI/SAT devices O_RDWR for SG_IO. Override with CHIRP_DEV_PERM.
#    * major wildcard, not exact major:minor: sd minors follow probe order and
#      NVMe (259, blkext) minors are allocated dynamically, so exact rules would
#      silently point at the wrong disk (or none) after a host reboot or hotplug,
#      while the by-id bind mounts are re-resolved on every CT start. The cost:
#      container root can reach other block devices with the same major (e.g. the
#      host's boot disk) - no worse than a privileged CT already is (see above).
#
# Safe to `source` (defines functions only; with CHIRP_PASSTHROUGH_LIB=1 main does not run).

CHIRP_MARK_START="# chirp-passthrough:start"
CHIRP_MARK_END="# chirp-passthrough:end"
CHIRP_DEV_PERM="${CHIRP_DEV_PERM:-rw}"
CHIRP_HOST_MOUNTS="${CHIRP_HOST_MOUNTS:-1}"
# Host files bind-mounted read-only for the host metrics (source -> <rootfs>/host/<source>).
CHIRP_HOST_PROC_FILES=(/proc/meminfo /proc/stat /proc/loadavg)

_cp_msg()  { echo -e "\033[0;32m[+]\033[0m $*"; }
_cp_warn() { echo -e "\033[1;33m[!]\033[0m $*" >&2; }
_cp_err()  { echo -e "\033[0;31m[x]\033[0m $*" >&2; }

# Extract the value of KEY="value" from one `lsblk -P` line.
chirp_lsblk_field() {
  local line="$1" key="$2"
  if [[ "$line" =~ (^|[[:space:]])${key}=\"([^\"]*)\" ]]; then
    printf '%s' "${BASH_REMATCH[2]}"
  fi
}

# stdin: `lsblk -dn -P -o NAME,MAJ:MIN,TYPE,TRAN,MODEL,SERIAL,SIZE` output.
# stdout: TSV  name<TAB>maj:min<TAB>tran<TAB>model<TAB>serial<TAB>size  (physical disks only)
chirp_list_disks() {
  local line name type majmin tran model serial size
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    type="$(chirp_lsblk_field "$line" TYPE)"
    [[ "$type" == "disk" ]] || continue
    name="$(chirp_lsblk_field "$line" NAME)"
    [[ -n "$name" ]] || continue
    case "$name" in
      loop*|zram*|ram*|rbd*|nbd*|dm-*|md*|sr*) continue ;;
    esac
    majmin="$(chirp_lsblk_field "$line" "MAJ:MIN")"
    majmin="${majmin// /}"
    tran="$(chirp_lsblk_field "$line" TRAN)"
    model="$(chirp_lsblk_field "$line" MODEL)"
    serial="$(chirp_lsblk_field "$line" SERIAL)"
    size="$(chirp_lsblk_field "$line" SIZE)"
    model="${model//\\x20/ }"
    serial="${serial//\\x20/ }"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$majmin" "$tran" "$model" "$serial" "$size"
  done
}

# stdin: "<by-id name> <target device name>" lines. $1: device name (sda, nvme0n1).
# Priority: wwn-* -> ata-*/nvme-eui.* -> nvme-<model>_<serial> -> scsi-* -> others. -partN skipped.
# Ties: shorter name, then lexical order.
chirp_pick_byid() {
  local dev="$1" best="" bestscore=99 name tgt score
  while read -r name tgt; do
    [[ -n "$name" && "$tgt" == "$dev" ]] || continue
    [[ "$name" =~ -part[0-9]+$ ]] && continue
    case "$name" in
      wwn-*) score=1 ;;
      ata-*|nvme-eui.*) score=2 ;;
      nvme-*) score=3 ;;
      scsi-*) score=4 ;;
      *) score=5 ;;
    esac
    if ((score < bestscore)); then
      best="$name"; bestscore=$score
    elif ((score == bestscore)); then
      if ((${#name} < ${#best})) || { ((${#name} == ${#best})) && [[ "$name" < "$best" ]]; }; then
        best="$name"
      fi
    fi
  done
  [[ -n "$best" ]] && printf '%s\n' "$best"
  return 0
}

# Print the host's /dev/disk/by-id as "<name> <target>" lines.
chirp_byid_listing() {
  local l
  for l in /dev/disk/by-id/*; do
    [[ -L "$l" ]] || continue
    printf '%s %s\n' "$(basename "$l")" "$(basename "$(readlink -f "$l")")"
  done
}

# $1: lsblk text, $2: by-id listing text.
# stdout: TSV  byid<TAB>maj:min<TAB>tran<TAB>model<TAB>serial<TAB>size
chirp_detect_disks() {
  local lsblk_text="$1" listing="$2" name majmin tran model serial size byid
  while IFS=$'\t' read -r name majmin tran model serial size; do
    [[ -n "$name" ]] || continue
    byid="$(chirp_pick_byid "$name" <<<"$listing")"
    if [[ -z "$byid" ]]; then
      _cp_warn "Skipping a disk without a /dev/disk/by-id name: ${name}"
      continue
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$byid" "$majmin" "$tran" "$model" "$serial" "$size"
  done < <(chirp_list_disks <<<"$lsblk_text")
}

# $1: CHIRP_DISKS value (all|none|comma-separated by-id names), $2: detected TSV.
# stdout: selected rows (TSV). Returns 1 if a name was not detected.
chirp_resolve_selection() {
  local sel="$1" detected="$2" item rc=0 line items=()
  case "$sel" in
    all) printf '%s\n' "$detected" | sed '/^$/d'; return 0 ;;
    none|"") return 0 ;;
  esac
  # read -ra: split on commas without glob expansion (a "*" never matches files in the cwd)
  IFS=, read -ra items <<<"$sel"
  for item in "${items[@]}"; do
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    item="${item#/dev/disk/by-id/}"
    [[ -n "$item" ]] || continue
    line="$(printf '%s\n' "$detected" | awk -F'\t' -v n="$item" '$1==n {print; exit}')"
    if [[ -z "$line" ]]; then
      _cp_err "Not a detected disk (by-id): ${item}"
      rc=1
      continue
    fi
    printf '%s\n' "$line"
  done
  return $rc
}

# stdin: selected TSV -> stdout: unique major numbers.
chirp_majors() {
  awk -F'\t' 'NF && $2 ~ /^[0-9]+:/ {split($2,a,":"); print a[1]}' | sort -n -u
}

# stdout: the read-only host metric mounts (nothing with CHIRP_HOST_MOUNTS=0).
# `optional`: a missing source never stops the container from starting; chirp then
# falls back to the container's own view and reports scope "container".
chirp_render_host_mounts() {
  local f
  [[ "$CHIRP_HOST_MOUNTS" == "0" ]] && return 0
  for f in "${CHIRP_HOST_PROC_FILES[@]}"; do
    echo "lxc.mount.entry: ${f} host${f} none bind,ro,optional,create=file 0 0"
  done
  echo "lxc.mount.entry: /sys host/sys none bind,ro,optional,create=dir 0 0"
}

# stdin: selected TSV -> stdout: marker block (disk rules + host metric mounts;
# nothing when both are empty).
chirp_render_block() {
  local tsv majors m byid host
  tsv="$(cat)"
  host="$(chirp_render_host_mounts)"
  [[ -n "$tsv" || -n "$host" ]] || return 0
  echo "$CHIRP_MARK_START"
  if [[ -n "$tsv" ]]; then
    majors="$(chirp_majors <<<"$tsv")"
    for m in $majors; do
      echo "lxc.cgroup2.devices.allow: b ${m}:* ${CHIRP_DEV_PERM}"
    done
    while IFS=$'\t' read -r byid _; do
      [[ -n "$byid" ]] || continue
      echo "lxc.mount.entry: /dev/disk/by-id/${byid} dev/disk/by-id/${byid} none bind,optional,create=file"
    done <<<"$tsv"
  fi
  [[ -n "$host" ]] && printf '%s\n' "$host"
  echo "$CHIRP_MARK_END"
}

# $1: conf file, $2: block file (empty = only remove the old block). Idempotent.
# Inserted before the first snapshot section ([name]) - appended after it, it would
# become part of the snapshot's config.
chirp_apply_conf() {
  local conf="$1" blockfile="$2" tmp
  if [[ ! -s "$conf" ]]; then
    _cp_err "${conf} is missing or empty."
    return 1
  fi
  if [[ ! -r "$blockfile" ]]; then
    _cp_err "Cannot read the block file: ${blockfile}"
    return 1
  fi
  tmp="$(mktemp)" || return 1
  if ! awk -v s="$CHIRP_MARK_START" -v e="$CHIRP_MARK_END" -v bf="$blockfile" '
    function emit(   l) {
      if (done) return
      done = 1
      while ((getline l < bf) > 0) print l
      close(bf)
    }
    $0==s {skip=1; next}
    $0==e {skip=0; next}
    skip {next}
    /^\[/ {emit()}
    {print}
    END {emit()}
  ' "$conf" >"$tmp"; then
    _cp_err "Failed to rewrite ${conf}; leaving it unchanged."
    rm -f "$tmp"
    return 1
  fi
  # Never write an empty result (awk failure etc.): it would wipe the CT config in /etc/pve.
  if [[ ! -s "$tmp" ]]; then
    _cp_err "Rewriting ${conf} produced an empty file; leaving it unchanged."
    rm -f "$tmp"
    return 1
  fi
  if cmp -s "$tmp" "$conf"; then
    rm -f "$tmp"
    return 0
  fi
  # On pmxcfs (/etc/pve) overwrite in place rather than rename (keeps mode/ownership).
  if ! cat "$tmp" >"$conf"; then
    _cp_err "Failed to write ${conf}."
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
}

# stdin: selected TSV -> stdout: CHIRP_DEVICES value (comma-separated full paths).
chirp_devices_value() {
  awk -F'\t' 'NF {printf "%s/dev/disk/by-id/%s", (n++ ? "," : ""), $1} END {if (n) print ""}'
}

# whiptail checklist (all selected by default). $1: detected TSV. stdout: comma-separated by-id names.
chirp_prompt_selection() {
  local detected="$1" args=() byid majmin tran model serial size out
  while IFS=$'\t' read -r byid majmin tran model serial size; do
    [[ -n "$byid" ]] || continue
    args+=("$byid" "${model:-?} ${size} ${tran:-}" ON)
  done <<<"$detected"
  if ! out="$(whiptail --title "chirp disk selection" --separate-output \
      --checklist "Select the disks to pass through to the container (space toggles)" 20 100 10 \
      "${args[@]}" 3>&1 1>&2 2>&3)"; then
    echo ""
    return 0
  fi
  printf '%s\n' "$out" | paste -sd, -
}

# Update CHIRP_DEVICES in the container's chirp.env. $1 CTID, $2 value.
chirp_update_ct_env() {
  local ctid="$1" value="$2"
  pct exec "$ctid" -- bash -c '
    f=/etc/chirp/chirp.env
    touch "$f"
    grep -v "^CHIRP_DEVICES=" "$f" >"$f.new" || true
    printf "CHIRP_DEVICES=%s\n" "$1" >>"$f.new"
    cat "$f.new" >"$f"; rm -f "$f.new"' _ "$value"
}

chirp_ct_ip() {
  pct exec "$1" -- hostname -I 2>/dev/null | awk '{print $1}'
}

chirp_wait_network() {
  local ctid="$1" ip=""
  for _ in $(seq 1 45); do
    ip="$(chirp_ct_ip "$ctid" || true)"
    [[ -n "$ip" ]] && { echo "$ip"; return 0; }
    sleep 2
  done
  return 1
}

# Smoke test + final summary. $1 CTID, $2 IP, $3 selected TSV (not stdin).
chirp_smoke_and_report() {
  local ctid="$1" ip="$2" tsv="$3" byid out rc status ok=0 total=0
  if [[ -n "$tsv" ]]; then
    printf '\n%-60s %s\n' "DISK (by-id)" "smartctl -j -i -n standby"
    while IFS=$'\t' read -r byid _; do
      [[ -n "$byid" ]] || continue
      total=$((total + 1))
      rc=0
      # -n standby: the smoke test does not wake sleeping disks either.
      out="$(pct exec "$ctid" -- smartctl -j -i -n standby "/dev/disk/by-id/${byid}" 2>&1)" || rc=$?
      if grep -q '"model_name"\|"serial_number"' <<<"$out"; then
        status="OK"; ok=$((ok + 1))
      elif grep -qi 'STANDBY\|SLEEP' <<<"$out"; then
        status="OK (standby)"; ok=$((ok + 1))
      else
        status="FAIL (exit ${rc})"
      fi
      printf '%-60s %s\n' "$byid" "$status"
    done <<<"$tsv"
    echo "smartctl OK ${ok}/${total} (disks behind USB/HBA may need CHIRP_DEVICE_TYPES)"
  fi

  chirp_check_host_mounts "$ctid"

  local health="FAIL"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 3 "http://${ip}/health" >/dev/null 2>&1; then health="OK"; break; fi
    sleep 2
  done
  echo "GET http://${ip}/health : ${health}"

  local key
  key="$(pct exec "$ctid" -- node /opt/chirp/current/apps/server/dist/cli.js key show 2>/dev/null \
    || pct exec "$ctid" -- cat /var/lib/chirp/api-key 2>/dev/null || echo '(lookup failed; run: pct exec '"$ctid"' -- node /opt/chirp/current/apps/server/dist/cli.js key show)')"
  echo
  echo "=============================================="
  echo " Dashboard : http://${ip}/"
  echo " API key   : ${key}"
  echo
  echo " Home Assistant:"
  echo "   HACS custom repository : eigger/hass-chirp"
  echo "   Integration domain     : chirp"
  echo "   Host ${ip} / port 80 / API key (above)"
  echo
  echo " After adding/replacing disks (or to add the host metric mounts to an"
  echo " older install), re-run on the host:"
  echo "   bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/install/chirp-passthrough.sh)\" _ ${ctid}"
  echo " Update the container: pct exec ${ctid} -- update"
  echo "=============================================="
}

# $1: host /proc/meminfo text, $2: container /host/proc/meminfo text. Exit 0 when MemTotal matches.
chirp_memtotal_matches() {
  local h c
  h="$(awk '$1=="MemTotal:" {print $2; exit}' <<<"$1")"
  c="$(awk '$1=="MemTotal:" {print $2; exit}' <<<"$2")"
  [[ -n "$h" && "$h" == "$c" ]]
}

# Verify that the host metric mounts show the host's values (not the container's).
chirp_check_host_mounts() {
  local ctid="$1" host_mem ct_mem host_if ct_if
  [[ "$CHIRP_HOST_MOUNTS" == "0" ]] && return 0
  host_mem="$(cat /proc/meminfo 2>/dev/null)"
  ct_mem="$(pct exec "$ctid" -- cat /host/proc/meminfo 2>/dev/null || true)"
  if chirp_memtotal_matches "$host_mem" "$ct_mem"; then
    echo "Host metric mounts: /host/proc/meminfo MemTotal matches the host: OK"
  else
    _cp_warn "Host metric mounts: /host/proc/meminfo does not match the host; memory/load will show the container view."
  fi
  host_if="$(ls /sys/class/net 2>/dev/null | sort | paste -sd, -)"
  ct_if="$(pct exec "$ctid" -- sh -c 'ls /host/sys/class/net 2>/dev/null' | sort | paste -sd, - || true)"
  if [[ -n "$host_if" && "$host_if" == "$ct_if" ]]; then
    echo "Host metric mounts: /host/sys/class/net lists the host interfaces: OK"
  else
    _cp_warn "Host metric mounts: /host/sys/class/net differs from the host (${ct_if:-empty}); network will show the container view."
  fi
}

chirp_passthrough_run() {
  local ctid="${1:-}" conf detected selection="" sel_tsv listing lsblk_text blockfile ip devices
  if [[ -z "$ctid" || ! "$ctid" =~ ^[0-9]+$ ]]; then
    _cp_err "Usage: chirp-passthrough.sh <CTID>"
    return 1
  fi
  if ! command -v pveversion >/dev/null 2>&1; then
    _cp_err "Must run on a Proxmox VE host."
    return 1
  fi
  conf="/etc/pve/lxc/${ctid}.conf"
  if [[ ! -f "$conf" ]]; then
    _cp_err "${conf} does not exist."
    return 1
  fi
  if grep -q '^unprivileged: 1' "$conf"; then
    _cp_err "CT ${ctid} is unprivileged. Disk passthrough needs a privileged CT (var_unprivileged=0)."
    return 1
  fi
  if command -v ha-manager >/dev/null 2>&1 && ha-manager status 2>/dev/null | grep -q "ct:${ctid}\b"; then
    _cp_warn "CT ${ctid} is managed by HA. The disks are tied to this node, so migration will fail."
  fi

  lsblk_text="$(lsblk -dn -P -o NAME,MAJ:MIN,TYPE,TRAN,MODEL,SERIAL,SIZE)"
  listing="$(chirp_byid_listing)"
  detected="$(chirp_detect_disks "$lsblk_text" "$listing")"
  if [[ -z "$detected" && "${CHIRP_DISKS:-}" != "none" ]]; then
    _cp_warn "No disks found that can be passed through."
  fi

  if [[ -n "${CHIRP_DISKS:-}" ]]; then
    selection="$CHIRP_DISKS"
  elif [[ -z "$detected" ]]; then
    selection="none"
  elif command -v whiptail >/dev/null 2>&1 && [[ -t 0 && -t 1 ]]; then
    selection="$(chirp_prompt_selection "$detected")"
    [[ -n "$selection" ]] || selection="none"
  else
    _cp_msg "No interactive terminal; selecting all detected disks. (set CHIRP_DISKS to choose)"
    selection="all"
  fi

  sel_tsv="$(chirp_resolve_selection "$selection" "$detected")" || return 1

  blockfile="$(mktemp)"
  chirp_render_block <<<"$sel_tsv" >"$blockfile"
  if ! chirp_apply_conf "$conf" "$blockfile"; then
    rm -f "$blockfile"
    return 1
  fi
  if [[ -s "$blockfile" ]]; then
    _cp_msg "Applied the passthrough block to ${conf}:"
    sed -n "/^${CHIRP_MARK_START}\$/,/^${CHIRP_MARK_END}\$/p" "$conf"
  else
    _cp_msg "No disks selected and CHIRP_HOST_MOUNTS=0; removed the passthrough block."
  fi
  rm -f "$blockfile"
  [[ -n "$sel_tsv" ]] || _cp_msg "No disks selected."

  devices="$(chirp_devices_value <<<"$sel_tsv")"
  if [[ "$(pct status "$ctid" | awk '{print $2}')" != "running" ]]; then
    if ! pct start "$ctid"; then
      _cp_err "Failed to start CT ${ctid}."
      return 1
    fi
    sleep 3
  fi
  if ! chirp_update_ct_env "$ctid" "$devices"; then
    _cp_err "Failed to update /etc/chirp/chirp.env in CT ${ctid}."
    return 1
  fi

  _cp_msg "Rebooting CT ${ctid}..."
  if ! pct reboot "$ctid"; then
    _cp_err "Failed to reboot CT ${ctid}."
    return 1
  fi
  sleep 3
  if ! ip="$(chirp_wait_network "$ctid")"; then
    _cp_err "The network did not come up after the reboot."
    return 1
  fi
  chirp_smoke_and_report "$ctid" "$ip" "$sel_tsv"
}

if [[ "${CHIRP_PASSTHROUGH_LIB:-}" != "1" ]] \
  && { [[ -z "${BASH_SOURCE[0]:-}" ]] || [[ "${BASH_SOURCE[0]}" == "$0" ]]; }; then
  set -uo pipefail
  chirp_passthrough_run "${1:-}"
fi
