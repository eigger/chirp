#!/usr/bin/env bash
# Test the pure functions of chirp-passthrough.sh (disk detection, by-id choice,
# conf marker block) with fake lsblk/by-id input. Runs without Proxmox.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export CHIRP_PASSTHROUGH_LIB=1
# shellcheck disable=SC1091
source "$REPO_ROOT/proxmox/install/chirp-passthrough.sh"

PASS=0; FAILS=0
eq() { # name expected actual
  if [[ "$2" == "$3" ]]; then PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"
  else FAILS=$((FAILS + 1)); printf '  FAIL %s\n    expected: %q\n    actual:   %q\n' "$1" "$2" "$3"; fi
}

LSBLK='NAME="loop0" MAJ:MIN="7:0" TYPE="loop" TRAN="" MODEL="" SERIAL="" SIZE="100M"
NAME="sda" MAJ:MIN="8:0" TYPE="disk" TRAN="sata" MODEL="Samsung\x20SSD\x20860" SERIAL="S3Z9NB0K" SIZE="465.8G"
NAME="sdb" MAJ:MIN="8:16" TYPE="disk" TRAN="sata" MODEL="WDC WD40EFRX" SERIAL="WD-1234" SIZE="3.6T"
NAME="nvme0n1" MAJ:MIN="259:0" TYPE="disk" TRAN="nvme" MODEL="Samsung SSD 980" SERIAL="S64DNX0" SIZE="931.5G"
NAME="zram0" MAJ:MIN="251:0" TYPE="disk" TRAN="" MODEL="" SERIAL="" SIZE="8G"
NAME="rbd0" MAJ:MIN="252:0" TYPE="disk" TRAN="" MODEL="" SERIAL="" SIZE="10G"
NAME="nbd0" MAJ:MIN="43:0" TYPE="disk" TRAN="" MODEL="" SERIAL="" SIZE="1G"
NAME="dm-0" MAJ:MIN="253:0" TYPE="lvm" TRAN="" MODEL="" SERIAL="" SIZE="50G"
NAME="md0" MAJ:MIN="9:0" TYPE="raid1" TRAN="" MODEL="" SERIAL="" SIZE="3T"
NAME="sr0" MAJ:MIN="11:0" TYPE="rom" TRAN="sata" MODEL="DVD" SERIAL="" SIZE="1024M"
NAME="sdc" MAJ:MIN="8:32" TYPE="disk" TRAN="usb" MODEL="NoById" SERIAL="X" SIZE="1T"'

LISTING='ata-Samsung_SSD_860_EVO_S3Z9NB0K sda
ata-Samsung_SSD_860_EVO_S3Z9NB0K-part1 sda
wwn-0x5002538e40000001 sda
wwn-0x5002538e40000001-part1 sda
scsi-SATA_Samsung_SSD_S3Z9NB0K sda
ata-WDC_WD40EFRX_WD-1234 sdb
scsi-35000cca000000001 sdb
nvme-Samsung_SSD_980_S64DNX0 nvme0n1
nvme-Samsung_SSD_980_S64DNX0_1 nvme0n1
nvme-eui.0025385b21400001 nvme0n1
nvme-eui.0025385b21400001-part1 nvme0n1'

echo "[1] disk filter (TYPE=disk, without loop/zram/rbd/nbd/dm/md/sr)"
names="$(chirp_list_disks <<<"$LSBLK" | cut -f1 | paste -sd, -)"
eq "eligible disks" "sda,sdb,nvme0n1,sdc" "$names"
eq "model hex-escape decoded" "Samsung SSD 860" "$(chirp_list_disks <<<"$LSBLK" | awk -F'\t' '$1=="sda"{print $4}')"

echo "[2] by-id priority"
eq "sda -> wwn" "wwn-0x5002538e40000001" "$(chirp_pick_byid sda <<<"$LISTING")"
eq "sdb -> ata (no wwn)" "ata-WDC_WD40EFRX_WD-1234" "$(chirp_pick_byid sdb <<<"$LISTING")"
eq "nvme -> nvme-eui" "nvme-eui.0025385b21400001" "$(chirp_pick_byid nvme0n1 <<<"$LISTING")"
eq "nvme model/serial fallback" "nvme-Samsung_SSD_980_S64DNX0" \
  "$(chirp_pick_byid nvme0n1 < <(grep -v eui <<<"$LISTING"))"
eq "scsi fallback" "scsi-35000cca000000001" "$(chirp_pick_byid sdb < <(grep -v '^ata' <<<"$LISTING"))"
eq "part-only -> empty" "" "$(chirp_pick_byid sda < <(grep -- '-part' <<<"$LISTING"))"

