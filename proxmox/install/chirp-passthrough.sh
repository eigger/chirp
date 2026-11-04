#!/usr/bin/env bash
# chirp disk passthrough (run on the Proxmox host).
#
# One-liner (re-run on the host after adding/replacing disks; idempotent):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/install/chirp-passthrough.sh)" _ <CTID>
#   Non-interactive: prefix with CHIRP_DISKS=all|none|<by-id,by-id,...>
#   (the selection replaces the current one; non-interactive runs default to all)
#   Host metric mounts: CHIRP_HOST_MOUNTS=all (default) | proc | 0 (see below)
#
# What it does: detect host disks -> pick them in a checklist -> (re)write chirp's
#   lxc.* lines (disk rules + read-only host metric mounts) in /etc/pve/lxc/<CTID>.conf,
#   recognised by content (no marker comments: Proxmox would move them into the CT
#   description), before the first [snapshot] section ->
#   update CHIRP_DEVICES in the container's chirp.env -> pct reboot -> smoke test
#   (smartctl, /health).
#
# Notes (also in docs/deploy.md):
#  - root in a privileged LXC is effectively host root. Use it on trusted hosts only.
#  - Do not use it for CTs managed by cluster HA (by-id disks exist on one node only).
#  - Disks behind USB bridges/HBAs need CHIRP_DEVICE_TYPES in the container's /etc/chirp/chirp.env.
#  - Host metric mounts, CHIRP_HOST_MOUNTS=all|proc|0 (default all):
#    * proc: the host's /proc/meminfo, /proc/stat, /proc/loadavg -> /host/proc (read-only
#      files). Inside the container these may be lxcfs views of the container's limits.
#    * all:  proc + the host's /sys -> /host/sys (read-only, nosuid,nodev,noexec, not
#      recursive). /sys/class/net (and /proc/net) only show the container's own network
#      namespace; the host's sysfs mount keeps the host's, so chirp can list the host's
#      NICs/bridges/bonds with operstate, speed and counters.
#    * 0:    no host mounts; memory/load/network are reported with scope "container".
#    Exposure of `all`: the whole host sysfs becomes visible at /host/sys. The mount is
#    read-only, but the CT's AppArmor rules that deny writes to /sys are path based
#    (/sys/**) and do not cover /host/sys, so a root process in the CT that can remount
#    could make it writable and change host network knobs (MTU, bridge/bond settings).
#    That is no new capability for a privileged CT (its root already has raw access to
#    the passed-through disks and is effectively host root), but choose `proc` if you do
#    not want host sysfs in the CT; the network section then shows the CT's own view.
#    It cannot be narrowed to /sys/class/net: its entries are symlinks into
#    /sys/devices/..., and mounting /sys/devices would expose nearly all of sysfs anyway.
#    /proc/net/dev is never mounted: /proc/net follows the reading process's namespace.
#    chirp reads /host first and reports `scope: "host"`; the smoke test compares MemTotal
#    and checks that a host-only interface is visible under /host/sys/class/net.
#    Re-running with another mode replaces chirp's lines.
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

# Marker comments written by older versions. Proxmox treats every `#` line of a CT config as
# the CT description and moves it to the top of the file whenever it rewrites the config
# (GUI / pct set), re-encoding ":" as "%3A", so markers cannot delimit anything; chirp no
# longer writes them and only deletes them (in either form) when migrating an old config.
CHIRP_DEV_PERM="${CHIRP_DEV_PERM:-rw}"
CHIRP_HOST_MOUNTS="${CHIRP_HOST_MOUNTS:-all}"
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

# CHIRP_HOST_MOUNTS -> all | proc | none (stdout). Returns 1 for an unknown value.
chirp_host_mounts_mode() {
  case "$(printf '%s' "$CHIRP_HOST_MOUNTS" | tr '[:upper:]' '[:lower:]')" in
    all|1|yes|true|"") echo all ;;
    proc) echo proc ;;
    0|none|no|false) echo none ;;
    *) return 1 ;;
  esac
}

