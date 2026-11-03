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

privileged LXC를 만들고 릴리스 tarball을 설치한 뒤, 선택한 디스크를 passthrough하고 대시보드 URL과 API 키(컨테이너 안에서 `cli.js key show`로 조회)를 출력한다. 스크립트 상세는 `proxmox/` 참고.

### 디스크 passthrough와 권한

`proxmox/install/chirp-passthrough.sh`(호스트에서 실행, 디스크를 추가/교체한 뒤 다시 실행)는 선택한 디스크의 `/dev/disk/by-id/...` 노드를 컨테이너에 bind mount하고, 장치 major마다 cgroup 규칙을 하나씩 추가한다.

```
lxc.cgroup2.devices.allow: b 8:* rw
lxc.mount.entry: /dev/disk/by-id/wwn-0x5000c500a1b2c3d4 dev/disk/by-id/wwn-0x5000c500a1b2c3d4 none bind,optional,create=file
```

- **`rwm`이 아니라 `rw`.** 디스크는 bind mount되므로 컨테이너가 `mknod`를 할 필요가 없다. smartctl은 SG_IO를 위해 SCSI/SAT 장치를 읽기·쓰기로 열기 때문에 `r`만으로는 부족하다. `CHIRP_DEV_PERM`으로 덮어쓸 수 있다(예: `CHIRP_DEV_PERM=rwm`).
- **정확한 `major:minor`가 아니라 major 와일드카드(`8:*`).** `sd`의 minor는 장치 인식 순서를 따르고 NVMe 네임스페이스(major 259)의 minor는 동적으로 배정되므로, 정확한 minor 규칙은 호스트 재부팅이나 핫플러그 후 엉뚱한 디스크를 가리키거나 아무것도 가리키지 않게 된다. by-id bind mount는 컨테이너가 시작할 때마다 다시 해석되지만 정적 cgroup 규칙은 그렇지 않고, Proxmox에는 컨테이너 시작 전에 이 규칙을 다시 쓸 수 있는 훅이 없다.
- **위험:** 컨테이너 root는 같은 major의 다른 블록 장치(호스트 부트 디스크도 `sd*`/NVMe라면 포함)에 접근할 수 있다. privileged 컨테이너의 root는 이미 사실상 호스트 root이므로 위험이 더 커지지는 않지만, 신뢰하는 네트워크에 두고 다른 서비스를 함께 돌리지 말 것.

### 호스트 메트릭(메모리·부하·네트워크)

컨테이너 안의 `/proc/meminfo`, `/proc/stat`, `/proc/loadavg`는 lxcfs가 보여 주는 컨테이너 관점 값일 수 있고(예: 호스트 64GB 대신 512MB), 네트워크 네임스페이스에는 컨테이너의 `eth0`만 있다. 그래서 같은 스크립트가 마커 블록에 호스트 파일의 읽기 전용 마운트도 쓴다. `CHIRP_HOST_MOUNTS`로 고른다.

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

기존 설치에 마운트를 추가하거나 모드를 바꾸려면 스크립트를 다시 실행한다(예: `CHIRP_HOST_MOUNTS=proc CHIRP_DISKS=<현재 디스크> bash -c "$(curl ...)" _ <CTID>`). 블록은 다시 쓰일 뿐 중복되지 않는다. **재실행 시 디스크 선택은 기존 선택을 대체한다.** 체크리스트에서는 유지할 디스크를 모두 고르고, 비대화식으로는 이전과 같은 `CHIRP_DISKS`를 준다(터미널 없이 실행하면 기본값이 `all`이고, `none`은 passthrough된 디스크를 모두 제거한다).

chirp은 `/host/proc`, `/host/sys`를 먼저 읽고 `scope: "host"`로 보고한다. 없으면 컨테이너 자신의 파일로 대체하고 `scope: "container"`로 보고하며, 대시보드에는 "컨테이너 관점 — 호스트 마운트 없음"이 표시된다. `optional`이므로 마운트가 실패해도 컨테이너는 정상 시작한다. `/proc/net`은 읽는 프로세스의 네트워크 네임스페이스를 따르므로 `/proc/net/dev`는 일부러 마운트하지 않는다.

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
  -v /sys:/sys:ro -v chirp-data:/var/lib/chirp \
  -v /proc/meminfo:/host/proc/meminfo:ro -v /proc/stat:/host/proc/stat:ro \
  -v /proc/loadavg:/host/proc/loadavg:ro -v /sys:/host/sys:ro \
  --device /dev/sda --device /dev/nvme0 \
  -e CHIRP_DEVICES=/dev/sda,/dev/nvme0 \
  ghcr.io/eigger/chirp:latest
