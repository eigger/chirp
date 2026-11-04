# chirp 배포 가이드

[English](../deploy.md)

## 요구 사항

- Linux 호스트(Proxmox VE 권장), Node.js 24, `smartmontools`
- 포트 80 (변경: `CHIRP_PORT`, 1~65535 정수)
- 호스트의 블록 장치·`/sys` 접근 권한(메모리·부하용으로 호스트의 `/proc` 파일도; 아래 참고)

## 1. Proxmox 원클릭

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
```

privileged LXC를 만들고 릴리스 tarball을 설치한 뒤, 선택한 디스크를 passthrough하고 대시보드 URL을 출력한다. 스크립트 상세는 `proxmox/` 참고.

**설치 직후 `http://<컨테이너 IP>/`를 열어 관리자 계정을 만든다**(사용자명, 비밀번호 2회 입력 및 설치 시 출력된 일회용 `Setup token` 입력). 설치 스크립트는 `/etc/chirp/chirp.env`(`0600`)에 `CHIRP_SETUP_TOKEN`을 작성한다. 계정 생성 시 서버는 env 파일에서 토큰을 최선형(best-effort)으로 삭제하려고 시도한다. systemd 샌드박스(`ProtectSystem=strict`)에서는 `/etc/chirp`가 읽기 전용이므로 토큰이 `chirp.env`에 남을 수 있으나, 관리자 계정이 존재하는 즉시 최초 등록이 영구적으로 비활성화(`POST /bootstrap/admin`이 `409 conflict` 반환)되므로 무해하다. 설치 중 화면 스크롤로 토큰을 놓친 경우: `pct exec <CTID> -- grep -E '^CHIRP_SETUP_TOKEN=' /etc/chirp/chirp.env`. `CHIRP_SETUP_TOKEN`이 설정되지 않은 경우(Docker, 수동 설치)에는 누구에게나 등록 창이 열려 있으므로 즉시 계정을 생성해야 한다. 그다음 **설정 -> API 키**에서 키를 복사해 Home Assistant에 넣는다. 비밀번호를 잊으면 `pct exec <CTID> -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password`(새 무작위 비밀번호를 출력하고 모든 세션을 로그아웃).

### 디스크 passthrough와 권한

`proxmox/install/chirp-passthrough.sh`(호스트에서 실행, 디스크를 추가/교체한 뒤 다시 실행)는 선택한 디스크의 `/dev/disk/by-id/...` 노드를 컨테이너에 bind mount하고, 장치 major마다 cgroup 규칙을 하나씩 추가한다.

```
lxc.cgroup2.devices.allow: b 8:* rw
lxc.mount.entry: /dev/disk/by-id/wwn-0x5000c500a1b2c3d4 dev/disk/by-id/wwn-0x5000c500a1b2c3d4 none bind,optional,create=file
```

