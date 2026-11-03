#!/usr/bin/env bash
#
# Proxmox 설치·업데이트 스크립트와 배포 파일이 깨지지 않았는지 검증한다.
#
# 로컬 실행 예:
#   scripts/ci/check-proxmox.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }

step "배포 파일 존재 확인"
for rel in \
  proxmox/ct/chirp.sh \
  proxmox/install/chirp-install.sh \
  proxmox/install/chirp.service \
  proxmox/install/update.sh \
  proxmox/install/chirp-passthrough.sh \
  scripts/ci/test-passthrough.sh; do
  [[ -f "$REPO_ROOT/$rel" ]] || fail "missing $rel"
done

step "Bash syntax: proxmox/**/*.sh"
SCRIPTS=()
while IFS= read -r f; do SCRIPTS+=("$f"); done < <(find "$REPO_ROOT/proxmox" -name '*.sh' -type f | sort)
[[ ${#SCRIPTS[@]} -gt 0 ]] || fail "proxmox/**/*.sh 가 없습니다"
for f in "${SCRIPTS[@]}"; do
  bash -n "$f" || fail "bash -n failed: $f"
  echo "ok ${f#"$REPO_ROOT"/}"
done

step "shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -S warning "${SCRIPTS[@]}" || fail "shellcheck 경고가 있습니다"
else
  echo "shellcheck 없음 — 건너뜁니다."
fi

step "update.sh: sha256 검증 / 헬스체크 / 롤백 구문"
UPD="$REPO_ROOT/proxmox/install/update.sh"
grep -q 'sha256sum' "$UPD" || fail "update.sh에 sha256sum 검증이 없습니다"
grep -q '\.sha256' "$UPD" || fail "update.sh가 .sha256 자산을 받지 않습니다"
grep -q '/health' "$UPD" || fail "update.sh에 /health 헬스체크가 없습니다"
grep -qi 'rolling back' "$UPD" || fail "update.sh에 롤백 구문이 없습니다"
grep -q 'mv -Tf' "$UPD" || fail "update.sh에 current 링크 원자적 교체(mv -Tf)가 없습니다"
grep -q -- '--force' "$UPD" || fail "update.sh에 --force 가 없습니다"
grep -q 'CHIRP_REF' "$UPD" || fail "update.sh에 CHIRP_REF 지원이 없습니다"
grep -q 'BASH_REMATCH' "$UPD" || fail "update.sh가 --force 재설치본(<ver>.r<epoch>)을 같은 버전으로 보지 않습니다"
grep -qE 'systemctl restart "\$SERVICE" \|\|' "$UPD" || fail "update.sh의 restart 실패가 롤백 없이 종료됩니다"
grep -q 'trap - EXIT' "$UPD" || fail "update.sh 자기 갱신 exec 전에 임시 디렉터리를 정리하지 않습니다"
echo "update.sh 구문 확인"

step "chirp-install.sh: chirp.env 템플릿 변수는 서버가 아는 이름이어야 한다"
INST="$REPO_ROOT/proxmox/install/chirp-install.sh"
CFG="$REPO_ROOT/apps/server/src/config.ts"
while IFS= read -r var; do
  grep -q "env\.${var}\b" "$CFG" || fail "chirp-install.sh 의 ${var} 는 config.ts 에 없습니다"
done < <(awk '/^  cat >\/etc\/chirp\/chirp.env/{f=1; next} f && /^EOF2$/{f=0} f' "$INST" \
  | grep -oE '^#? ?CHIRP_[A-Z_]+=' | sed -E 's/^#? ?//; s/=$//' | sort -u)
echo "env 템플릿 확인"

step "chirp.service 필수 항목"
SVC="$REPO_ROOT/proxmox/install/chirp.service"
for k in 'EnvironmentFile=/etc/chirp/chirp.env' 'Restart=on-failure' 'ProtectSystem=strict' \
  'ReadWritePaths=/var/lib/chirp' 'CAP_SYS_RAWIO' 'CAP_NET_BIND_SERVICE'; do
  grep -q "$k" "$SVC" || fail "chirp.service에 $k 가 없습니다"
done

step "스크립트가 참조하는 proxmox/ 경로가 저장소에 있는지"
for src in proxmox/install/chirp-install.sh proxmox/ct/chirp.sh proxmox/install/update.sh; do
  while IFS= read -r rel; do
    [[ -f "$REPO_ROOT/$rel" ]] || fail "$src references missing file: $rel"
  done < <(grep -oE 'proxmox/(ct|install)/[A-Za-z0-9_.-]+\.(sh|service)' "$REPO_ROOT/$src" | sort -u)
done
echo "참조 경로 확인"

step "passthrough 단위 테스트"
bash "$REPO_ROOT/scripts/ci/test-passthrough.sh"

echo
echo "Proxmox install/update 검증 완료."