```

- `--privileged` 대신 `--cap-add SYS_RAWIO --cap-add SYS_ADMIN` + `--device` 조합 가능.
- `/sys`를 읽기 전용으로 마운트해야 호스트 CPU 센서(hwmon)가 보인다. 디스크를 깨우지 않고 sysfs에서 안정적인 디스크 ID를 도출하는 데도 쓰인다.
- `/proc` 파일 3개 마운트로 호스트의 메모리·부하를 `scope: "host"`로 보고한다(필요한 것은 이 파일들뿐이다. `/proc` 전체를 `/host/proc`에 마운트해도 동작하며, 그 경우 네트워크 카운터는 PID 1의 `/host/proc/1/net/dev`에서 읽는다). `-v /sys:/host/sys:ro`는 호스트 네트워크 인터페이스를 준다(컨테이너 자신의 `/sys/class/net`은 자기 네트워크 네임스페이스만 보인다). 위 `all`과 같은 주의 사항이 있다(호스트 sysfs 전체가 읽기 전용으로 privileged 컨테이너에 보임). 네트워크 섹션이 필요 없으면 빼거나, `--network host`로 실행한다. 이 경우 컨테이너가 이미 호스트 인터페이스를 보지만 chirp은 구분할 수 없어 `scope: "container"`로 보고한다. `/proc` 마운트가 없으면 메모리·부하는 `scope: "container"`(Docker는 `/proc/meminfo`를 가상화하지 않으므로 값 자체는 대개 호스트와 같다).
- `chirp-data` 볼륨에 API 키(`api-key`), `instance-id`, `disk-ids.json`(고정된 디스크 ID)이 저장된다. 볼륨을 잃으면 키·인스턴스 ID가 바뀌어 Home Assistant 엔티티가 새로 생긴다.
- **API 키:** 컨테이너 로그에는 출력되지 않는다. 다음으로 확인한다.
  `docker exec chirp node apps/server/dist/cli.js key show`
  (로그에 꼭 남기고 싶다면 한 번만 `-e CHIRP_PRINT_KEY=true`로 시작)
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

- 확인 주소는 `/etc/chirp/chirp.env`의 `CHIRP_HOST`/`CHIRP_PORT`를 따른다(`0.0.0.0`/`::`이면 `127.0.0.1`, 그 외에는 설정한 주소).
- 헬스체크가 실패하면 이전 릴리스로 되돌린다. 첫 설치처럼 되돌릴 릴리스가 없으면 서비스를 멈추고 `current` 링크를 지워, 존재하지 않는 곳을 가리키는 링크를 남기지 않는다.

## 환경 변수

[`.env.example`](../../.env.example) 참고. 핵심: `CHIRP_API_KEY`(우선, 16자 이상) / `CHIRP_API_KEY_FILE`, `CHIRP_PRINT_KEY`, `CHIRP_DATA_DIR`, `CHIRP_DEVICES`, `CHIRP_DEVICE_TYPES`, `CHIRP_SCAN_MODE`, `CHIRP_RESCAN_INTERVAL`, `CHIRP_SMART_INTERVAL`, `CHIRP_SENSOR_INTERVAL`, `CHIRP_TEMP_WARN_{HDD,SSD,NVME}`, `CHIRP_HOST_PROC`, `CHIRP_HOST_SYS`, `CHIRP_NET_INCLUDE`, `CHIRP_NET_EXCLUDE`, `CHIRP_WEB_DIR`, `CHIRP_TRUST_PROXY`, `CHIRP_CORS_ORIGINS`. 잘못된 값이면 `chirp: invalid configuration: CHIRP_PORT must be an integer between 1 and 65535 (got "80a")` 같은 메시지를 내고 서버가 시작하지 않는다.

## 릴리스 절차

1. 루트·`packages/shared`·`apps/server`·`apps/web`의 `package.json` version을 모두 맞춘다(`release.yml`이 검사).
2. GitHub Release를 `v<version>` 태그로 publish.
3. `release.yml`이 태그·버전 일치를 검사하고 빌드·패키징·tarball 스모크 테스트 후 tarball + sha256을 업로드하고, `docker-release.yml`이 `ghcr.io/eigger/chirp`에 semver/latest를 푸시한다.

## 보안

HTTP 평문 + privileged 컨테이너 전제. 신뢰하지 않는 네트워크에서는 TLS 역프록시/Tailscale 뒤에 둘 것.
