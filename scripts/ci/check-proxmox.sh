#!/usr/bin/env bash
#
# Verify that the Proxmox install/update scripts and deploy files are intact.
#
# Run locally:
#   scripts/ci/check-proxmox.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }

step "Deploy files exist"
for rel in \
  proxmox/ct/chirp.sh \
  proxmox/host/chirp-collector.py \
  proxmox/host/chirp-collector.service \
  proxmox/install/chirp-install.sh \
  proxmox/install/chirp.service \
  proxmox/install/update.sh \
  proxmox/install/chirp-passthrough.sh \
  scripts/ci/test-collector.py \
  scripts/ci/test-passthrough.sh \
  scripts/ci/test-update.sh; do
  [[ -f "$REPO_ROOT/$rel" ]] || fail "missing $rel"
done

step "Bash syntax: proxmox/**/*.sh"
SCRIPTS=()
while IFS= read -r f; do SCRIPTS+=("$f"); done < <(find "$REPO_ROOT/proxmox" -name '*.sh' -type f | sort)
[[ ${#SCRIPTS[@]} -gt 0 ]] || fail "no proxmox/**/*.sh found"
for f in "${SCRIPTS[@]}"; do
  bash -n "$f" || fail "bash -n failed: $f"
  echo "ok ${f#"$REPO_ROOT"/}"
done

step "shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -S warning "${SCRIPTS[@]}" "$REPO_ROOT"/scripts/ci/*.sh || fail "shellcheck reported warnings"
else
  echo "shellcheck not installed; skipping."
fi

step "Python collector syntax and unit tests"
python3 -m py_compile "$REPO_ROOT/proxmox/host/chirp-collector.py" || fail "python syntax error in chirp-collector.py"
python3 "$REPO_ROOT/scripts/ci/test-collector.py" || fail "python collector unit tests failed"
echo "collector python tests passed"

step "update.sh: sha256 check / health check / rollback"
UPD="$REPO_ROOT/proxmox/install/update.sh"
grep -q 'sha256sum' "$UPD" || fail "update.sh does not verify sha256sum"
grep -q '\.sha256' "$UPD" || fail "update.sh does not fetch the .sha256 asset"
grep -q '/health' "$UPD" || fail "update.sh has no /health check"
grep -qi 'rolling back' "$UPD" || fail "update.sh has no rollback"
grep -q 'mv -Tf' "$UPD" || fail "update.sh does not swap the current link atomically (mv -Tf)"
grep -q -- '--force' "$UPD" || fail "update.sh has no --force"
grep -q 'CHIRP_REF' "$UPD" || fail "update.sh does not support CHIRP_REF"
grep -q 'BASH_REMATCH' "$UPD" || fail "update.sh does not treat a --force reinstall (<ver>.r<epoch>) as the same version"
grep -qE 'systemctl restart "\$SERVICE" \|\|' "$UPD" || fail "a failed restart in update.sh exits without rollback"
grep -q 'trap - EXIT' "$UPD" || fail "update.sh does not clean its temp dir before the self-update exec"
grep -q 'health_host' "$UPD" || fail "update.sh probes /health without honouring CHIRP_HOST"
grep -q 'rm -f "$CURRENT_LINK"' "$UPD" || fail "update.sh can leave a dangling current link after a failed first install"
echo "update.sh checks passed"

step "ct/chirp.sh: community-scripts engine bootstrap"
CT="$REPO_ROOT/proxmox/ct/chirp.sh"
grep -q 'misc/build.func' "$CT" && fail "ct/chirp.sh uses the removed ProxmoxVE misc/build.func (the engine moved to community-scripts/core)"
grep -q 'community-scripts/core' "$CT" || fail "ct/chirp.sh does not load the engine from community-scripts/core"
grep -q 'COMMUNITY_SCRIPTS_URL' "$CT" || fail "ct/chirp.sh does not point COMMUNITY_SCRIPTS_URL at this repository (install/chirp-install.sh would be looked up upstream)"
grep -q '|| \[\[ -z "\$_chirp_build_func" \]\]' "$CT" || fail "ct/chirp.sh does not stop when the engine download fails"
grep -q 'CTID:-' "$CT" || fail "ct/chirp.sh does not guard against an empty CTID before the passthrough step"

step "chirp-install.sh: chirp.env template variables must be known to the server"
INST="$REPO_ROOT/proxmox/install/chirp-install.sh"
CFG="$REPO_ROOT/apps/server/src/config.ts"
while IFS= read -r var; do
  grep -q "env\.${var}\b" "$CFG" || fail "${var} in chirp-install.sh is not read by config.ts"
done < <(awk '/^  cat >\/etc\/chirp\/chirp.env/{f=1; next} f && /^EOF2$/{f=0} f' "$INST" \
  | grep -oE '^#? ?CHIRP_[A-Z_]+=' | sed -E 's/^#? ?//; s/=$//' | sort -u)
echo "env template checks passed"

step "chirp.service required settings"
SVC="$REPO_ROOT/proxmox/install/chirp.service"
for k in 'EnvironmentFile=/etc/chirp/chirp.env' 'Restart=on-failure' 'ProtectSystem=strict' \
  'ReadWritePaths=/var/lib/chirp' 'CAP_SYS_RAWIO' 'CAP_NET_BIND_SERVICE'; do
  grep -q "$k" "$SVC" || fail "chirp.service lacks $k"
done

step "chirp-passthrough.sh: least-privilege device rules"
PT="$REPO_ROOT/proxmox/install/chirp-passthrough.sh"
grep -q 'CHIRP_DEV_PERM="${CHIRP_DEV_PERM:-rw}"' "$PT" || fail "chirp-passthrough.sh default device permission is not rw"

step "chirp-passthrough.sh: host metric mounts"
grep -q 'CHIRP_HOST_MOUNTS="${CHIRP_HOST_MOUNTS:-all}"' "$PT" || fail "host metric mounts are not on by default"
grep -q 'none bind,ro,optional,create=file' "$PT" || fail "host /proc mounts are not read-only + optional"
grep -q 'host/sys none bind,ro,nosuid,nodev,noexec,optional,create=dir' "$PT" || fail "the host /sys mount is not ro,nosuid,nodev,noexec + optional"
grep -q 'proc) echo proc' "$PT" || fail "CHIRP_HOST_MOUNTS=proc (no host sysfs) is missing"
grep -q 'AppArmor' "$PT" || fail "chirp-passthrough.sh does not document the /host/sys AppArmor exposure"
for doc in docs/deploy.md docs/ko/deploy.md README.md README.ko.md; do
  grep -q 'CHIRP_HOST_MOUNTS=proc' "$REPO_ROOT/$doc" || fail "$doc does not document CHIRP_HOST_MOUNTS=proc"
done
grep -q 'chirp_check_host_mounts' "$PT" || fail "the smoke test does not verify the host metric mounts"
# Proxmox moves `#` lines of a CT config into the description (top of file): never rely on markers.
grep -q 'chirp-passthrough:start' "$PT" && fail "chirp-passthrough.sh still writes/uses marker comments"
grep -q 'CHIRP_CONF_AWK' "$PT" || fail "chirp_apply_conf does not recognise its lines by content"
grep -q '"/host/proc"' "$CFG" || fail "config.ts does not default to /host/proc"
grep -q '"/host/sys"' "$CFG" || fail "config.ts does not default to /host/sys"
step "Admin account / API key hand-off"
grep -q 'create the admin account' "$INST" || fail "chirp-install.sh does not tell the user to create the admin account"
grep -q 'create the admin account' "$REPO_ROOT/proxmox/ct/chirp.sh" || fail "ct/chirp.sh does not tell the user to create the admin account"
grep -q '/api/v1/bootstrap/status' "$PT" || fail "chirp-passthrough.sh does not check whether the admin account exists"
grep -q 'Settings -> API key' "$PT" || fail "chirp-passthrough.sh does not point Home Assistant users at Settings -> API key"
grep -qE 'key show|cat /var/lib/chirp/api-key' "$PT" && fail "chirp-passthrough.sh still prints the API key (it belongs in the dashboard)"
grep -qE 'admin\.json|api-key|/var/lib/chirp' "$UPD" && fail "update.sh must not touch the data directory (admin.json, api-key, ...)"
echo "admin / key hand-off checks passed"

step "proxmox/ paths referenced by the scripts exist in the repository"
for src in proxmox/install/chirp-install.sh proxmox/ct/chirp.sh proxmox/install/update.sh; do
  while IFS= read -r rel; do
    [[ -f "$REPO_ROOT/$rel" ]] || fail "$src references missing file: $rel"
  done < <(grep -oE 'proxmox/(ct|install)/[A-Za-z0-9_.-]+\.(sh|service)' "$REPO_ROOT/$src" | sort -u)
done
echo "referenced paths exist"

step "passthrough unit tests"
bash "$REPO_ROOT/scripts/ci/test-passthrough.sh"

step "update.sh scenario tests"
bash "$REPO_ROOT/scripts/ci/test-update.sh"

echo
echo "Proxmox install/update checks passed."
