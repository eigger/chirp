#!/usr/bin/env bash
# Test the pure functions of chirp-passthrough.sh (disk detection, by-id choice,
# conf marker block) with fake lsblk/by-id input. Runs without Proxmox.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export CHIRP_PASSTHROUGH_LIB=1
# shellcheck disable=SC1091
source "$REPO_ROOT/proxmox/install/chirp-passthrough.sh"
# No real /dev/disk/by-id here: majors of the fake disks.
chirp_byid_major() { case "$1" in wwn-*|ata-*) echo 8 ;; nvme-*) echo 259 ;; esac; }

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
EXPECTED_BLOCK='lxc.cgroup2.devices.allow: b 8:* rw
lxc.cgroup2.devices.allow: b 259:* rw
lxc.mount.entry: /dev/disk/by-id/wwn-0x5002538e40000001 dev/disk/by-id/wwn-0x5002538e40000001 none bind,optional,create=file
lxc.mount.entry: /dev/disk/by-id/ata-WDC_WD40EFRX_WD-1234 dev/disk/by-id/ata-WDC_WD40EFRX_WD-1234 none bind,optional,create=file
lxc.mount.entry: /dev/disk/by-id/nvme-eui.0025385b21400001 dev/disk/by-id/nvme-eui.0025385b21400001 none bind,optional,create=file
lxc.mount.entry: /proc/meminfo host/proc/meminfo none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/stat host/proc/stat none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/loadavg host/proc/loadavg none bind,ro,optional,create=file 0 0
lxc.mount.entry: /sys host/sys none bind,ro,nosuid,nodev,noexec,optional,create=dir 0 0'
eq "block content" "$EXPECTED_BLOCK" "$BLOCK"
EXPECTED_HOST_ONLY='lxc.mount.entry: /proc/meminfo host/proc/meminfo none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/stat host/proc/stat none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/loadavg host/proc/loadavg none bind,ro,optional,create=file 0 0
lxc.mount.entry: /sys host/sys none bind,ro,nosuid,nodev,noexec,optional,create=dir 0 0'
eq "no marker comments rendered" "0" "$(chirp_render_block <<<"$SEL_ALL" | grep -c '^#')"
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
eq "each chirp line once" "9" "$(grep -c '^lxc\.' "$CONF")"
eq "lines precede the snapshot section" "1" "$(awk '/^lxc\./{e=NR} /^\[snap1\]/{s=NR} END{print (e<s)}' "$CONF")"
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
eq "re-run: each line once" "6" "$(grep -c '^lxc\.' "$CONF")"
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
eq "mode switches: each line once" "6" "$(grep -c '^lxc\.' "$CONF")"
eq "replaced: no 259 rule" "0" "$(grep -c '259:' "$CONF")"
: >"$TMP/b3"
chirp_apply_conf "$CONF" "$TMP/b3"
eq "removed all chirp lines" "0" "$(grep -c '^lxc\.' "$CONF")"
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

echo "[10b] content-based apply: Proxmox rewrites, old markers, user lines, snapshots"
chirp_render_block <<<"$SEL_SDB" >"$TMP/new"
snap() { awk '/^\[/{f=1} f' "$1"; }
main() { awk '/^\[/{exit} 1' "$1"; }
# What Proxmox writes after a GUI/pct edit of a config that had an old marker block: the
# markers become description lines at the top (":" encoded as %3A), lxc.* lines go last.
cat >"$TMP/pve.conf" <<'CONF'
# chirp-passthrough%3Astart
# chirp-passthrough%3Aend
#My own notes
arch: amd64
hostname: chirp
unprivileged: 0
lxc.cgroup2.devices.allow: b 8:* rw
lxc.cgroup2.devices.allow: b 259:* rw
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/disk/by-id/wwn-0x5002538e40000001 dev/disk/by-id/wwn-0x5002538e40000001 none bind,optional,create=file
lxc.mount.entry: /dev/disk/by-id/nvme-eui.0025385b21400001 dev/disk/by-id/nvme-eui.0025385b21400001 none bind,optional,create=file
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
lxc.mount.entry: /dev/disk/by-id/usb-Mine dev/disk/by-id/usb-Mine none bind,ro,create=file
lxc.mount.entry = /proc/meminfo host/proc/meminfo none bind,ro,optional,create=file 0 0
lxc.mount.entry: /sys host/sys none bind,ro,optional,create=dir 0 0