- **`rwm`이 아니라 `rw`.** 디스크는 bind mount되므로 컨테이너가 `mknod`를 할 필요가 없다. smartctl은 SG_IO를 위해 SCSI/SAT 장치를 읽기·쓰기로 열기 때문에 `r`만으로는 부족하다. `CHIRP_DEV_PERM`으로 덮어쓸 수 있다(예: `CHIRP_DEV_PERM=rwm`).
- **정확한 `major:minor`가 아니라 major 와일드카드(`8:*`).** `sd`의 minor는 장치 인식 순서를 따르고 NVMe 네임스페이스(major 259)의 minor는 동적으로 배정되므로, 정확한 minor 규칙은 호스트 재부팅이나 핫플러그 후 엉뚱한 디스크를 가리키거나 아무것도 가리키지 않게 된다. by-id bind mount는 컨테이너가 시작할 때마다 다시 해석되지만 정적 cgroup 규칙은 그렇지 않고, Proxmox에는 컨테이너 시작 전에 이 규칙을 다시 쓸 수 있는 훅이 없다.
- **줄 관리 방식.** 스크립트는 자기 줄을 내용으로 알아본다. 위 형식 그대로의 by-id 마운트와 호스트 메트릭 마운트, 그리고 추가하거나 제거하는 디스크 major의 `lxc.cgroup2.devices.allow: b <major>:* <perm>`이다. 실행할 때마다 main 섹션 어디에 있든 이 줄들을 지우고, 새 집합을 첫 `[snapshot]` / `[pve:pending]` 섹션 앞에 한 번만 쓴다. 스냅샷 섹션, 사용자 자신의 `lxc.*` 줄과 나머지는 그대로 두며, 바뀌는 것이 없으면 파일을 다시 쓰지 않는다. 이전 버전은 이 줄들을 `# chirp-passthrough:start` / `:end` 주석으로 감쌌는데, Proxmox는 모든 `#` 줄을 컨테이너 설명(description)으로 취급해 설정을 다시 쓸 때마다 파일 맨 위로 옮긴다(`:`는 `%3A`로 인코딩). 그래서 마커는 믿을 수 없으므로 더 이상 쓰지 않고, 남아 있는 마커는 지운다. chirp가 관리하는 major에 대해 chirp와 똑같은 형식으로 쓴 사용자 규칙(예: `b 8:* rw`)은 chirp의 것으로 취급된다. 관리하는 major는 호스트의 `/var/lib/chirp-passthrough/<CTID>.majors`에 기록하므로 디스크가 제거된 뒤에도 규칙을 정리할 수 있다. 설치를 이동하거나 복원할 때는 CT 설정과 이 파일을 함께 보관한다. 소유 기록이 없는 구버전 설정에서 기존 디스크까지 사라졌다면 설정 변경을 거부한다. 해당 디스크의 오래된 cgroup 규칙과 마운트를 수동으로 제거한 뒤 다시 실행한다. Proxmox 스냅샷을 롤백한 뒤 디스크가 없고 기록 밖의 major 와일드카드 규칙이 함께 발견되어도 변경 없이 실패한다. 복원된 CT 설정과 해당 규칙을 정리한 뒤 다시 실행한다. CRLF 줄 끝 파일은 변경하지 않고 거부한다.
- **위험:** 컨테이너 root는 같은 major의 다른 블록 장치(호스트 부트 디스크도 `sd*`/NVMe라면 포함)에 접근할 수 있다. privileged 컨테이너의 root는 이미 사실상 호스트 root이므로 위험이 더 커지지는 않지만, 신뢰하는 네트워크에 두고 다른 서비스를 함께 돌리지 말 것.

### 호스트 메트릭(메모리·부하·네트워크)

컨테이너 안의 `/proc/meminfo`, `/proc/stat`, `/proc/loadavg`는 lxcfs가 보여 주는 컨테이너 관점 값일 수 있고(예: 호스트 64GB 대신 512MB), 네트워크 네임스페이스에는 컨테이너의 `eth0`만 있다. 그래서 같은 스크립트가 컨테이너 설정에 호스트 파일의 읽기 전용 마운트도 쓴다. `CHIRP_HOST_MOUNTS`로 고른다.

| `CHIRP_HOST_MOUNTS` | 마운트 | 결과 |
|---|---|---|
| `all` (기본) | `/proc/meminfo`, `/proc/stat`, `/proc/loadavg` -> `/host/proc`; `/sys` -> `/host/sys` | 메모리·부하·네트워크 모두 `scope: "host"` |
| `proc` | `/proc` 파일 3개만 | 메모리·부하는 `host`, 네트워크는 컨테이너 자신의 인터페이스(`scope: "container"`) |
| `0` | 없음 | 메모리·부하·네트워크 모두 `scope: "container"` |

```
lxc.mount.entry: /proc/meminfo host/proc/meminfo none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/stat host/proc/stat none bind,ro,optional,create=file 0 0
lxc.mount.entry: /proc/loadavg host/proc/loadavg none bind,ro,optional,create=file 0 0
lxc.mount.entry: /sys host/sys none bind,ro,nosuid,nodev,noexec,optional,create=dir 0 0
```