# stdout: the read-only host metric mounts for the CHIRP_HOST_MOUNTS mode.
# `optional`: a missing source never stops the container from starting; chirp then
# falls back to the container's own view and reports scope "container".
chirp_render_host_mounts() {
  local f mode
  mode="$(chirp_host_mounts_mode)" || return 1
  [[ "$mode" == "none" ]] && return 0
  for f in "${CHIRP_HOST_PROC_FILES[@]}"; do
    echo "lxc.mount.entry: ${f} host${f} none bind,ro,optional,create=file 0 0"
  done
  [[ "$mode" == "all" ]] || return 0
  echo "lxc.mount.entry: /sys host/sys none bind,ro,nosuid,nodev,noexec,optional,create=dir 0 0"
}

# stdin: selected TSV -> stdout: the chirp lines (disk rules + host metric mounts; nothing
# when both are empty). No marker comments: chirp_apply_conf recognises its lines by content.
chirp_render_block() {
  local tsv majors m byid host
  tsv="$(cat)"
  host="$(chirp_render_host_mounts)" || return 1
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
  return 0
}

# $1: by-id name -> stdout: the block device major it resolves to on this host (nothing if gone).
chirp_byid_major() {
  local hex
  hex="$(stat -L -c '%t' "/dev/disk/by-id/$1" 2>/dev/null)" || return 0
  [[ "$hex" =~ ^[0-9a-fA-F]+$ ]] && printf '%d\n' "0x${hex}"
  return 0
}