[snap1]
# chirp-passthrough%3Astart
hostname: chirp
lxc.cgroup2.devices.allow: b 8:* rw
lxc.mount.entry: /dev/disk/by-id/wwn-0x5002538e40000001 dev/disk/by-id/wwn-0x5002538e40000001 none bind,optional,create=file
CONF
snap "$TMP/pve.conf" >"$TMP/pve.snap"
chirp_apply_conf "$TMP/pve.conf" "$TMP/new"; eq "pve layout -> rc 0" "0" "$?"
eq "moved markers deleted (main section)" "0" "$(awk '/^\[/{exit} /chirp-passthrough/' "$TMP/pve.conf" | wc -l | tr -d ' ')"
eq "user's description kept" "1" "$(grep -c '^#My own notes$' "$TMP/pve.conf")"
eq "user's own cgroup rule kept" "1" "$(grep -c '^lxc.cgroup2.devices.allow: c 10:200 rwm$' "$TMP/pve.conf")"
eq "user's own mounts kept" "2" "$(main "$TMP/pve.conf" | grep -cE '^lxc.mount.entry: (/dev/net/tun|/dev/disk/by-id/usb-Mine) ')"
eq "old disk rules for removed disks gone (259)" "0" "$(awk '/^\[/{exit} /259:/' "$TMP/pve.conf" | wc -l | tr -d ' ')"
eq "old nvme mount gone" "0" "$(awk '/^\[/{exit} /nvme-eui/' "$TMP/pve.conf" | wc -l | tr -d ' ')"
eq "'key = value' form recognised (meminfo once)" "1" "$(grep -c 'host/proc/meminfo' "$TMP/pve.conf" | tr -d ' ')"
eq "old /sys format replaced" "1" "$(grep -c 'host/sys none bind,ro,nosuid' "$TMP/pve.conf")"
eq "chirp lines exactly once" "$(cat "$TMP/new")" "$(main "$TMP/pve.conf" | grep -xF -f "$TMP/new")"
eq "snapshot section untouched" "$(cat "$TMP/pve.snap")" "$(snap "$TMP/pve.conf")"
cp "$TMP/pve.conf" "$TMP/pve.once"
chirp_apply_conf "$TMP/pve.conf" "$TMP/new"
eq "idempotent re-run" "$(cat "$TMP/pve.once")" "$(cat "$TMP/pve.conf")"
# Proxmox rewrites again (chirp lines move after the user's lines): still once, no growth.
awk '/^\[/{f=1} !f && /^lxc\./{print > "/dev/stderr"; next} {print}' "$TMP/pve.conf" 2>"$TMP/lxc" >"$TMP/x"
awk -v lf="$TMP/lxc" '/^\[/ && !d {while ((getline l < lf) > 0) print l; d=1} {print}' "$TMP/x" >"$TMP/pve.conf"
chirp_apply_conf "$TMP/pve.conf" "$TMP/new"
eq "after another rewrite: chirp lines once" "$(cat "$TMP/new")" "$(main "$TMP/pve.conf" | grep -xF -f "$TMP/new")"
(CHIRP_HOST_MOUNTS=proc; chirp_render_block <<<"$SEL_SDB") >"$TMP/newp"
chirp_apply_conf "$TMP/pve.conf" "$TMP/newp"
eq "mode switch all -> proc on a pve layout" "0" "$(grep -c 'host/sys' "$TMP/pve.conf")"
eq "mode switch keeps the snapshot" "$(cat "$TMP/pve.snap")" "$(snap "$TMP/pve.conf")"

# Old marker block still in place (written by an older chirp, never rewritten by Proxmox).
printf 'arch: amd64\n# chirp-passthrough:start\nlxc.cgroup2.devices.allow: b 8:* rw\nlxc.mount.entry: /dev/disk/by-id/ata-WDC_WD40EFRX_WD-1234 dev/disk/by-id/ata-WDC_WD40EFRX_WD-1234 none bind,optional,create=file\n# chirp-passthrough:end\n\n[snap1]\nhostname: chirp\n' >"$TMP/old.conf"
chirp_apply_conf "$TMP/old.conf" "$TMP/new"
eq "old marker block migrated" "0" "$(grep -c 'chirp-passthrough' "$TMP/old.conf")"
eq "old marker block: lines once" "$(cat "$TMP/new")" "$(main "$TMP/old.conf" | grep -xF -f "$TMP/new")"