기존 설치에 마운트를 추가하거나 모드를 바꾸려면 스크립트를 다시 실행한다(예: `CHIRP_HOST_MOUNTS=proc CHIRP_DISKS=<현재 디스크> bash -c "$(curl ...)" _ <CTID>`). chirp의 줄은 교체될 뿐 중복되지 않는다. **재실행 시 디스크 선택은 기존 선택을 대체한다.** 체크리스트에서는 유지할 디스크를 모두 고르고, 비대화식으로는 이전과 같은 `CHIRP_DISKS`를 준다(터미널 없이 실행하면 기본값이 `all`이고, `none`은 passthrough된 디스크를 모두 제거한다).

chirp은 `/host/proc`, `/host/sys`를 먼저 읽고 `scope: "host"`로 보고한다. 없으면 컨테이너 자신의 파일로 대체하고 `scope: "container"`로 보고하며, 대시보드에는 "컨테이너 관점"(툴팁: 호스트가 아닌 컨테이너 값)이 표시된다. `optional`이므로 마운트가 실패해도 컨테이너는 정상 시작한다. `/proc/net`은 읽는 프로세스의 네트워크 네임스페이스를 따르므로 `/proc/net/dev`는 일부러 마운트하지 않는다.

**`all`이 노출하는 것.** 호스트 sysfs 전체가 `/host/sys`에서 읽힌다. 읽기 전용·`nosuid,nodev,noexec`·비재귀(cgroup, debugfs 등 하위 마운트 제외)로 마운트하지만, 컨테이너의 AppArmor 프로필은 `/sys/**` 쓰기를 *경로 기준*으로 막기 때문에 `/host/sys`는 막지 못한다. 따라서 다시 마운트할 수 있는 컨테이너 root 프로세스는 이를 쓰기 가능하게 만들어 호스트 네트워크 설정(MTU, 브리지·본딩 파라미터)을 바꿀 수 있다. privileged 컨테이너의 root는 이미 passthrough된 디스크에 원시 읽기·쓰기 권한이 있고 사실상 호스트 root이므로 새 권한은 아니지만, 호스트 sysfs를 컨테이너에 두고 싶지 않다면 `CHIRP_HOST_MOUNTS=proc`을 쓴다. `/sys/class/net`만으로 좁힐 수는 없다. 그 항목들은 `/sys/devices/...`를 가리키는 심볼릭 링크이고, `/sys/devices`를 마운트하면 어차피 sysfs 대부분이 노출된다.

**이 마운트는 모든 Proxmox/LXC/AppArmor 조합에서 검증되지 않았다.** 설치 스크립트의 스모크 테스트가 MemTotal을 비교하고 호스트에만 있는 인터페이스(예: `vmbr0`)가 보이는지 확인한다. 직접 확인하려면:

```bash
# Proxmox 호스트에서
grep -E 'MemTotal|MemAvailable' /proc/meminfo; free -b; ls /sys/class/net
# 컨테이너 안에서
pct exec <CTID> -- grep -E 'MemTotal|MemAvailable' /proc/meminfo /host/proc/meminfo
pct exec <CTID> -- ls /host/sys/class/net
# chirp 보고값 (scope가 "host"여야 한다)
curl -s -H "Authorization: Bearer $KEY" http://<ip>/api/v1/status | jq '{m: .memory.scope, l: .load.scope, n: .network.scope, total: .memory.totalBytes}'
```

`/host/proc/meminfo`의 `MemTotal`이 호스트 값(호스트 `free -b`의 total)과 같아야 하고, `/host/sys/class/net`에 호스트 인터페이스(`vmbr0`, `eno1` 등)가 보여야 한다. 컨테이너 값이 보인다면 API가 `scope: "container"`로 보고한다. Proxmox 버전과 함께 이슈를 남겨 주세요.