echo "[3] detect (sdc without by-id is skipped)"
DETECTED="$(chirp_detect_disks "$LSBLK" "$LISTING" 2>/dev/null)"
eq "detected by-ids" "wwn-0x5002538e40000001,ata-WDC_WD40EFRX_WD-1234,nvme-eui.0025385b21400001" \
  "$(cut -f1 <<<"$DETECTED" | paste -sd, -)"

echo "[4] selection (CHIRP_DISKS)"
eq "all" "3" "$(chirp_resolve_selection all "$DETECTED" | wc -l | tr -d ' ')"
eq "none" "" "$(chirp_resolve_selection none "$DETECTED")"
eq "list" "ata-WDC_WD40EFRX_WD-1234" \
  "$(chirp_resolve_selection "/dev/disk/by-id/ata-WDC_WD40EFRX_WD-1234" "$DETECTED" | cut -f1)"
chirp_resolve_selection "ata-NOPE" "$DETECTED" >/dev/null 2>&1; eq "unknown -> rc 1" "1" "$?"

echo "[5] majors / block rendering"
SEL_ALL="$(chirp_resolve_selection all "$DETECTED")"
eq "majors" "8,259" "$(chirp_majors <<<"$SEL_ALL" | paste -sd, -)"
SEL_SDB="$(chirp_resolve_selection ata-WDC_WD40EFRX_WD-1234 "$DETECTED")"
BLOCK="$(chirp_render_block <<<"$SEL_ALL")"
EXPECTED_BLOCK='# chirp-passthrough:start
lxc.cgroup2.devices.allow: b 8:* rw
lxc.cgroup2.devices.allow: b 259:* rw
lxc.mount.entry: /dev/disk/by-id/wwn-0x5002538e40000001 dev/disk/by-id/wwn-0x5002538e40000001 none bind,optional,create=file
lxc.mount.entry: /dev/disk/by-id/ata-WDC_WD40EFRX_WD-1234 dev/disk/by-id/ata-WDC_WD40EFRX_WD-1234 none bind,optional,create=file
lxc.mount.entry: /dev/disk/by-id/nvme-eui.0025385b21400001 dev/disk/by-id/nvme-eui.0025385b21400001 none bind,optional,create=file
lxc.mount.entry: /proc/meminfo host/proc/meminfo none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/stat host/proc/stat none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/loadavg host/proc/loadavg none bind,ro,optional,create=file 0 0
lxc.mount.entry: /sys host/sys none bind,ro,nosuid,nodev,noexec,optional,create=dir 0 0
# chirp-passthrough:end'
eq "block content" "$EXPECTED_BLOCK" "$BLOCK"
EXPECTED_HOST_ONLY='# chirp-passthrough:start
lxc.mount.entry: /proc/meminfo host/proc/meminfo none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/stat host/proc/stat none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/loadavg host/proc/loadavg none bind,ro,optional,create=file 0 0
lxc.mount.entry: /sys host/sys none bind,ro,nosuid,nodev,noexec,optional,create=dir 0 0
# chirp-passthrough:end'
eq "empty selection -> host metric mounts only" "$EXPECTED_HOST_ONLY" "$(chirp_render_block <<<"")"
eq "empty selection + CHIRP_HOST_MOUNTS=0 -> no block" "" "$(CHIRP_HOST_MOUNTS=0; chirp_render_block <<<"")"
eq "CHIRP_HOST_MOUNTS=0 -> no host mounts" "0" "$(CHIRP_HOST_MOUNTS=0; chirp_render_block <<<"$SEL_ALL" | grep -c ' host/')"
eq "host mounts are read-only" "4" "$(chirp_render_host_mounts | grep -c 'bind,ro,')"
eq "host /sys is nosuid,nodev,noexec" "1" "$(chirp_render_host_mounts | grep -c 'host/sys none bind,ro,nosuid,nodev,noexec,optional')"
EXPECTED_PROC_ONLY='lxc.mount.entry: /proc/meminfo host/proc/meminfo none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/stat host/proc/stat none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/loadavg host/proc/loadavg none bind,ro,optional,create=file 0 0'
eq "CHIRP_HOST_MOUNTS=proc -> /proc files only" "$EXPECTED_PROC_ONLY" "$(CHIRP_HOST_MOUNTS=proc; chirp_render_host_mounts)"
eq "CHIRP_HOST_MOUNTS=proc -> no /sys" "0" "$(CHIRP_HOST_MOUNTS=proc; chirp_render_block <<<"$SEL_ALL" | grep -c 'host/sys')"
for v in all ALL 1 ""; do
  eq "mode '${v}' -> all" "all" "$(CHIRP_HOST_MOUNTS="$v"; chirp_host_mounts_mode)"
