#!/usr/bin/env bash
# chirp 디스크 passthrough (Proxmox 호스트에서 실행).
#
# 한 줄 사용법 (디스크를 추가/교체한 뒤 호스트에서 다시 실행; 멱등):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/install/chirp-passthrough.sh)" _ <CTID>
#   비대화형: CHIRP_DISKS=all|none|<by-id,by-id,...> 를 앞에 붙인다.
#
# 하는 일: 호스트 디스크를 탐지 -> 체크리스트로 선택 -> /etc/pve/lxc/<CTID>.conf 의
#   `# chirp-passthrough:start` ... `:end` 블록을 (재)생성 -> 컨테이너 안 chirp.env 의
#   CHIRP_DEVICES 갱신 -> pct reboot -> 스모크 테스트(smartctl, /health).
#
# 주의 (README에도 옮길 것):
#  - privileged LXC 의 root 는 사실상 호스트 root 다. 신뢰할 수 있는 환경에서만 쓴다.
#  - 클러스터 HA 마이그레이션 대상 CT 에는 쓰지 말 것 (by-id 디스크는 해당 노드에만 있다).
#  - USB/HBA 뒤 디스크는 컨테이너의 /etc/chirp/chirp.env 에 CHIRP_DEVICE_TYPES 가 필요하다.
#  - cgroup 권한은 기본 rwm. 실측 후 rw 또는 r 로 축소 가능 (CHIRP_DEV_PERM 으로 덮어쓰기).
#
# 이 파일은 `source` 해도 안전하다 (함수만 정의; CHIRP_PASSTHROUGH_LIB=1 이면 main 을 실행하지 않는다).

CHIRP_MARK_START="# chirp-passthrough:start"
CHIRP_MARK_END="# chirp-passthrough:end"
CHIRP_DEV_PERM="${CHIRP_DEV_PERM:-rwm}"

_cp_msg()  { echo -e "\033[0;32m[+]\033[0m $*"; }
_cp_warn() { echo -e "\033[1;33m[!]\033[0m $*" >&2; }
_cp_err()  { echo -e "\033[0;31m[x]\033[0m $*" >&2; }