**ZFS 호스트.** ZFS ARC는 `MemAvailable`에 포함되지 않으므로 `memory.usedPercent`에 ARC가 포함되어 늘 높게 보일 수 있다(Proxmox GUI의 메모리 표시도 같은 기준). 회수 가능한 ARC(`/proc/spl/kstat/zfs/arcstats`)를 빼는 것은 향후 개선 후보다.

## 2. Docker

```bash
docker run -d --name chirp \
  --privileged -p 80:80 \
  -v /sys:/host/sys:ro -e CHIRP_SYSFS_ROOT=/host/sys \
  -v /proc/meminfo:/host/proc/meminfo:ro -v /proc/stat:/host/proc/stat:ro \
  -v /proc/loadavg:/host/proc/loadavg:ro \
  -v chirp-data:/var/lib/chirp \
  --device /dev/sda --device /dev/nvme0 \
  -e CHIRP_DEVICES=/dev/sda,/dev/nvme0 \
  ghcr.io/eigger/chirp:latest
```

- **관리자 계정:** 처음 시작한 직후 `http://<호스트>/`를 열어 만든다(그 전까지는 포트에 접근할 수 있는 누구나 만들 수 있다). 자동화 환경이면 `-e CHIRP_ADMIN_USER=admin -e CHIRP_ADMIN_PASSWORD=<10자 이상>`을 추가한다. 관리자가 없을 때만 시작 시 계정을 만들며, 이후에는 무시되어 바꾼 비밀번호를 덮어쓰지 않는다. 재설정: `docker exec chirp node apps/server/dist/cli.js admin reset-password`.
- **`CHIRP_ADMIN_PASSWORD`는 계정이 생긴 뒤에도** `docker inspect`와 compose 파일에 그대로 보인다. 첫 기동 후 두 변수를 지우고 대시보드에서 비밀번호를 바꾼다.
- `--privileged` 대신 `--cap-add SYS_RAWIO --cap-add SYS_ADMIN` + `--device` 조합 가능.
- **읽기 전용 호스트 sysfs 마운트 하나(`-v /sys:/host/sys:ro` + `CHIRP_SYSFS_ROOT=/host/sys`)**로 sysfs에서 오는 것을 모두 처리한다. CPU 센서(hwmon), RAPL 전력, 디스크를 깨우지 않는 안정적인 디스크 ID, 그리고 호스트 네트워크 인터페이스(`scope: "host"`)다. 호스트 sysfs를 bind mount하면 호스트의 네트워크 네임스페이스가 유지되므로 `/host/sys/class/net`에 `vmbr0`, `eno1` 등이 보인다. 주의: 호스트 sysfs 전체가 privileged 컨테이너에 보인다. 읽기 전용이지만 privileged 컨테이너는 다시 마운트할 수 있다. 비재귀인 LXC 마운트와 달리 Docker의 `-v`는 **재귀** bind다. `/sys` 아래 호스트의 하위 마운트(cgroup, debugfs, securityfs, efivarfs 등)도 함께 들어오고, `:ro`는 Docker 25+와 커널 5.12+에서만 재귀적으로 적용된다(그 이전에는 하위 마운트가 쓰기 가능하게 남을 수 있다). Docker 25+라면 LXC 마운트와 같은 비재귀 형식을 권장한다.
  `--mount type=bind,src=/sys,dst=/host/sys,readonly,bind-recursive=disabled`
  (예시의 `-v` 형식은 모든 Docker 버전에서 동작한다.)
- **다른 sysfs 구성:**
  - 대신 `-v /sys:/sys:ro`(이전 예시): 센서와 디스크 ID는 동작하고 `/sys/class/net`에도 호스트 인터페이스가 보이지만, chirp은 이를 컨테이너 자신의 `/sys`와 구분할 수 없어 네트워크 섹션을 `scope: "container"`로 보고한다. 호스트 라벨을 얻으려면 `/host/sys`를 쓴다.
  - `--network host`: 컨테이너 자신의 `/sys/class/net`이 호스트 네임스페이스다. 역시 `/host/sys`가 없으면 호스트 데이터가 `scope: "container"`로 보고된다.
  - 호스트 sysfs 없이 기본 브리지 네트워크: 컨테이너의 `eth0`만 보인다(`scope: "container"`). CPU 센서와 RAPL은 컨테이너 자신의 `/sys`로도 동작한다(네트워크 네임스페이스를 따르는 것은 `/sys/class/net`뿐이다. 비 privileged 컨테이너는 `/sys/class/powercap`이 가려져 있을 수 있다).