done
for v in 0 none; do
  eq "mode '${v}' -> none" "none" "$(CHIRP_HOST_MOUNTS="$v"; chirp_host_mounts_mode)"
done
(CHIRP_HOST_MOUNTS=bogus; chirp_host_mounts_mode >/dev/null); eq "unknown mode -> rc 1" "1" "$?"
(CHIRP_HOST_MOUNTS=bogus; chirp_render_block <<<"$SEL_ALL" >/dev/null); eq "unknown mode -> no block (rc 1)" "1" "$?"
eq "no /proc/net mount (per network namespace)" "0" "$(chirp_render_host_mounts | grep -c '/proc/net')"
eq "CHIRP_DEVICES value" "/dev/disk/by-id/wwn-0x5002538e40000001,/dev/disk/by-id/ata-WDC_WD40EFRX_WD-1234,/dev/disk/by-id/nvme-eui.0025385b21400001" \
  "$(chirp_devices_value <<<"$SEL_ALL")"

echo "[6] conf apply is idempotent"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CONF="$TMP/100.conf"
printf 'arch: amd64\nhostname: chirp\nunprivileged: 0\n\n[snap1]\nhostname: chirp\nunprivileged: 0\n' >"$CONF"
chirp_render_block <<<"$SEL_ALL" >"$TMP/b1"
chirp_apply_conf "$CONF" "$TMP/b1"
cp "$CONF" "$TMP/after1"
chirp_apply_conf "$CONF" "$TMP/b1"
eq "apply twice == once" "$(cat "$TMP/after1")" "$(cat "$CONF")"
eq "single start marker" "1" "$(grep -c '^# chirp-passthrough:start$' "$CONF")"
eq "block precedes snapshot section" "1" "$(awk '/chirp-passthrough:end/{e=NR} /^\[snap1\]/{s=NR} END{print (e<s)}' "$CONF")"
chirp_render_block <<<"$SEL_SDB" >"$TMP/b2"
chirp_apply_conf "$CONF" "$TMP/b2"
eq "replaced: only sdb disk mount" "1" "$(grep -c '^lxc.mount.entry: /dev/disk' "$CONF")"
eq "replaced: host mounts kept once" "4" "$(grep -c '^lxc.mount.entry: /[ps][ry][os]' "$CONF")"
# Upgrade path: an old block (disks only, from a release without host mounts) gains them on re-run.
OLD_BLOCK="$(CHIRP_HOST_MOUNTS=0; chirp_render_block <<<"$SEL_SDB")"
printf '%s\n' "$OLD_BLOCK" >"$TMP/old"
chirp_apply_conf "$CONF" "$TMP/old"
eq "old block: no host mounts" "0" "$(grep -c ' host/' "$CONF")"
chirp_apply_conf "$CONF" "$TMP/b2"
eq "re-run adds host mounts" "4" "$(grep -c ' host/' "$CONF")"
eq "re-run keeps a single block" "1" "$(grep -c '^# chirp-passthrough:start$' "$CONF")"
# Switching modes rewrites the block in place.
(CHIRP_HOST_MOUNTS=proc; chirp_render_block <<<"$SEL_SDB") >"$TMP/bp"
chirp_apply_conf "$CONF" "$TMP/bp"
eq "all -> proc: 3 host mounts" "3" "$(grep -c ' host/' "$CONF")"
eq "all -> proc: no /sys" "0" "$(grep -c 'host/sys' "$CONF")"
(CHIRP_HOST_MOUNTS=0; chirp_render_block <<<"$SEL_SDB") >"$TMP/bn"
chirp_apply_conf "$CONF" "$TMP/bn"
eq "proc -> 0: no host mounts" "0" "$(grep -c ' host/' "$CONF")"
eq "proc -> 0: disk kept" "1" "$(grep -c '^lxc.mount.entry: /dev/disk' "$CONF")"
chirp_apply_conf "$CONF" "$TMP/b2"
eq "0 -> all: 4 host mounts" "4" "$(grep -c ' host/' "$CONF")"
eq "mode switches keep a single block" "1" "$(grep -c '^# chirp-passthrough:start$' "$CONF")"
eq "replaced: no 259 rule" "0" "$(grep -c '259:' "$CONF")"
: >"$TMP/b3"
chirp_apply_conf "$CONF" "$TMP/b3"
eq "removed block" "0" "$(grep -c 'chirp-passthrough' "$CONF")"
printf 'arch: amd64\nhostname: chirp\nunprivileged: 0\n\n[snap1]\nhostname: chirp\nunprivileged: 0\n' >"$TMP/orig"
eq "back to original" "$(cat "$TMP/orig")" "$(cat "$CONF")"