# L4: wrong order / unbalanced markers no longer delimit anything: nothing else is dropped.
printf 'arch: amd64\n# chirp-passthrough:end\nhostname: chirp\n# chirp-passthrough:start\nmemory: 512\n\n[snap1]\nhostname: chirp\n' >"$TMP/order.conf"
snap "$TMP/order.conf" >"$TMP/order.snap"
chirp_apply_conf "$TMP/order.conf" "$TMP/new"; eq "end before start -> rc 0" "0" "$?"
eq "end before start: other keys kept" "2" "$(main "$TMP/order.conf" | grep -cE '^(hostname: chirp|memory: 512)$')"
eq "end before start: snapshot kept" "$(cat "$TMP/order.snap")" "$(snap "$TMP/order.conf")"
printf 'arch: amd64\n# chirp-passthrough:start\nmemory: 512\n\n[snap1]\nhostname: chirp\n' >"$TMP/nostart.conf"
chirp_apply_conf "$TMP/nostart.conf" "$TMP/new"
eq "start without end: keys and snapshot kept" "2" "$(grep -cE '^(memory: 512|\[snap1\])$' "$TMP/nostart.conf")"

# CRLF files are refused and left unchanged.
printf 'arch: amd64\r\nhostname: chirp\r\n' >"$TMP/crlf.conf"
cp "$TMP/crlf.conf" "$TMP/crlf.orig"
chirp_apply_conf "$TMP/crlf.conf" "$TMP/new" 2>/dev/null; eq "CRLF -> rc 1" "1" "$?"
eq "CRLF -> unchanged" "$(od -c "$TMP/crlf.orig")" "$(od -c "$TMP/crlf.conf")"

echo "[11] CHIRP_DEV_PERM overrides the default rw"
eq "rwm override" "lxc.cgroup2.devices.allow: b 8:* rwm" \
  "$(CHIRP_DEV_PERM=rwm; chirp_render_block <<<"$SEL_SDB" | grep cgroup2)"