- `/proc` 파일 3개 마운트로 호스트의 메모리·부하를 `scope: "host"`로 보고한다. 필요한 것은 이 파일들뿐이다. `/proc` 전체를 `/host/proc`에 마운트해도 동작한다(호스트 sysfs가 없으면 네트워크 카운터를 PID 1의 `/host/proc/1/net/dev`에서 읽을 수 있다). 없으면 메모리·부하는 `scope: "container"`(Docker는 `/proc/meminfo`를 가상화하지 않으므로 값 자체는 대개 호스트와 같다).
- `chirp-data` 볼륨에 API 키(`api-key`), 관리자 계정(`admin.json`), `instance-id`, `disk-ids.json`(고정된 디스크 ID)이 저장된다. 볼륨을 잃으면 키·인스턴스 ID가 바뀌어 Home Assistant 엔티티가 새로 생기고, 관리자도 다시 등록해야 한다.
- **API 키:** 로그인 후 **설정 -> API 키**에서 보기·복사·재발급한다. 컨테이너 로그에는 출력되지 않는다. 호스트에서는 `docker exec chirp node apps/server/dist/cli.js key show`로도 확인할 수 있다(로그에 꼭 남기고 싶다면 한 번만 `-e CHIRP_PRINT_KEY=true`로 시작).
- 장치 이름이 달라질 수 있는 환경이면 `CHIRP_DEVICES`에 `/dev/disk/by-id/...` 경로를 쓴다. RAID 컨트롤러/USB 브리지는 `CHIRP_DEVICE_TYPES=/dev/sda=sat`. 종류를 지정하지 않았는데 smartctl이 `Unable to detect device type`을 내면(LXC에 bind mount된 by-id 장치에서 흔함) chirp가 `-d sat`, 이어서 `-d scsi`로 재시도하고 성공한 종류를 기억한다. 감지 과정을 건너뛰려면 `CHIRP_DEVICE_TYPES`를 지정한다.
- 이미지의 `HEALTHCHECK`는 `CHIRP_HOST`/`CHIRP_PORT`가 실제로 바인드하는 주소를 확인한다(`0.0.0.0`/`::`이면 루프백).

## 3. 릴리스 tarball

릴리스에는 `chirp-<version>.tar.gz`와 `.sha256`이 올라간다.

```bash
sha256sum -c chirp-<version>.tar.gz.sha256
mkdir -p /opt/chirp && tar -xzf chirp-<version>.tar.gz -C /opt/chirp
cd /opt/chirp && node apps/server/dist/index.js
```

tarball 구조(`scripts/package-release.sh`가 생성): `package.json`, `node_modules`(prod), 중첩된 워크스페이스 `node_modules`(`apps/*/node_modules`, `packages/*/node_modules`), `packages/shared/{package.json,dist}`, `apps/server/{package.json,dist}`, `apps/web/dist`. 순수 JS이므로 네이티브 빌드가 필요 없다. CI는 모든 tarball을 체크아웃 밖에 풀어 실제로 기동해 보므로(`scripts/ci/smoke-release.sh`) 의존성이 빠지면 릴리스가 실패한다.

**sha256 검증은 무결성만 보장한다.** `.sha256` 파일은 tarball과 같은 GitHub 릴리스에서 오므로 손상·잘린 다운로드는 잡지만 변조된 릴리스는 잡지 못한다. 진위는 HTTPS와 GitHub 계정에 의존하며 릴리스 서명은 없다.

systemd 예시:

```ini
[Service]
EnvironmentFile=-/etc/chirp/chirp.env
WorkingDirectory=/opt/chirp
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=on-failure
```

## Proxmox 컨테이너 업데이트

컨테이너 안에서 `update`를 실행한다(`pct exec <CTID> -- update`). 릴리스를 내려받아 sha256을 확인하고 `/opt/chirp/releases/<version>`에 푼 뒤 `/opt/chirp/current`를 원자적으로 바꾸고 `/health`를 기다린다.

- 데이터 디렉터리(`/var/lib/chirp`: API 키, 관리자 계정, 인스턴스 ID, 디스크 ID)는 건드리지 않으므로 Home Assistant 연동과 관리자 계정이 업데이트 후에도 유지된다. 계정 기능이 없던 릴리스에서 올리면 기존 API 키는 그대로 쓰이고, 업데이트 후 대시보드에서 관리자 계정을 만들면 된다.
- 확인 주소는 `/etc/chirp/chirp.env`의 `CHIRP_HOST`/`CHIRP_PORT`를 따르고(`0.0.0.0`/`::`이면 `127.0.0.1`, 그 외에는 설정한 주소), TLS가 설정되어 있으면 `https`를 선택하며, 루프백 인증서 허용을 위해 `curl -kfsS`를 쓴다.
- 헬스체크가 실패하면 이전 릴리스로 되돌린다. 첫 설치처럼 되돌릴 릴리스가 없으면 서비스를 멈추고 `current` 링크를 지워, 존재하지 않는 곳을 가리키는 링크를 남기지 않는다.

## 환경 변수

[`.env.example`](../../.env.example) 참고. 핵심: `CHIRP_HOST`(바인드 주소, 기본 `0.0.0.0`; 로컬 프록시 뒤일 때 `127.0.0.1`), `CHIRP_SETUP_TOKEN`(최초 관리자 등록용 일회용 설치 토큰; Proxmox 설치 시 자동 생성), `CHIRP_TLS_CERT` 및 `CHIRP_TLS_KEY`(자체 TLS 인증서 및 개인키 경로; 둘 다 지정하거나 둘 다 생략), `CHIRP_API_KEY`(우선, 16자 이상, 대시보드에서는 읽기 전용) / `CHIRP_API_KEY_FILE`, `CHIRP_PRINT_KEY`, `CHIRP_ADMIN_USER` + `CHIRP_ADMIN_PASSWORD`(관리자 시드), `CHIRP_COOKIE_SECURE`(`auto`/`true`/`false`), `CHIRP_DATA_DIR`, `CHIRP_DEVICES`, `CHIRP_DEVICE_TYPES`, `CHIRP_SCAN_MODE`, `CHIRP_RESCAN_INTERVAL`, `CHIRP_SMART_INTERVAL`, `CHIRP_SENSOR_INTERVAL`, `CHIRP_TEMP_WARN_{HDD,SSD,NVME}`, `CHIRP_SYSFS_ROOT`, `CHIRP_HOST_PROC`, `CHIRP_HOST_SYS`, `CHIRP_NET_INCLUDE`, `CHIRP_NET_EXCLUDE`, `CHIRP_WEB_DIR`, `CHIRP_TRUST_PROXY`(`false`, 프록시 IP/CIDR(권장), `1` 같은 프록시 개수, 또는 `true`; 보안 절 참고), `CHIRP_LOGIN_DAILY_BUDGET`(기본 1000), `CHIRP_CORS_ORIGINS`. 잘못된 값이면 `chirp: invalid configuration: CHIRP_PORT must be an integer between 1 and 65535 (got "80a")` 같은 메시지를 내고 서버가 시작하지 않는다.


호스트 경로:

| 변수 | 기본값 | 용도 |
|---|---|---|
| `CHIRP_SYSFS_ROOT` | `/sys` | hwmon(CPU 온도, 팬, 전압, hwmon 전력), RAPL powercap, sysfs 디스크 ID. 이 경로만 사용(대체 경로 없음) |
| `CHIRP_HOST_SYS` | `/host/sys`가 있으면 그것, 없으면 `/sys` | 네트워크 인터페이스(`/sys/class/net`). 먼저 읽고, 다음에 로컬 `/sys`(`scope`로 구분) |
| `CHIRP_HOST_PROC` | `/host/proc`가 있으면 그것, 없으면 `/proc` | `/proc/meminfo`, `/proc/stat`, `/proc/loadavg`(및 `1/net/dev`). 먼저 읽고, 다음에 로컬 `/proc` |

Proxmox LXC: 기본값 그대로 둔다(설치 스크립트가 `/host/proc`, `/host/sys`를 마운트). Docker: 호스트 `/sys`를 `/host/sys`에 마운트하고 `CHIRP_SYSFS_ROOT=/host/sys`로 두어 마운트 하나가 두 역할을 하게 하고, `/proc` 파일 3개를 `/host/proc` 아래에 마운트한다(Docker 예시 참고). 호스트 직접 설치에는 셋 다 필요 없다.

## 릴리스 절차

1. 루트·`packages/shared`·`apps/server`·`apps/web`의 `package.json` version을 모두 맞춘다(`release.yml`이 검사).
2. GitHub Release를 `v<version>` 태그로 publish.
3. `release.yml`이 태그·버전 일치를 검사하고 빌드·패키징·tarball 스모크 테스트 후 tarball + sha256을 업로드하고, `docker-release.yml`이 `ghcr.io/eigger/chirp`에 semver/latest를 푸시한다.

## 보안

- **최초 등록 창.** Proxmox 설치 스크립트를 사용한 경우, 최초 관리자 계정 생성에는 `/etc/chirp/chirp.env`(`0600`)에 기록된 일회용 `CHIRP_SETUP_TOKEN`이 필요하다. 관리자 계정이 생성되면 서버는 env 파일에서 토큰을 최선형으로 삭제하려 시도한다. systemd의 엄격한 샌드박스(`ProtectSystem=strict`)에서는 `/etc/chirp/chirp.env`가 읽기 전용이므로 파일에 토큰이 남을 수 있으나, 관리자 계정이 생성된 후에는 `POST /bootstrap/admin`이 409 conflict를 반환하므로 토큰은 무효화(inert)된다. 등록 전 토큰을 확인해야 할 경우 `pct exec <CTID> -- grep -E '^CHIRP_SETUP_TOKEN=' /etc/chirp/chirp.env`로 조회할 수 있다. `CHIRP_SETUP_TOKEN`이 설정되지 않은 경우(Docker, 수동 설치)에는 대시보드를 먼저 연 사람이 관리자를 만들 수 있다. 설치 직후 만들거나 `CHIRP_ADMIN_USER`/`CHIRP_ADMIN_PASSWORD`로 미리 만든다. 관리자가 없으면 서버가 시작할 때마다 로그에 경고한다.
- **TLS 및 전송 계층.** TLS가 없으면 로그인 시 관리자 비밀번호, 세션 쿠키, API 키가 네트워크에 평문으로 흐른다.
  - **자체 TLS:** `CHIRP_TLS_CERT` 및 `CHIRP_TLS_KEY`(인증서 및 개인키 경로)를 지정하면 Fastify가 HTTPS로 직접 서비스하며 `CHIRP_COOKIE_SECURE=true`를 기본값으로 파생한다. chirp 서버 안에서 인증서를 자동 발급하거나 갱신하지 않는다.
  - **역프록시 / Tailscale:** 실제 운영 환경에서는 chirp를 TLS 역프록시(Caddy, nginx, Traefik)나 Tailscale 뒤에 두는 것을 권장한다. chirp가 HTTPS 요청임을 알 수 없으면 `CHIRP_COOKIE_SECURE=true`로 쿠키의 `Secure`를 강제한다.
  - **바인드 제어:** `CHIRP_HOST`로 수신 주소를 제어할 수 있다(기본값 `0.0.0.0`). 같은 호스트의 로컬 역프록시 뒤에서 실행할 때는 `CHIRP_HOST=127.0.0.1`로 바인드한다.
