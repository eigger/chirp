# chirp 배포 가이드

[English](../deploy.md)

## 요구 사항

- Linux 호스트(Proxmox VE 권장), Node.js 24, `smartmontools`
- 포트 80 (변경: `CHIRP_PORT`, 1~65535 정수)
- 호스트의 블록 장치·`/sys` 접근 권한

## 1. Proxmox 원클릭

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/eigger/chirp/master/proxmox/ct/chirp.sh)"
```

privileged LXC를 만들고 릴리스 tarball을 설치한 뒤, 선택한 디스크를 passthrough하고 대시보드 URL을 출력한다. 스크립트 상세는 `proxmox/` 참고.

**설치 직후 `http://<컨테이너 IP>/`를 열어 관리자 계정을 만든다**(사용자명, 비밀번호 2회 입력). 관리자가 생기기 전까지 대시보드는 접속한 *누구에게나* 이 최초 등록 화면을 보여 주므로 바로 만들어야 한다(또는 만들 때까지 컨테이너에 다른 사람이 접근하지 못하게 한다). 그다음 **설정 -> API 키**에서 키를 복사해 Home Assistant에 넣는다. 비밀번호를 잊으면 `pct exec <CTID> -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password`(새 무작위 비밀번호를 출력하고 모든 세션을 로그아웃).

### 디스크 passthrough와 권한

`proxmox/install/chirp-passthrough.sh`(호스트에서 실행, 디스크를 추가/교체한 뒤 다시 실행)는 선택한 디스크의 `/dev/disk/by-id/...` 노드를 컨테이너에 bind mount하고, 장치 major마다 cgroup 규칙을 하나씩 추가한다.

```
lxc.cgroup2.devices.allow: b 8:* rw
lxc.mount.entry: /dev/disk/by-id/wwn-0x5000c500a1b2c3d4 dev/disk/by-id/wwn-0x5000c500a1b2c3d4 none bind,optional,create=file
```

- **`rwm`이 아니라 `rw`.** 디스크는 bind mount되므로 컨테이너가 `mknod`를 할 필요가 없다. smartctl은 SG_IO를 위해 SCSI/SAT 장치를 읽기·쓰기로 열기 때문에 `r`만으로는 부족하다. `CHIRP_DEV_PERM`으로 덮어쓸 수 있다(예: `CHIRP_DEV_PERM=rwm`).
- **정확한 `major:minor`가 아니라 major 와일드카드(`8:*`).** `sd`의 minor는 장치 인식 순서를 따르고 NVMe 네임스페이스(major 259)의 minor는 동적으로 배정되므로, 정확한 minor 규칙은 호스트 재부팅이나 핫플러그 후 엉뚱한 디스크를 가리키거나 아무것도 가리키지 않게 된다. by-id bind mount는 컨테이너가 시작할 때마다 다시 해석되지만 정적 cgroup 규칙은 그렇지 않고, Proxmox에는 컨테이너 시작 전에 이 규칙을 다시 쓸 수 있는 훅이 없다.
- **위험:** 컨테이너 root는 같은 major의 다른 블록 장치(호스트 부트 디스크도 `sd*`/NVMe라면 포함)에 접근할 수 있다. privileged 컨테이너의 root는 이미 사실상 호스트 root이므로 위험이 더 커지지는 않지만, 신뢰하는 네트워크에 두고 다른 서비스를 함께 돌리지 말 것.

## 2. Docker

```bash
docker run -d --name chirp \
  --privileged -p 80:80 \
  -v /sys:/sys:ro -v chirp-data:/var/lib/chirp \
  --device /dev/sda --device /dev/nvme0 \
  -e CHIRP_DEVICES=/dev/sda,/dev/nvme0 \
  ghcr.io/eigger/chirp:latest
```