echo "[12] removed disks retain rule ownership without by-id links"
printf 'arch: amd64\nlxc.cgroup2.devices.allow: c 10:200 rwm\n' >"$TMP/gone.conf"
chirp_render_block <<<"$SEL_ALL" >"$TMP/gone.block"
chirp_apply_conf "$TMP/gone.conf" "$TMP/gone.block"
eq "records both owned majors" $'8\n259' "$(cat "$TMP/gone.conf.chirp-majors" | sort -n)"
# Simulate physically unplugging every disk after the first successful run.
chirp_byid_major() { return 0; }
: >"$TMP/gone.block"
chirp_apply_conf "$TMP/gone.conf" "$TMP/gone.block"; eq "removed disks -> rc 0" "0" "$?"
eq "removed disks: wildcard block rules gone" "0" "$(grep -c '^lxc.cgroup2.devices.allow: b ' "$TMP/gone.conf")"
eq "removed disks: unrelated rule kept" "1" "$(grep -c '^lxc.cgroup2.devices.allow: c 10:200 rwm$' "$TMP/gone.conf")"
eq "removed disks: ownership cleared" "" "$(cat "$TMP/gone.conf.chirp-majors")"
# A legacy config has no ownership record. Do not silently discard a mount
# while leaving an unidentifiable allow rule behind.
printf 'arch: amd64\nlxc.cgroup2.devices.allow: b 259:* rw\nlxc.mount.entry: /dev/disk/by-id/nvme-gone dev/disk/by-id/nvme-gone none bind,optional,create=file\n' >"$TMP/legacy-gone.conf"
cp "$TMP/legacy-gone.conf" "$TMP/legacy-gone.orig"
chirp_apply_conf "$TMP/legacy-gone.conf" "$TMP/gone.block" 2>/dev/null; eq "missing legacy disk without state -> rc 1" "1" "$?"
eq "ambiguous legacy config unchanged" "$(cat "$TMP/legacy-gone.orig")" "$(cat "$TMP/legacy-gone.conf")"
# Proxmox snapshots restore the CT config but not the host-side ownership file.
printf '8\n' >"$TMP/legacy-gone.conf.chirp-majors"
chirp_render_block <<<"$SEL_SDB" >"$TMP/restored.block"
chirp_apply_conf "$TMP/legacy-gone.conf" "$TMP/restored.block" 2>/dev/null; eq "snapshot with mismatched state -> rc 1" "1" "$?"
eq "snapshot mismatch: config unchanged" "$(cat "$TMP/legacy-gone.orig")" "$(cat "$TMP/legacy-gone.conf")"
eq "snapshot mismatch: state unchanged" "8" "$(cat "$TMP/legacy-gone.conf.chirp-majors")"
# Adopting an unchanged config must record ownership too.
chirp_byid_major() { case "$1" in wwn-*|ata-*) echo 8 ;; nvme-*) echo 259 ;; esac; }
printf 'arch: amd64\n' >"$TMP/adopt.conf"
chirp_render_block <<<"$SEL_ALL" >"$TMP/adopt.block"
cat "$TMP/adopt.block" >>"$TMP/adopt.conf"
chirp_apply_conf "$TMP/adopt.conf" "$TMP/adopt.block"
eq "unchanged legacy config adopted" $'8\n259' "$(cat "$TMP/adopt.conf.chirp-majors" | sort -n)"
printf 'corrupt\n' >"$TMP/adopt.conf.chirp-majors"
cp "$TMP/adopt.conf" "$TMP/adopt.orig"
chirp_apply_conf "$TMP/adopt.conf" "$TMP/gone.block" 2>/dev/null; eq "invalid ownership state -> rc 1" "1" "$?"
eq "invalid state: config untouched" "$(cat "$TMP/adopt.orig")" "$(cat "$TMP/adopt.conf")"
echo "[10] final report: create the admin first, no credential printed"
FAKE_BOOTSTRAP=""
curl() { [[ -n "$FAKE_BOOTSTRAP" ]] || return 22; printf '%s' "$FAKE_BOOTSTRAP"; }
FAKE_BOOTSTRAP='{"needsBootstrap":true,"setupTokenRequired":true}'
eq "state: needs bootstrap with token" "needs_token" "$(chirp_bootstrap_state 10.0.0.5)"
REPORT="$(chirp_account_report 100 10.0.0.5)"
eq "tells to create the admin now" "1" "$(grep -c 'Open http://10.0.0.5/ now and create the admin account' <<<"$REPORT")"
eq "shows setup token retrieval hint" "1" "$(grep -c 'pct exec 100 -- grep -E .*CHIRP_SETUP_TOKEN' <<<"$REPORT")"
eq "points HA at Settings -> API key" "1" "$(grep -c 'Settings -> API key -> Copy' <<<"$REPORT")"
eq "prints no key" "0" "$(grep -c 'chp_' <<<"$REPORT")"
FAKE_BOOTSTRAP='{"needsBootstrap":true}'
eq "state: legacy needs bootstrap without token" "needs_bootstrap" "$(chirp_bootstrap_state 10.0.0.5)"
eq "legacy warns about the open window" "1" "$(chirp_account_report 100 10.0.0.5 | grep -c 'anyone who can reach this address')"
FAKE_BOOTSTRAP='{"needsBootstrap":false}'
eq "state: admin exists" "ready" "$(chirp_bootstrap_state 10.0.0.5)"
eq "admin exists -> sign in + reset hint" "1" "$(chirp_account_report 100 10.0.0.5 | grep -c 'pct exec 100 -- node .*admin reset-password')"
FAKE_BOOTSTRAP=""
eq "old release / unreachable -> unknown" "unknown" "$(chirp_bootstrap_state 10.0.0.5)"
eq "unknown -> generic instruction" "1" "$(chirp_account_report 100 10.0.0.5 | grep -c 'create the admin account (or sign in')"
unset -f curl

echo "[11] pct stub: TLS and port variations in account report"
curl() { return 22; }
FAKE_ENV=""
pct() {
  if [[ "$1" == "exec" ]]; then
    shift 3
    grep -E "$3" <<<"$FAKE_ENV"
    return 0
  fi
  return 1
}