# The awk program that recognises chirp-managed lines in the main section of a CT config
# (before the first `[section]`; snapshot and pending sections are never touched). Exactly
# the formats chirp_render_block writes (either `key: value` or `key = value`, as Proxmox
# may normalise them), plus older chirp formats and marker comments:
#  - host metric mounts: /proc/{meminfo,stat,loadavg} -> host/proc/..., /sys -> host/sys
#  - disk mounts: /dev/disk/by-id/X dev/disk/by-id/X none bind,optional,create=file
#  - `lxc.cgroup2.devices.allow: b <M>:* <perm>` for M in the `majors` variable (the majors
#    chirp adds now plus those of the disk mounts it removes)
# mode=list prints the by-id names of the disk mounts; mode=rewrite drops every chirp line
# and inserts the block file once, before the first section.
CHIRP_CONF_AWK='
  function trim(x) { sub(/^[ \t]+/, "", x); sub(/[ \t]+$/, "", x); return x }
  function kv(line, key,   r) {
    if (index(line, key) != 1) return ""
    r = substr(line, length(key) + 1)
    if (r !~ /^[ \t]*[:=]/) return ""
    sub(/^[ \t]*[:=][ \t]*/, "", r)
    return trim(r)
  }
  function ours(line,   v, f, n, okmaj) {
    # Old markers, verbatim or as Proxmox re-encodes description lines (":" -> "%3A").
    if (line ~ /^#[ \t]*chirp-passthrough(:|%3[Aa])(start|end)[ \t]*$/) return 1
    v = kv(line, "lxc.mount.entry")
    if (v != "") {
      n = split(v, f, /[ \t]+/)
      if (n == 6 && f[3] == "none" && f[5] == "0" && f[6] == "0") {
        if ((f[1] == "/proc/meminfo" || f[1] == "/proc/stat" || f[1] == "/proc/loadavg") \
            && f[2] == "host" f[1] && f[4] == "bind,ro,optional,create=file") return 1
        if (f[1] == "/sys" && f[2] == "host/sys" \
            && (f[4] == "bind,ro,optional,create=dir" || f[4] == "bind,ro,nosuid,nodev,noexec,optional,create=dir")) return 1
      }
      if (n == 4 && f[1] ~ /^\/dev\/disk\/by-id\/[^\/]+$/ && f[2] == substr(f[1], 2) \
          && f[3] == "none" && f[4] == "bind,optional,create=file") return 2
      return 0
    }
    v = kv(line, "lxc.cgroup2.devices.allow")
    if (v != "") {
      n = split(v, f, /[ \t]+/)
      if (n == 3 && f[1] == "b" && f[2] ~ /^[0-9]+:\*$/ && f[3] ~ /^r?w?m?$/ && f[3] != "") {
        okmaj = f[2]; sub(/:\*$/, "", okmaj)
        if (index("," majors ",", "," okmaj ",")) return 1
      }
    }
    return 0
  }
  function emit(   l) {
    if (done) return
    done = 1
    if (bf == "") return
    while ((getline l < bf) > 0) print l
    close(bf)
  }
  /^\[/ { if (mode == "rewrite") emit(); sect = 1 }
  {
    if (!sect) {
      t = ours($0)
      if (mode == "list") {
        if (t == 2) { v = kv($0, "lxc.mount.entry"); split(v, f, /[ \t]+/); sub(/^\/dev\/disk\/by-id\//, "", f[1]); print f[1] }
        next
      }
      if (t) next
    }
    if (mode == "rewrite") print
  }
  END { if (mode == "rewrite") emit() }
'

# $1: conf file, $2: file with freshly rendered lines, $3: owned-major state file.
# Tests default the state file beside their temporary config; production supplies
# /var/lib/chirp-passthrough/<CTID>.majors (outside pmxcfs).
# Removes every chirp-managed line from the main section wherever it is (Proxmox may have
# reordered the file) and writes the new set once, before the first `[section]` (appended
# after it, it would become part of a snapshot's config). Idempotent; never touches
# snapshot/pending sections or other lxc.* lines; leaves the file unchanged on any doubt.
chirp_apply_conf() {
  local conf="$1" blockfile="$2" state="${3:-$1.chirp-majors}" tmp majors byid m recorded="" newmajors state_tmp missing=0
  if [[ ! -s "$conf" ]]; then
    _cp_err "${conf} is missing or empty."
    return 1
  fi
  if [[ ! -r "$blockfile" ]]; then
    _cp_err "Cannot read the block file: ${blockfile}"
    return 1
  fi
  if grep -q $'\r' "$conf"; then
    _cp_err "${conf} has Windows (CRLF) line endings; Proxmox does not write those. Fix it by hand. Leaving it unchanged."
    return 1
  fi
  # Retain ownership independently of /dev: a removed disk no longer has a by-id link.
  if [[ -e "$state" ]]; then
    if [[ ! -r "$state" ]] || grep -qvE '^[0-9]+$' "$state"; then
      _cp_err "Cannot read valid owned-major state: ${state}. Leaving ${conf} unchanged."
      return 1
    fi
    recorded="$(cat "$state")"
  fi
  newmajors="$(sed -nE 's/^lxc\.cgroup2\.devices\.allow: b ([0-9]+):\* .*/\1/p' "$blockfile")"
  majors="$newmajors"$'\n'"$recorded"
  while IFS= read -r byid; do
    [[ -n "$byid" ]] || continue
    m="$(chirp_byid_major "$byid")"
    [[ -n "$m" ]] || missing=1
    if [[ -z "$m" && -z "$recorded" ]]; then
      _cp_err "Cannot identify the old rule for missing disk ${byid}. Remove its stale cgroup rule and mount manually before retrying; leaving ${conf} unchanged."
      return 1
    fi
    [[ -n "$m" ]] && majors+=$'\n'"$m"
  done < <(awk -v mode=list -v majors="" "$CHIRP_CONF_AWK" "$conf")
  majors="$(printf '%s\n' "$majors" | sed '/^$/d' | sort -n -u | paste -sd, -)"
  # A CT snapshot can restore old rules without restoring this host-side state.
  # With missing disks we cannot attribute an unrecorded wildcard rule safely.
  if ((missing)); then
    while IFS= read -r m; do
      case ",$majors," in
        *",$m,"*) ;;
        *)
          _cp_err "Missing disks and unrecorded block major ${m}: CT configuration and ownership state may differ. Reconcile the stale rules before retrying; leaving ${conf} unchanged."
          return 1
          ;;
      esac
    done < <(awk '
      /^\[/ {exit}
      {
        line = $0
        if (sub(/^lxc[.]cgroup2[.]devices[.]allow[ \t]*[:=][ \t]*/, "", line) && line ~ /^b[ \t]+[0-9]+:\*[ \t]+/) {
          split(line, f, /[ \t]+/); sub(/:\*$/, "", f[2]); print f[2]
        }
      }
    ' "$conf")
  fi
  tmp="$(mktemp)" || return 1
  if ! awk -v mode=rewrite -v majors="$majors" \
      -v bf="$blockfile" "$CHIRP_CONF_AWK" "$conf" >"$tmp"; then
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
  # Write the union first: interruption during the config write must not lose ownership.
  state_tmp="$(mktemp "${state}.XXXXXX")" || { rm -f "$tmp"; return 1; }
  if ! { tr ',' '\n' <<<"$majors" | sed '/^$/d' >"$state_tmp" && mv -f "$state_tmp" "$state"; }; then
    rm -f "$tmp" "$state_tmp"
    return 1
  fi
  # On pmxcfs (/etc/pve) overwrite in place rather than rename (keeps mode/ownership).
  if ! cmp -s "$tmp" "$conf" && ! cat "$tmp" >"$conf"; then
    _cp_err "Failed to write ${conf}."
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
  state_tmp="$(mktemp "${state}.XXXXXX")" || return 1
  if ! { printf '%s\n' "$newmajors" | sed '/^$/d' >"$state_tmp" && mv -f "$state_tmp" "$state"; }; then
    rm -f "$state_tmp"
    return 1
  fi
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

chirp_detect_scheme() {
  local ctid="$1" ip="$2"
  if [[ -n "$ctid" ]] && command -v pct >/dev/null 2>&1; then
    local cert
    cert="$(pct exec "$ctid" -- grep -E '^[[:space:]]*CHIRP_TLS_CERT=' /etc/chirp/chirp.env 2>/dev/null | cut -d= -f2- | tr -d ' "\r\n' || true)"
    if [[ -n "$cert" ]]; then
      echo "https"
      return 0
    fi
  fi
  echo "http"
}

# Whether the server still needs its first admin account: true | false | unknown.
# $1 IP. $2 Scheme (optional, default http).
chirp_bootstrap_state() {
  local ip="$1" scheme="${2:-http}" body
  body="$(curl -kfsS --max-time 5 "${scheme}://${ip}/api/v1/bootstrap/status" 2>/dev/null)" || {
    local alt="https"
    [[ "$scheme" == "https" ]] && alt="http"
    body="$(curl -kfsS --max-time 5 "${alt}://${ip}/api/v1/bootstrap/status" 2>/dev/null)" || { echo unknown; return 0; }
  }
  if [[ "$body" == *'"needsBootstrap":true'* ]]; then echo true
  elif [[ "$body" == *'"needsBootstrap":false'* ]]; then echo false
  else echo unknown
  fi
}

# Final instructions: create the admin account, then copy the API key into Home Assistant.
# $1 CTID, $2 IP. No credential is printed: the key lives in the dashboard (Settings -> API key).
chirp_account_report() {
  local ctid="$1" ip="$2" cli=/opt/chirp/current/apps/server/dist/cli.js
  local scheme url state
  scheme="$(chirp_detect_scheme "$ctid" "$ip")"
  url="${scheme}://${ip}/"
  state="$(chirp_bootstrap_state "$ip" "$scheme")"
  echo "=============================================="
  echo " Dashboard : ${url}"
  echo
  case "$state" in
    true)
      echo " >>> Open ${url} now and create the admin account."
      echo "     A setup token is required for initial registration."
      echo "     Retrieve it with: pct exec ${ctid} -- grep -E '^CHIRP_SETUP_TOKEN=' /etc/chirp/chirp.env"
      ;;
    false)
      echo " Sign in with your admin account."
      echo " Forgot the password? pct exec ${ctid} -- node ${cli} admin reset-password"
      ;;
    *)
      echo " Open ${url} and create the admin account (or sign in if it exists)."
      echo " Retrieve the setup token with: pct exec ${ctid} -- grep -E '^CHIRP_SETUP_TOKEN=' /etc/chirp/chirp.env"
      ;;
  esac
  echo
  echo " Home Assistant:"
  echo "   1. In the dashboard: Settings -> API key -> Copy"
  echo "   2. HACS custom repository eigger/hass-chirp, integration domain chirp"
  echo "   3. Host ${ip} / port 80 / the API key you copied"
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
  echo

  chirp_account_report "$ctid" "$ip"
  echo
  echo " After adding/replacing disks (or to add the host metric mounts to an"
  echo " older install), re-run on the host:"
  echo "   bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/install/chirp-passthrough.sh)\" _ ${ctid}"
  echo " The selection replaces the current one: pick every disk to keep (non-interactive"
  echo " runs default to CHIRP_DISKS=all; CHIRP_DISKS=none removes all disks)."
  echo " Host metric mounts: CHIRP_HOST_MOUNTS=all (default) | proc | 0"
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

# $1: the host's class/net directory, $2: the container's own interface names (newline-separated).
# stdout: an interface that proves /host/sys shows the host's network namespace: a real network
# device (has a `type` or `address` file; never `bonding_masters`), not a per-guest device, and
# absent from the container's own namespace (a host `eth0` would also match the CT's `eth0`).
# Preference: vmbr*, then bond<N>*, then any other. Returns 1 when nothing distinguishes them.
chirp_pick_host_iface() {
  local dir="$1" ct="$2" pass p n
  for pass in vmbr bond other; do
    for p in "$dir"/*; do
      n="${p##*/}"
      [[ -e "$p/type" || -e "$p/address" ]] || continue
      case "$n" in
        lo|veth*|tap*|fwbr*|fwpr*|fwln*|docker*|br-*|bonding_masters) continue ;;
      esac
      if [[ -n "$ct" ]] && grep -qxF -- "$n" <<<"$ct"; then continue; fi
      case "$pass" in
        vmbr) [[ "$n" == vmbr* ]] || continue ;;
        bond) [[ "$n" =~ ^bond[0-9] ]] || continue ;;
      esac
      printf '%s\n' "$n"
      return 0
    done
  done
  return 1
}