- **관리자 계정:** 처음 시작한 직후 `http://<호스트>/`를 열어 만든다(그 전까지는 포트에 접근할 수 있는 누구나 만들 수 있다). 자동화 환경이면 `-e CHIRP_ADMIN_USER=admin -e CHIRP_ADMIN_PASSWORD=<10자 이상>`을 추가한다. 관리자가 없을 때만 시작 시 계정을 만들며, 이후에는 무시되어 바꾼 비밀번호를 덮어쓰지 않는다. 재설정: `docker exec chirp node apps/server/dist/cli.js admin reset-password`.
- **`CHIRP_ADMIN_PASSWORD`는 계정이 생긴 뒤에도** `docker inspect`와 compose 파일에 그대로 보인다. 첫 기동 후 두 변수를 지우고 대시보드에서 비밀번호를 바꾼다.
- `--privileged` 대신 `--cap-add SYS_RAWIO --cap-add SYS_ADMIN` + `--device` 조합 가능.
- `/sys`를 읽기 전용으로 마운트해야 호스트 CPU 센서(hwmon)가 보인다. 디스크를 깨우지 않고 sysfs에서 안정적인 디스크 ID를 도출하는 데도 쓰인다.
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
- 확인 주소는 `/etc/chirp/chirp.env`의 `CHIRP_HOST`/`CHIRP_PORT`를 따른다(`0.0.0.0`/`::`이면 `127.0.0.1`, 그 외에는 설정한 주소).
- 헬스체크가 실패하면 이전 릴리스로 되돌린다. 첫 설치처럼 되돌릴 릴리스가 없으면 서비스를 멈추고 `current` 링크를 지워, 존재하지 않는 곳을 가리키는 링크를 남기지 않는다.

## 환경 변수

[`.env.example`](../../.env.example) 참고. 핵심: `CHIRP_API_KEY`(우선, 16자 이상, 대시보드에서는 읽기 전용) / `CHIRP_API_KEY_FILE`, `CHIRP_PRINT_KEY`, `CHIRP_ADMIN_USER` + `CHIRP_ADMIN_PASSWORD`(관리자 시드), `CHIRP_COOKIE_SECURE`(`auto`/`true`/`false`), `CHIRP_DATA_DIR`, `CHIRP_DEVICES`, `CHIRP_DEVICE_TYPES`, `CHIRP_SCAN_MODE`, `CHIRP_RESCAN_INTERVAL`, `CHIRP_SMART_INTERVAL`, `CHIRP_SENSOR_INTERVAL`, `CHIRP_TEMP_WARN_{HDD,SSD,NVME}`, `CHIRP_WEB_DIR`, `CHIRP_TRUST_PROXY`(`false`, 프록시 IP/CIDR(권장), `1` 같은 프록시 개수, 또는 `true`; 보안 절 참고), `CHIRP_LOGIN_DAILY_BUDGET`(기본 1000), `CHIRP_CORS_ORIGINS`. 잘못된 값이면 `chirp: invalid configuration: CHIRP_PORT must be an integer between 1 and 65535 (got "80a")` 같은 메시지를 내고 서버가 시작하지 않는다.

## 릴리스 절차

1. 루트·`packages/shared`·`apps/server`·`apps/web`의 `package.json` version을 모두 맞춘다(`release.yml`이 검사).
2. GitHub Release를 `v<version>` 태그로 publish.
3. `release.yml`이 태그·버전 일치를 검사하고 빌드·패키징·tarball 스모크 테스트 후 tarball + sha256을 업로드하고, `docker-release.yml`이 `ghcr.io/eigger/chirp`에 semver/latest를 푸시한다.

## 보안