# 1. Non-standard port with HTTP
FAKE_ENV=$'CHIRP_PORT=8080\n'
REPORT="$(chirp_account_report 100 10.0.0.5)"
eq "http on port 8080 URL" "1" "$(grep -c 'Dashboard : http://10.0.0.5:8080/' <<<"$REPORT")"

# 2. TLS with port 8443 (CRLF and quotes)
FAKE_ENV=$'CHIRP_PORT="8443"\r\nCHIRP_TLS_CERT="/etc/chirp/cert.pem"\r\nCHIRP_TLS_KEY=\'/etc/chirp/key.pem\'\r\n'
REPORT="$(chirp_account_report 100 10.0.0.5)"
eq "https on port 8443 URL with CRLF and quotes" "1" "$(grep -c 'Dashboard : https://10.0.0.5:8443/' <<<"$REPORT")"

# 3. TLS with default HTTPS port 443 (omits port)
FAKE_ENV=$'CHIRP_PORT=443\nCHIRP_TLS_CERT=/etc/chirp/cert.pem\nCHIRP_TLS_KEY=/etc/chirp/key.pem\n'
REPORT="$(chirp_account_report 100 10.0.0.5)"
eq "https on port 443 omits port" "1" "$(grep -c 'Dashboard : https://10.0.0.5/' <<<"$REPORT")"

# 4. Only CERT without KEY -> falls back to HTTP
FAKE_ENV=$'CHIRP_PORT=80\nCHIRP_TLS_CERT=/etc/chirp/cert.pem\n'
REPORT="$(chirp_account_report 100 10.0.0.5)"
eq "only cert falls back to http" "1" "$(grep -c 'Dashboard : http://10.0.0.5/' <<<"$REPORT")"

# 5. Inline comments on port
FAKE_ENV=$'CHIRP_PORT=9000 # custom port\n'
REPORT="$(chirp_account_report 100 10.0.0.5)"
eq "inline comment stripped from port" "1" "$(grep -c 'Dashboard : http://10.0.0.5:9000/' <<<"$REPORT")"

unset -f pct curl

echo "[13] exact devN: passthrough (PVE >= 8.1)"
# 1. Version parsing
pveversion() { echo "pve-manager/8.1-4/3fa9280d (running kernel: 6.8.4-2-pve)"; }
eq "pve 8.1 parsed" "8.1" "$(chirp_pve_version)"
eq "pve 8.1 supports devn" "0" "$({ chirp_pve_supports_devn; echo $?; })"
pveversion() { echo "pve-manager/8.2.1/abc (running kernel: 6.8.4-2-pve)"; }
eq "pve 8.2 parsed" "8.2" "$(chirp_pve_version)"
eq "pve 8.2 supports devn" "0" "$({ chirp_pve_supports_devn; echo $?; })"
pveversion() { echo "pve-manager/9.0.0/abc"; }
eq "pve 9.0 supports devn" "0" "$({ chirp_pve_supports_devn; echo $?; })"
pveversion() { echo "pve-manager/8.0-3/xyz"; }
eq "pve 8.0 does not support devn" "1" "$({ chirp_pve_supports_devn; echo $?; })"
pveversion() { echo "pve-manager/7.4-1/xyz"; }
eq "pve 7.4 does not support devn" "1" "$({ chirp_pve_supports_devn; echo $?; })"
unset -f pveversion

# 2. Mode resolution
eq "legacy mode default" "legacy" "$(CHIRP_DEV_PASSTHROUGH="" chirp_dev_mode)"
eq "legacy mode explicit" "legacy" "$(CHIRP_DEV_PASSTHROUGH=legacy chirp_dev_mode)"
eq "auto mode resolves to legacy" "legacy" "$(CHIRP_DEV_PASSTHROUGH=auto chirp_dev_mode)"
eq "dev mode explicit on 8.1" "dev" "$(CHIRP_DEV_PASSTHROUGH=dev CHIRP_PVE_VERSION=8.1 chirp_dev_mode)"
(CHIRP_DEV_PASSTHROUGH=dev CHIRP_PVE_VERSION=7.4 chirp_dev_mode >/dev/null 2>&1); eq "dev mode fails on 7.4 -> rc 1" "1" "$?"
(CHIRP_DEV_PASSTHROUGH=leagcy chirp_dev_mode >/dev/null 2>&1); eq "typo in mode -> rc 1" "1" "$?"