echo "[7] conf protection (unchanged on failure)"
chirp_apply_conf "$CONF" "$TMP/does-not-exist" 2>/dev/null; eq "missing block file -> rc 1" "1" "$?"
eq "missing block file -> conf untouched" "$(cat "$TMP/orig")" "$(cat "$CONF")"
: >"$TMP/empty.conf"
chirp_apply_conf "$TMP/empty.conf" "$TMP/b1" 2>/dev/null; eq "empty conf -> rc 1" "1" "$?"
chirp_apply_conf "$TMP/nope.conf" "$TMP/b1" 2>/dev/null; eq "missing conf -> rc 1" "1" "$?"
eq "missing conf not created" "no" "$([[ -e "$TMP/nope.conf" ]] && echo yes || echo no)"

echo "[8] the selection list is not glob-expanded"
touch "$TMP/ata-WDC_WD40EFRX_WD-1234"
eq "glob item is not expanded" "1" \
  "$(cd "$TMP" && { chirp_resolve_selection 'ata-WDC*' "$DETECTED" >/dev/null 2>&1; echo $?; })"
eq "spaces around items trimmed" "ata-WDC_WD40EFRX_WD-1234" \
  "$(chirp_resolve_selection " ata-WDC_WD40EFRX_WD-1234 " "$DETECTED" | cut -f1)"

echo "[9] MemTotal comparison (smoke test)"
chirp_memtotal_matches $'MemTotal:       65536000 kB\nMemFree: 1 kB' $'MemTotal:       65536000 kB'; eq "same MemTotal" "0" "$?"
chirp_memtotal_matches $'MemTotal:       65536000 kB' $'MemTotal:         524288 kB'; eq "lxcfs MemTotal differs" "1" "$?"
chirp_memtotal_matches $'MemTotal:       65536000 kB' ""; eq "missing mount" "1" "$?"

echo "[10] host-only interface for the mount check"
NET="$TMP/net"
mkiface() { mkdir -p "$NET/$1"; echo 1 >"$NET/$1/type"; }
mkdir -p "$NET"; : >"$NET/bonding_masters"
for i in bond0 docker0 eno1 eth0 fwbr100i0 lo tap100i0 veth101i0 vmbr0; do mkiface "$i"; done
eq "prefers vmbr*" "vmbr0" "$(chirp_pick_host_iface "$NET" $'eth0\nlo')"
rm -rf "$NET/vmbr0"
eq "then bond<N>" "bond0" "$(chirp_pick_host_iface "$NET" $'eth0\nlo')"
rm -rf "$NET/bond0"
eq "never bonding_masters; then any real device" "eno1" "$(chirp_pick_host_iface "$NET" $'eth0\nlo')"
rm -rf "$NET/eno1"
chirp_pick_host_iface "$NET" $'eth0\nlo' >/dev/null; eq "host eth0 clashes with the CT's eth0 -> inconclusive (rc 1)" "1" "$?"
eq "eth0 counts when the CT has none" "eth0" "$(chirp_pick_host_iface "$NET" "lo")"
rm -rf "$NET"; mkdir -p "$NET"; : >"$NET/bonding_masters"; mkiface lo; mkiface tap100i0
chirp_pick_host_iface "$NET" "" >/dev/null; eq "only guest devices -> rc 1" "1" "$?"

echo "[10b] unbalanced markers leave the conf unchanged"
printf 'arch: amd64\n# chirp-passthrough:start\nlxc.mount.entry: x\n\n[snap1]\nhostname: chirp\n' >"$TMP/broken.conf"
cp "$TMP/broken.conf" "$TMP/broken.orig"
chirp_apply_conf "$TMP/broken.conf" "$TMP/b2" 2>/dev/null; eq "start without end -> rc 1" "1" "$?"
eq "start without end -> untouched (snapshot kept)" "$(cat "$TMP/broken.orig")" "$(cat "$TMP/broken.conf")"
printf 'arch: amd64\n# chirp-passthrough:end\n' >"$TMP/broken2.conf"
chirp_apply_conf "$TMP/broken2.conf" "$TMP/b2" 2>/dev/null; eq "end without start -> rc 1" "1" "$?"

echo "[11] CHIRP_DEV_PERM overrides the default rw"
eq "rwm override" "lxc.cgroup2.devices.allow: b 8:* rwm" \
  "$(CHIRP_DEV_PERM=rwm; chirp_render_block <<<"$SEL_SDB" | grep cgroup2)"

echo
echo "passed=${PASS} failed=${FAILS}"
[[ "$FAILS" -eq 0 ]]