- **최초 등록 창.** 관리자 계정이 생기기 전까지는 대시보드를 먼저 연 사람이 관리자를 만들 수 있다. 설치 직후 만들거나 `CHIRP_ADMIN_USER`/`CHIRP_ADMIN_PASSWORD`로 미리 만든다. 관리자가 없으면 서버가 시작할 때마다 로그에 경고한다.
- **HTTP 평문이면 자격 증명이 노출된다.** TLS가 없으면 로그인 시 관리자 비밀번호, 세션 쿠키, API 키가 네트워크에 평문으로 흐른다. 신뢰하는 LAN이 아니라면 TLS 역프록시(Caddy, nginx, Traefik)나 Tailscale 뒤에 둔다. chirp가 HTTPS 요청임을 알 수 없으면 `CHIRP_COOKIE_SECURE=true`로 쿠키의 `Secure`를 강제한다.
- **역프록시 뒤라면 `CHIRP_TRUST_PROXY`를 설정한다.**
  - 설정하지 않으면 chirp는 모든 클라이언트를 프록시 주소로 본다. 그러면 로그인 지연이 모든 사용자를 한 출처로 취급해, 공격자 한 명의 실패가 모두를 최대 15분까지 기다리게 하고, "로그인한 적 있는 출처"가 곧 프록시 뒤의 누구나가 된다. 세션 쿠키에 `Secure`도 자동으로 붙지 않는다.
  - **권장:** 프록시 자신의 주소. 예: `CHIRP_TRUST_PROXY=10.0.0.5` 또는 `10.0.0.0/24,fd00::/64`. 그러면 요청이 실제로 프록시에서 올 때만 `X-Forwarded-For`/`-Proto`를 믿는다.
  - **프록시 개수**(`1`)나 `true`는 *어떤 상대*가 보낸 헤더든 믿는다. 그래서 chirp에 **프록시를 통해서만** 접근할 수 있을 때만 안전하다(프록시와 같은 호스트에서 `CHIRP_HOST=127.0.0.1`로 바인드하거나 방화벽으로 포트를 막는다). 아니면 직접 접속한 누구나 `X-Forwarded-For`를 위조해(요청마다 새 주소로 출처별 지연을 피함) `X-Forwarded-Proto`까지 속일 수 있다. `true`는 여기에 더해 프록시가 `X-Forwarded-For`를 *덮어쓰지* 않으면 안전하지 않다(nginx `proxy_set_header X-Forwarded-For $remote_addr;`). 와일드카드 바인드에서 프록시 개수나 `true`를 쓰면 chirp가 경고를 로그에 남긴다.
- **로그인 제한.** 출처(IPv4 주소 또는 IPv6 /64)마다 최대 15분까지 지연된다. 사용자명 지연은 최대 5초이며, 이미 실패했고 로그인한 적이 없는 출처에만 적용된다. 사용자명마다 24시간에 실패 시도 1000회까지 허용되고(`CHIRP_LOGIN_DAILY_BUDGET`), 소진되면 이전에 로그인한 적 있는 주소만 시도할 수 있다. 지속적인 공격은 새 주소의 로그인을 늦출 수 있고 예산이 소진되면 최대 24시간 막을 수 있지만, 이전에 로그인한 주소, 열려 있는 세션, Home Assistant, CLI에는 영향이 없다. 복구: `cli.js admin reset-password`(예산도 초기화) 또는 서비스 재시작. 상세: [`api.md`](../api.md#login-rate-limiting).
- **`CHIRP_ADMIN_PASSWORD`는 계정이 생긴 뒤에도 환경 변수에 평문으로 남는다**(`docker inspect`, compose 파일, `/proc/<pid>/environ`). 첫 기동 후 `CHIRP_ADMIN_USER`/`CHIRP_ADMIN_PASSWORD`를 지우고 대시보드(설정 -> 비밀번호 변경)에서 비밀번호를 바꾼다.
- **CLI는 서비스 설정을 읽는다.** `cli.js`는 `/etc/chirp/chirp.env`가 있으면 읽으므로(또는 `--env-file <경로>` / `CHIRP_ENV_FILE`), `pct exec <CTID> -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password`가 서비스와 같은 데이터 디렉터리를 쓴다.
- 세션: HttpOnly + SameSite=Strict 쿠키, 12시간 무활동 / 최대 7일, 메모리 보관(재시작하면 모두 로그아웃), 비밀번호를 바꾸면 모두 종료. 비밀번호는 10~256자이며 흔하거나 추측하기 쉬운 것은 거부된다.
- privileged 컨테이너 전제이며, 그 root는 사실상 호스트 root다(위 참고).