# Verify that the host metric mounts show the host's values (not the container's).
chirp_check_host_mounts() {
  local ctid="$1" host_mem ct_mem iface mode ct_own
  mode="$(chirp_host_mounts_mode)" || return 0
  [[ "$mode" == "none" ]] && return 0
  host_mem="$(cat /proc/meminfo 2>/dev/null)"
  ct_mem="$(pct exec "$ctid" -- cat /host/proc/meminfo 2>/dev/null || true)"
  if chirp_memtotal_matches "$host_mem" "$ct_mem"; then
    echo "Host metric mounts: /host/proc/meminfo MemTotal matches the host: OK"
  else
    _cp_warn "Host metric mounts: /host/proc/meminfo does not match the host; memory/load will show the container view."
  fi
  [[ "$mode" == "all" ]] || return 0
  # Guests start and stop, so do not compare whole lists: one host-only interface must be there.
  ct_own="$(pct exec "$ctid" -- sh -c 'ls /sys/class/net 2>/dev/null' || true)"
  if ! iface="$(chirp_pick_host_iface /sys/class/net "$ct_own")"; then
    _cp_warn "Host metric mounts: network check inconclusive (no host interface that the container's own namespace lacks); only MemTotal was verified."
    return 0
  fi
  if pct exec "$ctid" -- test -e "/host/sys/class/net/${iface}"; then
    echo "Host metric mounts: /host/sys/class/net shows the host interface ${iface}: OK"
  else
    _cp_warn "Host metric mounts: ${iface} is missing under /host/sys/class/net; network will show the container view."
  fi
}