- **역프록시 뒤라면 `CHIRP_TRUST_PROXY`를 설정한다.**
  - 설정하지 않으면 chirp는 모든 클라이언트를 프록시 주소로 본다. 그러면 로그인 지연이 모든 사용자를 한 출처로 취급해, 공격자 한 명의 실패가 모두를 최대 15분까지 기다리게 하고, "로그인한 적 있는 출처"가 곧 프록시 뒤의 누구나가 된다. 세션 쿠키에 `Secure`도 자동으로 붙지 않는다.
  - **권장:** 프록시 자신의 주소. 예: `CHIRP_TRUST_PROXY=10.0.0.5` 또는 `10.0.0.0/24,fd00::/64`. 그러면 요청이 실제로 프록시에서 올 때만 `X-Forwarded-For`/`-Proto`를 믿는다.
  - **프록시 개수**(`1`)나 `true`는 *어떤 상대*가 보낸 헤더든 믿는다. 그래서 chirp에 **프록시를 통해서만** 접근할 수 있을 때만 안전하다(프록시와 같은 호스트에서 `CHIRP_HOST=127.0.0.1`로 바인드하거나 방화벽으로 포트를 막는다). 아니면 직접 접속한 누구나 `X-Forwarded-For`를 위조해(요청마다 새 주소로 출처별 지연을 피함) `X-Forwarded-Proto`까지 속일 수 있다. `true`는 여기에 더해 프록시가 `X-Forwarded-For`를 *덮어쓰지* 않으면 안전하지 않다(nginx `proxy_set_header X-Forwarded-For $remote_addr;`). 와일드카드 바인드에서 프록시 개수나 `true`를 쓰면 chirp가 경고를 로그에 남긴다.
- **로그인 제한.** 출처(IPv4 주소 또는 IPv6 /64)마다 최대 15분까지 지연된다. 사용자명 지연은 최대 5초이며, 이미 실패했고 로그인한 적이 없는 출처에만 적용된다. 사용자명마다 24시간에 실패 시도 1000회까지 허용되고(`CHIRP_LOGIN_DAILY_BUDGET`), 소진되면 이전에 로그인한 적 있는 주소만 시도할 수 있다. 지속적인 공격은 새 주소의 로그인을 늦출 수 있고 예산이 소진되면 최대 24시간 막을 수 있지만, 이전에 로그인한 주소, 열려 있는 세션, Home Assistant, CLI에는 영향이 없다. 복구: `cli.js admin reset-password`(예산도 초기화) 또는 서비스 재시작. 상세: [`api.md`](../api.md#login-rate-limiting).
- **`CHIRP_ADMIN_PASSWORD`는 계정이 생긴 뒤에도 환경 변수에 평문으로 남는다**(`docker inspect`, compose 파일, `/proc/<pid>/environ`). 첫 기동 후 `CHIRP_ADMIN_USER`/`CHIRP_ADMIN_PASSWORD`를 지우고 대시보드(설정 -> 비밀번호 변경)에서 비밀번호를 바꾼다.
- **CLI는 서비스 설정을 읽는다.** `cli.js`는 `/etc/chirp/chirp.env`가 있으면 읽으므로(또는 `--env-file <경로>` / `CHIRP_ENV_FILE`), `pct exec <CTID> -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password`가 서비스와 같은 데이터 디렉터리를 쓴다.
- 세션: HttpOnly + SameSite=Strict 쿠키, 12시간 무활동 / 최대 7일, 메모리 보관(재시작하면 모두 로그아웃), 비밀번호를 바꾸면 모두 종료. 비밀번호는 10~256자이며 흔하거나 추측하기 쉬운 것은 거부된다.
- privileged 컨테이너 전제이며, 그 root는 사실상 호스트 root다(위 참고).