# 3. Block rendering
DEV_BLOCK="$(CHIRP_DEV_PASSTHROUGH=dev CHIRP_PVE_VERSION=8.1 chirp_render_block <<<"$SEL_ALL")"
EXPECTED_DEV_BLOCK='dev0: /dev/disk/by-id/wwn-0x5002538e40000001
dev1: /dev/disk/by-id/ata-WDC_WD40EFRX_WD-1234
dev2: /dev/disk/by-id/nvme-eui.0025385b21400001
lxc.mount.entry: /proc/meminfo host/proc/meminfo none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/stat host/proc/stat none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/loadavg host/proc/loadavg none bind,ro,optional,create=file 0 0
lxc.mount.entry: /sys host/sys none bind,ro,nosuid,nodev,noexec,optional,create=dir 0 0'
eq "dev block content" "$EXPECTED_DEV_BLOCK" "$DEV_BLOCK"
eq "no cgroup allow rules in dev block" "0" "$(grep -c 'lxc.cgroup2.devices.allow' <<<"$DEV_BLOCK")"
eq "no disk mount entries in dev block" "0" "$(grep -c 'lxc.mount.entry: /dev/disk' <<<"$DEV_BLOCK")"

# 4. Collision avoidance with user-defined devN (including [pve:pending])
COLLISION_CONF="$TMP/collision.conf"
cat >"$COLLISION_CONF" <<'EOF'
arch: amd64
dev0: /dev/dri/card0,gid=44
dev2: /dev/dri/renderD128,gid=104

[pve:pending]
dev3: /dev/ttyUSB0
EOF
eq "detected user dev indices including pending" $'0\n2\n3' "$(chirp_user_dev_indices "$COLLISION_CONF")"
AVOID_BLOCK="$(CHIRP_DEV_PASSTHROUGH=dev CHIRP_PVE_VERSION=8.1 chirp_render_block "$COLLISION_CONF" <<<"$SEL_ALL")"
eq "avoids dev0, dev2, dev3" "1" "$(grep -c '^dev1: /dev/disk/by-id/wwn-' <<<"$AVOID_BLOCK")"
eq "allocates dev4 next" "1" "$(grep -c '^dev4: /dev/disk/by-id/ata-' <<<"$AVOID_BLOCK")"
eq "allocates dev5 next" "1" "$(grep -c '^dev5: /dev/disk/by-id/nvme-' <<<"$AVOID_BLOCK")"

# 5. Migration from legacy wildcard config to devN
MIG_CONF="$TMP/mig.conf"
cat >"$MIG_CONF" <<'EOF'
arch: amd64
hostname: chirp
unprivileged: 0
lxc.cgroup2.devices.allow: b 8:* rw
lxc.cgroup2.devices.allow: b 259:* rw
lxc.cgroup2.devices.allow: c 10:200 rwm
dev0: /dev/dri/card0
dev10: /dev/disk/by-id/user-disk,gid=104
dev11: /dev/disk/by-id/user-disk-no-opts
lxc.mount.entry: /dev/disk/by-id/wwn-0x5002538e40000001 dev/disk/by-id/wwn-0x5002538e40000001 none bind,optional,create=file
lxc.mount.entry: /dev/disk/by-id/nvme-eui.0025385b21400001 dev/disk/by-id/nvme-eui.0025385b21400001 none bind,optional,create=file
lxc.mount.entry: /proc/meminfo host/proc/meminfo none bind,ro,optional,create=file 0 0