chirp_passthrough_run() {
  local ctid="${1:-}" conf detected selection="" sel_tsv listing lsblk_text blockfile ip devices
  if [[ -z "$ctid" || ! "$ctid" =~ ^[0-9]+$ ]]; then
    _cp_err "Usage: chirp-passthrough.sh <CTID>"
    return 1
  fi
  if ! chirp_host_mounts_mode >/dev/null; then
    _cp_err "CHIRP_HOST_MOUNTS must be all, proc or 0 (got \"${CHIRP_HOST_MOUNTS}\")."
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
  if ! mkdir -p /var/lib/chirp-passthrough || ! chmod 700 /var/lib/chirp-passthrough; then
    rm -f "$blockfile"
    return 1
  fi
  if ! chirp_apply_conf "$conf" "$blockfile" "/var/lib/chirp-passthrough/${ctid}.majors"; then
    rm -f "$blockfile"
    return 1
  fi
  if [[ -s "$blockfile" ]]; then
    if [[ -n "$sel_tsv" ]]; then
      _cp_msg "Applied the chirp lines to ${conf}:"
    else
      _cp_msg "No disks selected; applied the host metric mounts to ${conf}:"
    fi
    sed 's/^/  /' "$blockfile"
  else
    _cp_msg "No disks selected and CHIRP_HOST_MOUNTS=0; removed the chirp lines from ${conf}."
  fi
  rm -f "$blockfile"

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