# lsblk -P 한 줄에서 KEY="value" 의 value 를 꺼낸다.
chirp_lsblk_field() {
  local line="$1" key="$2"
  if [[ "$line" =~ (^|[[:space:]])${key}=\"([^\"]*)\" ]]; then
    printf '%s' "${BASH_REMATCH[2]}"
  fi
}

# stdin: `lsblk -dn -P -o NAME,MAJ:MIN,TYPE,TRAN,MODEL,SERIAL,SIZE` 출력.
# stdout: TSV  name<TAB>maj:min<TAB>tran<TAB>model<TAB>serial<TAB>size  (물리 디스크만)
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

# stdin: "<by-id 이름> <대상 디바이스 이름>" 목록. $1: 디바이스 이름(sda, nvme0n1).
# 우선순위: wwn-* -> ata-*/nvme-eui.* -> nvme-<model>_<serial> -> scsi-* -> 그 외. -partN 제외.
# 같은 순위면 짧은 이름, 그다음 사전순.
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

# 호스트의 /dev/disk/by-id 를 "<이름> <대상>" 목록으로 출력한다.
chirp_byid_listing() {
  local l
  for l in /dev/disk/by-id/*; do
    [[ -L "$l" ]] || continue
    printf '%s %s\n' "$(basename "$l")" "$(basename "$(readlink -f "$l")")"
  done
}

# $1: lsblk 텍스트, $2: by-id 목록 텍스트.
# stdout: TSV  byid<TAB>maj:min<TAB>tran<TAB>model<TAB>serial<TAB>size
chirp_detect_disks() {
  local lsblk_text="$1" listing="$2" name majmin tran model serial size byid
  while IFS=$'\t' read -r name majmin tran model serial size; do
    [[ -n "$name" ]] || continue
    byid="$(chirp_pick_byid "$name" <<<"$listing")"
    if [[ -z "$byid" ]]; then
      _cp_warn "/dev/disk/by-id 이름이 없는 디스크는 건너뜁니다: ${name}"
      continue
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$byid" "$majmin" "$tran" "$model" "$serial" "$size"
  done < <(chirp_list_disks <<<"$lsblk_text")
}

# $1: CHIRP_DISKS 값(all|none|by-id 쉼표목록), $2: 탐지된 TSV.
# stdout: 선택된 행(TSV). 존재하지 않는 이름이 있으면 return 1.
chirp_resolve_selection() {
  local sel="$1" detected="$2" item rc=0 line items=()
  case "$sel" in
    all) printf '%s\n' "$detected" | sed '/^$/d'; return 0 ;;
    none|"") return 0 ;;
  esac
  # read -ra: 쉼표 분리 + 글롭 확장 없음 (항목에 * 가 있어도 현재 디렉터리와 매칭되지 않는다)
  IFS=, read -ra items <<<"$sel"
  for item in "${items[@]}"; do
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    item="${item#/dev/disk/by-id/}"
    [[ -n "$item" ]] || continue
    line="$(printf '%s\n' "$detected" | awk -F'\t' -v n="$item" '$1==n {print; exit}')"
    if [[ -z "$line" ]]; then
      _cp_err "탐지된 디스크에 없는 by-id 입니다: ${item}"
      rc=1
      continue
    fi
    printf '%s\n' "$line"
  done
  return $rc
}

# stdin: 선택된 TSV -> stdout: 중복 없는 major 번호.
chirp_majors() {
  awk -F'\t' 'NF && $2 ~ /^[0-9]+:/ {split($2,a,":"); print a[1]}' | sort -n -u
}

# stdin: 선택된 TSV -> stdout: 마커 블록 (선택이 비면 아무것도 출력하지 않는다).
chirp_render_block() {
  local tsv majors m byid
  tsv="$(cat)"
  [[ -n "$tsv" ]] || return 0
  majors="$(chirp_majors <<<"$tsv")"
  echo "$CHIRP_MARK_START"
  for m in $majors; do
    echo "lxc.cgroup2.devices.allow: b ${m}:* ${CHIRP_DEV_PERM}"
  done
  while IFS=$'\t' read -r byid _; do
    [[ -n "$byid" ]] || continue
    echo "lxc.mount.entry: /dev/disk/by-id/${byid} dev/disk/by-id/${byid} none bind,optional,create=file"
  done <<<"$tsv"
  echo "$CHIRP_MARK_END"
}

# $1: conf 파일, $2: 블록 파일(비어 있으면 기존 블록만 제거). 멱등.
# 스냅샷 섹션([name])이 있으면 그 앞(메인 섹션 끝)에 넣는다 — 뒤에 붙이면 스냅샷 설정이 되어버린다.
chirp_apply_conf() {
  local conf="$1" blockfile="$2" tmp
  if [[ ! -s "$conf" ]]; then
    _cp_err "${conf} 가 없거나 비어 있습니다."
    return 1
  fi
  if [[ ! -r "$blockfile" ]]; then
    _cp_err "블록 파일을 읽을 수 없습니다: ${blockfile}"
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
    _cp_err "${conf} 변환에 실패했습니다. 원본을 그대로 둡니다."
    rm -f "$tmp"
    return 1
  fi
  # 변환 결과가 비면(awk 이상 등) /etc/pve 의 CT 설정을 날리지 않도록 쓰지 않는다.
  if [[ ! -s "$tmp" ]]; then
    _cp_err "${conf} 변환 결과가 비어 있습니다. 원본을 그대로 둡니다."
    rm -f "$tmp"
    return 1
  fi
  if cmp -s "$tmp" "$conf"; then
    rm -f "$tmp"
    return 0
  fi
  # pmxcfs(/etc/pve)에서는 같은 디렉터리 rename 대신 덮어쓰기가 관례다 (파일 권한·소유 유지).
  if ! cat "$tmp" >"$conf"; then
    _cp_err "${conf} 쓰기에 실패했습니다."
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
}

# stdin: 선택된 TSV -> stdout: CHIRP_DEVICES 값 (쉼표 구분 전체 경로).
chirp_devices_value() {
  awk -F'\t' 'NF {printf "%s/dev/disk/by-id/%s", (n++ ? "," : ""), $1} END {if (n) print ""}'
}

# whiptail 체크리스트로 선택 (기본 전체 선택). $1: 탐지된 TSV. stdout: 쉼표 구분 by-id.
chirp_prompt_selection() {
  local detected="$1" args=() byid majmin tran model serial size out
  while IFS=$'\t' read -r byid majmin tran model serial size; do
    [[ -n "$byid" ]] || continue
    args+=("$byid" "${model:-?} ${size} ${tran:-}" ON)
  done <<<"$detected"
  if ! out="$(whiptail --title "chirp 디스크 선택" --separate-output \
      --checklist "컨테이너에 passthrough 할 디스크를 선택하세요 (스페이스로 토글)" 20 100 10 \
      "${args[@]}" 3>&1 1>&2 2>&3)"; then
    echo ""
    return 0
  fi
  printf '%s\n' "$out" | paste -sd, -
}

# 컨테이너 안 chirp.env 의 CHIRP_DEVICES 를 갱신한다. $1 CTID, $2 값.
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
  local ctid="$1" ip="" i
  for i in $(seq 1 45); do
    ip="$(chirp_ct_ip "$ctid" || true)"
    [[ -n "$ip" ]] && { echo "$ip"; return 0; }
    sleep 2
  done
  return 1
}

# 스모크 테스트 + 최종 안내. $1 CTID, $2 IP, stdin 아님: $3 선택된 TSV.
chirp_smoke_and_report() {
  local ctid="$1" ip="$2" tsv="$3" byid out rc status ok=0 total=0
  if [[ -n "$tsv" ]]; then
    printf '\n%-60s %s\n' "DISK (by-id)" "smartctl -j -i -n standby"
    while IFS=$'\t' read -r byid _; do
      [[ -n "$byid" ]] || continue
      total=$((total + 1))
      rc=0
      # -n standby: 스모크 테스트도 잠든 디스크를 깨우지 않는다.
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
    echo "smartctl 성공 ${ok}/${total} (실패 시 USB/HBA 디스크는 CHIRP_DEVICE_TYPES 필요)"
  fi

  local health="FAIL"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 3 "http://${ip}/health" >/dev/null 2>&1; then health="OK"; break; fi
    sleep 2
  done
  echo "GET http://${ip}/health : ${health}"

  local key
  key="$(pct exec "$ctid" -- node /opt/chirp/current/apps/server/dist/cli.js key show 2>/dev/null \
    || pct exec "$ctid" -- cat /var/lib/chirp/api-key 2>/dev/null || echo '(조회 실패: pct exec '"$ctid"' -- node /opt/chirp/current/apps/server/dist/cli.js key show)')"
  echo
  echo "=============================================="
  echo " 대시보드 : http://${ip}/"
  echo " API 키   : ${key}"
  echo
  echo " Home Assistant 설정:"
  echo "   HACS 사용자 지정 저장소 : eigger/hass-chirp"
  echo "   통합 도메인            : chirp"
  echo "   호스트 ${ip} / 포트 80 / API 키 (위 값)"
  echo
  echo " 디스크를 추가/교체한 뒤 호스트에서 다시 실행:"
  echo "   bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/install/chirp-passthrough.sh)\" _ ${ctid}"
  echo " 컨테이너 업데이트: pct exec ${ctid} -- update"
  echo "=============================================="
}

chirp_passthrough_run() {
  local ctid="${1:-}" conf detected selection="" sel_tsv listing lsblk_text blockfile ip devices
  if [[ -z "$ctid" || ! "$ctid" =~ ^[0-9]+$ ]]; then
    _cp_err "사용법: chirp-passthrough.sh <CTID>"
    return 1
  fi
  if ! command -v pveversion >/dev/null 2>&1; then
    _cp_err "Proxmox VE 호스트에서 실행해야 합니다."
    return 1
  fi
  conf="/etc/pve/lxc/${ctid}.conf"
  if [[ ! -f "$conf" ]]; then
    _cp_err "${conf} 가 없습니다."
    return 1
  fi
  if grep -q '^unprivileged: 1' "$conf"; then
    _cp_err "CT ${ctid} 는 unprivileged 입니다. 디스크 passthrough 는 privileged CT 가 필요합니다 (var_unprivileged=0)."
    return 1
  fi
  if command -v ha-manager >/dev/null 2>&1 && ha-manager status 2>/dev/null | grep -q "ct:${ctid}\b"; then
    _cp_warn "CT ${ctid} 는 HA 로 관리되고 있습니다. 디스크가 노드에 묶이므로 마이그레이션이 실패합니다."
  fi

  lsblk_text="$(lsblk -dn -P -o NAME,MAJ:MIN,TYPE,TRAN,MODEL,SERIAL,SIZE)"
  listing="$(chirp_byid_listing)"
  detected="$(chirp_detect_disks "$lsblk_text" "$listing")"
  if [[ -z "$detected" && "${CHIRP_DISKS:-}" != "none" ]]; then
    _cp_warn "passthrough 할 수 있는 디스크를 찾지 못했습니다."
  fi

  if [[ -n "${CHIRP_DISKS:-}" ]]; then
    selection="$CHIRP_DISKS"
  elif [[ -z "$detected" ]]; then
    selection="none"
  elif command -v whiptail >/dev/null 2>&1 && [[ -t 0 && -t 1 ]]; then
    selection="$(chirp_prompt_selection "$detected")"
    [[ -n "$selection" ]] || selection="none"
  else
    _cp_msg "대화형 터미널이 없어 탐지된 모든 디스크를 선택합니다. (CHIRP_DISKS 로 지정 가능)"
    selection="all"
  fi

  sel_tsv="$(chirp_resolve_selection "$selection" "$detected")" || return 1

  blockfile="$(mktemp)"
  chirp_render_block <<<"$sel_tsv" >"$blockfile"
  if ! chirp_apply_conf "$conf" "$blockfile"; then
    rm -f "$blockfile"
    return 1
  fi
  rm -f "$blockfile"
  if [[ -n "$sel_tsv" ]]; then
    _cp_msg "${conf} 에 passthrough 블록을 적용했습니다:"
    sed -n "/^${CHIRP_MARK_START}\$/,/^${CHIRP_MARK_END}\$/p" "$conf"
  else
    _cp_msg "선택된 디스크가 없어 passthrough 블록을 제거했습니다."
  fi

  devices="$(chirp_devices_value <<<"$sel_tsv")"
  if [[ "$(pct status "$ctid" | awk '{print $2}')" != "running" ]]; then
    if ! pct start "$ctid"; then
      _cp_err "CT ${ctid} 를 시작하지 못했습니다."
      return 1
    fi
    sleep 3
  fi
  if ! chirp_update_ct_env "$ctid" "$devices"; then
    _cp_err "CT ${ctid} 의 /etc/chirp/chirp.env 갱신에 실패했습니다."
    return 1
  fi

  _cp_msg "CT ${ctid} 재부팅 중..."
  if ! pct reboot "$ctid"; then
    _cp_err "CT ${ctid} 재부팅에 실패했습니다."
    return 1
  fi
  sleep 3
  if ! ip="$(chirp_wait_network "$ctid")"; then
    _cp_err "재부팅 후 네트워크가 올라오지 않았습니다."
    return 1
  fi
  chirp_smoke_and_report "$ctid" "$ip" "$sel_tsv"
}

if [[ "${CHIRP_PASSTHROUGH_LIB:-}" != "1" ]] \
  && { [[ -z "${BASH_SOURCE[0]:-}" ]] || [[ "${BASH_SOURCE[0]}" == "$0" ]]; }; then
  set -uo pipefail
  chirp_passthrough_run "${1:-}"
fi