[snap1]
hostname: chirp
lxc.cgroup2.devices.allow: b 8:* rw
EOF
snap "$MIG_CONF" >"$TMP/mig.snap"
CHIRP_DEV_PASSTHROUGH=dev CHIRP_PVE_VERSION=8.1 chirp_render_block "$MIG_CONF" <<<"$SEL_ALL" >"$TMP/mig.block"
chirp_apply_conf "$MIG_CONF" "$TMP/mig.block"
eq "migration: old wildcard rules dropped (8 and 259)" "0" "$(awk '/^\[/{exit} /b (8|259):\*/' "$MIG_CONF" | wc -l | tr -d ' ')"
eq "migration: user cgroup kept (10:200)" "1" "$(grep -c 'c 10:200 rwm' "$MIG_CONF")"
eq "migration: user dev0 kept" "1" "$(grep -c '^dev0: /dev/dri/card0' "$MIG_CONF")"
eq "migration: user dev10 with opts kept" "1" "$(grep -c '^dev10: /dev/disk/by-id/user-disk,gid=104' "$MIG_CONF")"
eq "migration: user dev11 without opts kept" "1" "$(grep -c '^dev11: /dev/disk/by-id/user-disk-no-opts' "$MIG_CONF")"
eq "migration: old disk mounts dropped" "0" "$(grep -c '^lxc.mount.entry: /dev/disk' "$MIG_CONF")"
eq "migration: chirp dev entries added" "3" "$(main "$MIG_CONF" | grep -c '^dev[0-9]: /dev/disk/by-id/')"
eq "migration: dev1 allocated (dev0 user taken)" "1" "$(grep -c '^dev1: /dev/disk/by-id/wwn-' "$MIG_CONF")"
eq "migration: snapshot kept" "$(cat "$TMP/mig.snap")" "$(snap "$MIG_CONF")"
eq "migration: state file cleared of block majors" "" "$(cat "$MIG_CONF.chirp-majors" 2>/dev/null || true)"

# 6. Idempotent re-run in devN mode preserves user wildcard rule and user devN
(head -n 2 "$MIG_CONF" && echo "lxc.cgroup2.devices.allow: b 8:* rw" && tail -n +3 "$MIG_CONF") >"$TMP/mig.with_user_rule"
mv "$TMP/mig.with_user_rule" "$MIG_CONF"
cp "$MIG_CONF" "$TMP/mig.once"
CHIRP_DEV_PASSTHROUGH=dev CHIRP_PVE_VERSION=8.1 chirp_render_block "$MIG_CONF" <<<"$SEL_ALL" >"$TMP/mig.block2"
chirp_apply_conf "$MIG_CONF" "$TMP/mig.block2"
eq "dev mode does not delete user-added b 8:* rw rule" "1" "$(main "$MIG_CONF" | grep -c '^lxc.cgroup2.devices.allow: b 8:\* rw')"
eq "dev mode idempotent re-run" "$(cat "$TMP/mig.once")" "$(cat "$MIG_CONF")"

# 7. Unplugged disk in pure devN mode (even with user loop device b 7:* rwm) cleanly removed
GONE_DEV_CONF="$TMP/gone_dev.conf"
cat >"$GONE_DEV_CONF" <<'EOF'
arch: amd64
lxc.cgroup2.devices.allow: b 7:* rwm
dev0: /dev/disk/by-id/wwn-gone
EOF
: >"$TMP/gone_dev.block"
chirp_byid_major() { return 0; }
chirp_apply_conf "$GONE_DEV_CONF" "$TMP/gone_dev.block"; eq "unplugged disk in dev mode with user loop rule -> rc 0" "0" "$?"
eq "gone dev entry removed" "0" "$(grep -c 'wwn-gone' "$GONE_DEV_CONF")"
eq "user loop rule kept" "1" "$(grep -c 'b 7:\* rwm' "$GONE_DEV_CONF")"
chirp_byid_major() { case "$1" in wwn-*|ata-*) echo 8 ;; nvme-*) echo 259 ;; esac; }

# 8. Selection none removes devN entries
CHIRP_DEV_PASSTHROUGH=dev CHIRP_PVE_VERSION=8.1 chirp_render_block "$MIG_CONF" <<<"" >"$TMP/mig.none"
chirp_apply_conf "$MIG_CONF" "$TMP/mig.none"
eq "none: chirp dev entries removed" "0" "$(main "$MIG_CONF" | grep -c '^dev[0-9]: /dev/disk/by-id/(wwn|ata|nvme)')"
eq "none: user dev0 kept" "1" "$(grep -c '^dev0: /dev/dri/card0' "$MIG_CONF")"
eq "none: user dev10 kept" "1" "$(grep -c '^dev10: /dev/disk/by-id/user-disk' "$MIG_CONF")"
eq "none: host mounts kept" "4" "$(main "$MIG_CONF" | grep -c '^lxc.mount.entry: /[ps]')"

echo
echo "passed=${PASS} failed=${FAILS}"
[[ "$FAILS" -eq 0 ]]
